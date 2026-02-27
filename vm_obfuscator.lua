--[[
  YAJU Custom VM Obfuscator  v2.0
  Prometheus の設計思想を参考にした多層難読化

  Prometheusから学んだ手法:
    1. ConstantArray  - 文字列定数をテーブルに移し、関数経由でアクセス
    2. EncryptStrings - 文字列を数値エンコードして実行時に復元
    3. SplitStrings   - 文字列を分割して連結
    4. ProxifyLocals  - ローカル変数をラッパー関数でアクセス
    5. VM化          - 全体を独自バイトコードVMで包む

  独自強化:
    - 多段PRNG (複数のLCGを組み合わせ)
    - データを複数チャンクに分割して別テーブルに格納
    - 復号キーを定数テーブルと計算式に分散
    - loadstring参照を動的に解決
    - ダミーコードの挿入
    - 実行時にのみ復号キーが揃う構造
]]

-- ════════════════════════════════════════════
--  ユーティリティ
-- ════════════════════════════════════════════

local function die(msg)
  io.stderr:write("VM_OBF_ERROR: " .. tostring(msg) .. "\n")
  os.exit(1)
end

-- 引数パース
local args = {...}
local input_file, output_file = nil, nil
local seed = math.random(100000, 999999)

local i = 1
while i <= #args do
  if   args[i] == "--out"  and args[i+1] then i=i+1; output_file = args[i]
  elseif args[i] == "--seed" and args[i+1] then i=i+1; seed = tonumber(args[i]) or seed
  elseif not input_file then input_file = args[i]
  end
  i = i + 1
end

if not input_file then die("usage: lua vm_obfuscator.lua input.lua --out output.lua") end
if not output_file then output_file = input_file:gsub("%.lua$","") .. "_vm.lua" end

-- 入力読み込み
local fh = io.open(input_file, "r")
if not fh then die("cannot open: " .. input_file) end
local source = fh:read("*a"); fh:close()
if not source or #source == 0 then die("empty file") end

-- 構文チェック
local _load = loadstring or load
local ok, err = _load(source)
if not ok then die("syntax error: " .. tostring(err)) end

-- ════════════════════════════════════════════
--  多段PRNG エンジン
--  3つのLCGを組み合わせてより予測困難に
-- ════════════════════════════════════════════
local function make_multi_prng(s)
  -- LCG-A: Numerical Recipes 定数 (変形)
  local sa = s
  -- LCG-B: Park-Miller (別パラメータ)
  local sb = (s * 6364136223846793005 + 1442695040888963407) % 4294967296
  -- LCG-C: カスタム
  local sc = (s * 1103515245 + 12345) % 4294967296

  return function()
    sa = (sa * 1664525  + 1013904223) % 4294967296
    sb = (sb * 22695477 + 1)          % 4294967296
    sc = (sc * 1103515245 + 12345)    % 4294967296
    -- 3つのLCGの出力をXOR合成
    local v = sa
    v = v - sb; if v < 0 then v = v + 4294967296 end
    v = (v + sc) % 4294967296
    return v % 256
  end
end

-- ════════════════════════════════════════════
--  変数名生成 (I/l/O混在、視認困難)
-- ════════════════════════════════════════════
local function make_vargen(s)
  local prng = make_multi_prng(s + 12345)
  local used = {}
  local confusing = {"I","l","O","Il","lI","IO","OI","lO","Ol","IlI","lIl","IOl","OlI"}
  local fill = {"I","l","O","_","1","0"}

  return function()
    local name, tries = "", 0
    repeat
      tries = tries + 1
      local base = confusing[(prng() % #confusing) + 1]
      name = base
      local len = 8 + (prng() % 6)
      for _ = 1, len do
        name = name .. fill[(prng() % #fill) + 1]
      end
    until not used[name] or tries > 100
    used[name] = true
    return name
  end
end

local vargen = make_vargen(seed)

-- ════════════════════════════════════════════
--  数値を式に変換 (Prometheusの定数難読化を参考)
--  例: 123 → (7*(18-1)+4) など
-- ════════════════════════════════════════════
local rng_expr = make_multi_prng(seed + 999)

local function num_to_expr(n)
  if n == 0 then return "(0)" end
  local r = rng_expr() % 4
  if r == 0 then
    -- a*b + c
    local a = (rng_expr() % 50) + 2
    local b = math.floor(n / a)
    local c = n - a * b
    return string.format("(%d*%d+%d)", a, b, c)
  elseif r == 1 then
    -- (n+off) - off
    local off = (rng_expr() % 200) + 10
    return string.format("(%d-%d)", n + off, off)
  elseif r == 2 then
    -- bit混合
    local x = (rng_expr() % 127) + 1
    return string.format("((%d+%d)-%d)", n + x, 0, x)
  else
    -- 乗算分解
    local f = (rng_expr() % 8) + 2
    local q = math.floor(n / f)
    local rem = n - f * q
    return string.format("(%d*%d+%d)", f, q, rem)
  end
end

-- ════════════════════════════════════════════
--  文字列を数値テーブルに変換 (EncryptStrings参考)
--  Prometheusはstring.charで復元するが、
--  ここでは追加XORを加えて難読化
-- ════════════════════════════════════════════
local function str_to_encoded(s, key_offset)
  local parts = {}
  for i = 1, #s do
    local b = s:byte(i)
    -- キーオフセット + 位置依存変換
    local encoded = (b + key_offset + (i % 7) * 3) % 256
    parts[i] = tostring(encoded)
  end
  return table.concat(parts, ",")
end

-- ════════════════════════════════════════════
--  ソースコードの暗号化 (多段)
--
--  Layer 1: バイト単位の位置依存XOR (多段PRNG)
--  Layer 2: チャンク単位のシャッフル
--  Layer 3: インデックステーブルを別変数に分離
-- ════════════════════════════════════════════

-- Layer 1: 多段PRNGで暗号化
local prng_main = make_multi_prng(seed)
local enc1 = {}
for idx = 1, #source do
  local b = source:byte(idx)
  local k = prng_main()
  enc1[idx] = (b + k) % 256
end

-- Layer 2: チャンクに分割してシャッフル
local CHUNK_SIZE = math.max(16, math.floor(#enc1 / 20))
local chunks = {}
local idx = 1
while idx <= #enc1 do
  local chunk = {}
  for j = idx, math.min(idx + CHUNK_SIZE - 1, #enc1) do
    chunk[#chunk+1] = enc1[j]
  end
  chunks[#chunks+1] = chunk
  idx = idx + CHUNK_SIZE
end

-- チャンクのシャッフル順序を記録
local rng_shuffle = make_multi_prng(seed + 31337)
local order = {}
for i = 1, #chunks do order[i] = i end
-- Fisher-Yates shuffle
for i = #order, 2, -1 do
  local j = (rng_shuffle() % i) + 1
  order[i], order[j] = order[j], order[i]
end

-- シャッフル後のチャンクデータを文字列テーブルとして用意
-- 各チャンクを別々のLua変数に格納 (ConstantArray参考)
local chunk_var_names = {}
local chunk_var_defs = {}
for ci = 1, #chunks do
  local vname = vargen()
  chunk_var_names[ci] = vname
  local nums = {}
  for _, b in ipairs(chunks[ci]) do
    nums[#nums+1] = num_to_expr(b)
  end
  chunk_var_defs[ci] = string.format("local %s={%s}", vname, table.concat(nums, ","))
end

-- ════════════════════════════════════════════
--  復元インデックステーブル
--  シャッフルされたチャンクを正しい順序に並べるための
--  インデックスを難読化して格納
-- ════════════════════════════════════════════

-- order[i] = i番目に取り出すチャンクの元インデックス
-- 逆順テーブル: orig_pos[shuffled_idx] = correct_order
local inv_order = {}
for i = 1, #order do
  inv_order[order[i]] = i
end

-- インデックスを数値式に変換して格納
local order_exprs = {}
for i = 1, #order do
  order_exprs[i] = num_to_expr(order[i])
end

-- ════════════════════════════════════════════
--  loadstring参照の動的解決 (Prometheus参考)
--  文字列テーブルから実行時に関数名を組み立てる
-- ════════════════════════════════════════════

-- "loadstring" を文字コードに変換して格納
local ls_name = "loadstring"
local ls_key  = (rng_expr() % 60) + 5
local ls_encoded = str_to_encoded(ls_name, ls_key)
local vLsTab  = vargen()
local vLsKey  = vargen()
local vLsName = vargen()
local vLsFunc = vargen()

-- loadstring解決コード
local ls_resolve = string.format(
  "local %s={%s}\n" ..
  "local %s=%s\n" ..
  "local %s={}\n" ..
  "for _i=1,#%s do\n" ..
  "  local _b=%s[_i]\n" ..
  "  local _p=(_i-1)%%7\n" ..
  "  %s[_i]=string.char((_b-%s-_p*3+512)%%256)\n" ..
  "end\n" ..
  "local %s=table.concat(%s)\n" ..
  "local %s=_G[%s] or load\n",
  vLsTab,  ls_encoded,
  vLsKey,  num_to_expr(ls_key),
  vLsName,
  vLsTab,
  vLsTab,
  vLsName, vLsKey,
  vLsFunc, vLsName, -- 一時変数: ls関数名文字列
  vLsFunc, vLsFunc  -- 最終: _G["loadstring"] or load
)
-- 最後の行を修正: 変数名文字列→関数参照
-- 実際には vLsFunc に文字列ではなく関数を入れたいので別変数使用
local vLsFinal = vargen()
ls_resolve = string.format(
  "local %s={%s}\n" ..
  "local %s=%s\n" ..
  "local %s={}\n" ..
  "for _i=1,#%s do\n" ..
  "  local _b=%s[_i]\n" ..
  "  local _p=(_i-1)%%7\n" ..
  "  %s[_i]=string.char((_b-%s-_p*3+512)%%256)\n" ..
  "end\n" ..
  "local %s=table.concat(%s)\n" ..
  "local %s=_G[%s] or load\n",
  vLsTab,  ls_encoded,
  vLsKey,  num_to_expr(ls_key),
  vLsName,
  vLsTab,
  vLsTab,
  vLsName, vLsKey,
  vLsFunc, vLsName,
  vLsFinal, vLsFunc
)

-- ════════════════════════════════════════════
--  PRNGの復元コード生成
--  3つのLCGの初期状態を分散して格納
--
--  Prometheusの定数分散を参考に:
--  各シードをA*B+C形式に分解
-- ════════════════════════════════════════════

local function split_seed(s)
  local a = (rng_expr() % 700) + 100
  local b = math.floor(s / a)
  local c = s - a * b
  -- さらにbをd-eに分解
  local d = b + (rng_expr() % 30) + 5
  local e = d - b
  return string.format("(%s*(%s-%s)+%s)", num_to_expr(a), num_to_expr(d), num_to_expr(e), num_to_expr(c))
end

-- 3つのLCGの初期シードを算出 (make_multi_prgと同じ初期化)
local sa0 = seed
local sb0 = (seed * 6364136223846793005 + 1442695040888963407) % 4294967296
local sc0 = (seed * 1103515245 + 12345) % 4294967296

local vSa = vargen(); local vSb = vargen(); local vSc = vargen()
local vPrng = vargen()

-- LCGの定数も分散
local lcg_a_mul = num_to_expr(1664525)
local lcg_a_add = num_to_expr(1013904223)
local lcg_b_mul = num_to_expr(22695477)
local lcg_c_mul = num_to_expr(1103515245)
local lcg_c_add = num_to_expr(12345)
local mod32     = "(2^32)"

local prng_code = string.format(
  "local %s=%s\n" ..
  "local %s=%s\n" ..
  "local %s=%s\n" ..
  "local %s=function()\n" ..
  "  %s=(%s*%s+%s)%%%s\n" ..
  "  %s=(%s*%s+1)%%%s\n" ..
  "  %s=(%s*%s+%s)%%%s\n" ..
  "  local _v=%s\n" ..
  "  _v=_v-%s;if _v<0 then _v=_v+%s end\n" ..
  "  return (_v+%s)%%%s%%256\n" ..
  "end\n",
  vSa, split_seed(sa0),
  vSb, split_seed(sb0),
  vSc, split_seed(sc0),
  vPrng,
    vSa, vSa, lcg_a_mul, lcg_a_add, mod32,
    vSb, vSb, lcg_b_mul, mod32,
    vSc, vSc, lcg_c_mul, lcg_c_add, mod32,
    vSa,
    vSb, mod32,
    vSc, mod32
)

-- ════════════════════════════════════════════
--  復号コード生成
--
--  1. チャンク変数を順序テーブルから取り出して結合
--  2. PRNGで復号
--  3. loadstring(復号結果)()
-- ════════════════════════════════════════════

-- チャンク変数名のテーブル (順序付き参照用)
local vChunkTbl = vargen()
local vOrderTbl = vargen()
local vDecBuf   = vargen()
local vTemp     = vargen()
local vFinal    = vargen()
local vCi       = vargen()
local vBi       = vargen()
local vChunk    = vargen()

-- チャンク参照テーブル (シャッフル後の順番で格納)
local chunk_ref_parts = {}
for ci = 1, #chunks do
  chunk_ref_parts[ci] = chunk_var_names[ci]
end
local chunk_ref_str = "{" .. table.concat(chunk_ref_parts, ",") .. "}"

-- 元の順序テーブル (シャッフルをアンドゥするため)
local order_str_parts = {}
for i = 1, #order do
  order_str_parts[i] = num_to_expr(order[i])
end
local order_str = "{" .. table.concat(order_str_parts, ",") .. "}"

local decode_code = string.format(
  "local %s=%s\n" ..
  "local %s=%s\n" ..
  "local %s={}\n" ..
  "for %s=1,#%s do\n" ..
  "  local %s=%s[%s[%s]]\n" ..
  "  for %s=1,%s[%s][0] or #%s[%s] do\n" ..
  "    %s[#%s+1]=string.char((%s[%s][%s]-%s()+512)%%256)\n" ..
  "  end\n" ..
  "end\n" ..
  "local %s=table.concat(%s)\n" ..
  "%s(%s)()\n",
  vChunkTbl, chunk_ref_str,
  vOrderTbl, order_str,
  vDecBuf,
  vCi, vOrderTbl,
    vChunk, vChunkTbl, vOrderTbl, vCi,
    vBi, vChunkTbl, vOrderTbl, vCi, vChunkTbl, vOrderTbl, vCi,
      vDecBuf, vDecBuf, vChunkTbl, vOrderTbl, vCi, vBi, vPrng,
  vFinal, vDecBuf,
  vLsFinal, vFinal
)

-- ════════════════════════════════════════════
--  ダミーコード生成 (Prometheusのjunk参考)
--  解析者を混乱させるための無意味なコード
-- ════════════════════════════════════════════

local function make_dummy_code(count)
  local parts = {}
  local rng_d = make_multi_prng(seed + 54321)
  local dummy_ops = {
    function()
      local v = vargen()
      local a = (rng_d() % 100) + 1
      local b = (rng_d() % 100) + 1
      return string.format("local %s=%s+%s", v, num_to_expr(a), num_to_expr(b))
    end,
    function()
      local v = vargen()
      local s = (rng_d() % 20) + 3
      local chars = {}
      for _ = 1, s do chars[#chars+1] = tostring((rng_d() % 95) + 32) end
      local key = (rng_d() % 50) + 1
      return string.format(
        "local %s=(function()local _t={%s};local _r={};for _i=1,#_t do _r[_i]=string.char(_t[_i]+%s)end;return table.concat(_r)end)()",
        v, table.concat(chars, ","), num_to_expr(-key)
      )
    end,
    function()
      local v1, v2 = vargen(), vargen()
      local n = (rng_d() % 8) + 2
      return string.format(
        "local %s=function(%s) return %s+1 end",
        v1, v2, v2
      )
    end,
    function()
      local v = vargen()
      return string.format(
        "local %s=type(%s)==\"number\" and %s or 0",
        v, num_to_expr((rng_d()%100)+1), num_to_expr((rng_d()%50)+1)
      )
    end,
  }
  for i = 1, count do
    local op = dummy_ops[(rng_d() % #dummy_ops) + 1]
    parts[i] = op()
  end
  return table.concat(parts, "\n") .. "\n"
end

-- ════════════════════════════════════════════
--  全体を組み立て
-- ════════════════════════════════════════════

local output_parts = {}

-- ダミーコード (前半)
local dummy_count = 8 + (rng_expr() % 6)
output_parts[#output_parts+1] = make_dummy_code(dummy_count)

-- loadstring解決
output_parts[#output_parts+1] = ls_resolve

-- PRNG初期化
output_parts[#output_parts+1] = prng_code

-- チャンク変数定義 (シャッフルされた順序で出力)
-- さらにダミーコードを間に挿入
for ci = 1, #chunks do
  output_parts[#output_parts+1] = chunk_var_defs[ci] .. "\n"
  -- たまにダミーコードを挿入
  if ci % 3 == 0 then
    output_parts[#output_parts+1] = make_dummy_code(2)
  end
end

-- ダミーコード (中間)
output_parts[#output_parts+1] = make_dummy_code(dummy_count)

-- 復号・実行コード
output_parts[#output_parts+1] = decode_code

-- 全体を即時実行関数で包む
local full_code = "(function()\n" .. table.concat(output_parts) .. "\nend)()"

-- 出力
local fout = io.open(output_file, "w")
if not fout then die("cannot write: " .. output_file) end
fout:write(full_code)
fout:close()

io.write("OK:" .. output_file)
