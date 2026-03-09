// vm/vmhook/logParser.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const safeEnvPreamble = `
-- ══ YAJU SafeEnv v4 ══

-- math.random を常に0返しに固定 (ランダム性除去でデコード安定化)
pcall(function()
  math.random = function() return 0 end
  math.randomseed = function() end
end)

-- os.* を固定値/無効化
pcall(function()
  os.exit    = function() end
  os.execute = function() return false, "disabled", -1 end
  os.date    = function() return "2025" end
  os.time    = function() return 1700000000 end
  os.clock   = function() return 0 end
end)

-- bit32 互換レイヤー (未定義環境向け)
if not bit32 then
  bit32 = {
    bnot  = function(x) return -x end,
    band  = function(a,b) local r=0;for i=0,31 do if math.floor(a/2^i)%2==1 and math.floor(b/2^i)%2==1 then r=r+2^i end end;return r end,
    bor   = function(a,b) local r=0;for i=0,31 do if math.floor(a/2^i)%2==1 or math.floor(b/2^i)%2==1 then r=r+2^i end end;return r end,
    bxor  = function(a,b) local r=0;for i=0,31 do if math.floor(a/2^i)%2~=math.floor(b/2^i)%2 then r=r+2^i end end;return r end,
    lshift= function(a,b) return math.floor(a*(2^b))%4294967296 end,
    rshift= function(a,b) return math.floor(a/(2^b)) end,
  }
end

-- io.* 危険関数を無効化
pcall(function()
  io.popen = function() return nil, "disabled" end
end)

-- debug.* を無効化
pcall(function()
  if debug then
    debug.sethook  = function() end
    debug.getinfo  = nil
    debug.getlocal = nil; debug.setlocal   = nil
    debug.getupvalue= nil; debug.setupvalue = nil
    debug.getmetatable = nil; debug.setmetatable = nil
  end
end)

-- require を制限 (ネットワーク/FFI ライブラリを禁止)
local __orig_require = require
pcall(function()
  require = function(m)
    local blocked = {socket=1, ffi=1, jit=1, ["io.popen"]=1}
    if blocked[tostring(m)] then error("require blocked: "..tostring(m)) end
    return __orig_require(m)
  end
end)

-- ──────────────────────────────────────────────────────
-- [1] string.char フック
--   VM bytecode テーブルが string.char(n1,n2,...) で文字列化される
--   パターンを捕捉して __STRCHAR__ マーカーでログ出力する
-- ──────────────────────────────────────────────────────
local __orig_string_char = string.char
local __strchar_log = {}
local __strchar_count = 0
local __strchar_max   = 500   -- 最大500件キャプチャ

string.char = function(...)
  local result = __orig_string_char(...)
  if type(result) == "string" and #result > 3 then
    __strchar_count = __strchar_count + 1
    if __strchar_count <= __strchar_max then
      -- bytecodeらしい長さ (4バイト以上) のみ記録
      __strchar_log[__strchar_count] = result
    end
  end
  return result
end
-- string.char 自体のグローバルも上書き
pcall(function() rawset(_G, "string", string) end)

-- ──────────────────────────────────────────────────────
-- [1] table.concat フック
--   ① デコードステージ出力 (Lua コード復元用)
--   ② VM bytecode テーブル結合のキャプチャ
-- ──────────────────────────────────────────────────────
local __orig_table_concat = table.concat
local __tconcat_log   = {}
local __tconcat_count = 0
local __tconcat_max   = 500

table.concat = function(t, sep, ...)
  local r = __orig_table_concat(t, sep, ...)
  if type(r) == "string" and #r > 10 then
    -- デコードステージ出力
    io.write("\\n__DECODE_STAGE__\\n")
    io.write(r)
    io.write("\\n__DECODE_STAGE_END__\\n")
    io.flush()
    -- VM bytecode 候補として記録 (バイナリっぽい短い結果も含む)
    __tconcat_count = __tconcat_count + 1
    if __tconcat_count <= __tconcat_max then
      __tconcat_log[__tconcat_count] = r
    end
  end
  return r
end

-- pcall フック — エラー文字列を PCALL として出力
local __orig_pcall = pcall
pcall = function(f, ...)
  local ok, r = __orig_pcall(f, ...)
  if type(r) == "string" and #r > 0 then
    io.write("\\n__PCALL__\\n")
    io.write(tostring(r))
    io.write("\\n__PCALL_END__\\n")
    io.flush()
  end
  return ok, r
end

-- 暴走防止: デバッグフックで命令数を制限 (500000命令)
local __safe_ops = 0
local __safe_max = 500000
pcall(function()
  if debug and debug.sethook then
    debug.sethook(function()
      __safe_ops = __safe_ops + 1
      if __safe_ops > __safe_max then
        debug.sethook()
        error("__SAFE_TIMEOUT__", 0)
      end
    end, "", 1000)
  end
end)
-- ══ SafeEnv End ══
`;

// ────────────────────────────────────────────────────────────────────────
//  #6/#7/#8  hookLoadstringCode 強化版 — 全パターンをフック
// ────────────────────────────────────────────────────────────────────────

const hookLoadstringCode = `
-- ══ YAJU hookLoadstring v4 ══
-- [6] __original_loadstring は必ず loadstring or load から取得
local __original_loadstring = loadstring or load
local __decoded_count = 0
local __decoded_best_len = 0

-- [1][2][3][6] loadstring / load 共通フック関数
-- capture条件: #code_str > 10 (短いLuaコードもキャプチャ) [2]
local function __hookLoadstring(code_str, name, mode, env)
  if type(code_str) == "string" and #code_str > 10 then
    __decoded_count = __decoded_count + 1
    -- __DECODED__ マーカーで出力
    io.write("\\n__DECODED_START_" .. tostring(__decoded_count) .. "__\\n")
    io.write(code_str)
    io.write("\\n__DECODED_END_" .. tostring(__decoded_count) .. "__\\n")
    -- LOAD_STAGE としても補助出力
    io.write("\\n__LOAD_STAGE__\\n")
    io.write(code_str)
    io.write("\\n__LOAD_STAGE_END__\\n")
    io.flush()
    if #code_str > __decoded_best_len then
      __decoded_best_len = #code_str
    end
  end
  -- [6] 元の関数に委譲 (__original_loadstring を直接呼ぶ)
  local f, err
  if env ~= nil and __original_loadstring ~= __hookLoadstring then
    f, err = __original_loadstring(code_str, name, mode, env)
  else
    f, err = __original_loadstring(code_str)
  end
  if f then return f end
  return nil, err
end

-- [1][7] _G への代入 + loadstring / load への直接代入を両方行う
-- rawset だけに依存しない
_G.loadstring = __hookLoadstring
_G.load       = __hookLoadstring
loadstring    = __hookLoadstring
load          = __hookLoadstring
if rawset then
  pcall(function() rawset(_G, "loadstring", __hookLoadstring) end)
  pcall(function() rawset(_G, "load",       __hookLoadstring) end)
end
-- ══ hookLoadstring End ══
`;

// ────────────────────────────────────────────────────────────────────────
//  #9/#10  parseDecodedOutputs 強化版 — scoreLuaCodeフィルター付き
// ────────────────────────────────────────────────────────────────────────

const vmHookBootstrap = `
-- ══ YAJU VM Hook Bootstrap v6 (Weredev専用) ══
-- Weredev VM変数規約:
--   B   = bytecodeテーブル (instructions配列)
--   V   = レジスタテーブル  (0-indexed)
--   pc  = program counter
--   l   = 現在のopcode (local l = B[pc])
--   m   = string accessor関数 (定数プール lookup)

-- ── 共通カウンタ・テーブル ────────────────────────────────────────────
__vm_logs      = {}
__vm_log_count = 0
__vm_max_logs  = 5000

-- [1] trace テーブル: {i, pc, l, A, B, C, regs}
__vmtrace       = {}
__vmtrace_count = 0
__vmtrace_max   = 10000

-- [3] m() ストリングログ: {i, idx, val}
__strlog       = {}
__strlog_count = 0
__strlog_max   = 2000

-- [2] B/V プリダンプ用テーブル
__bdump        = nil   -- B テーブルのスナップショット
__vdump        = nil   -- V テーブルのスナップショット

-- ── [1] __vmtrace_hook: while dispatch ループ内から呼ぶ ──────────────
-- injectVmHook が "local l = B[pc]" の直後に以下を注入する:
--   __vmtrace_hook(pc, l, l and l[2], l and l[3], l and l[4])
-- またはスカラーopcode形式の場合:
--   __vmtrace_hook(pc, l, nil, nil, nil)
function __vmtrace_hook(pc, l, A, B_op, C)
  if __vmtrace_count >= __vmtrace_max then return end
  __vmtrace_count = __vmtrace_count + 1
  -- レジスタスナップショット V[0..7]
  local regs = {}
  if type(V) == "table" then
    for ri = 0, 7 do
      local rv = rawget(V, ri)
      if rv ~= nil then
        if type(rv) == "number" then regs[ri] = rv
        elseif type(rv) == "string" then regs[ri] = rv:sub(1, 40)
        elseif type(rv) == "boolean" then regs[ri] = rv
        else regs[ri] = type(rv) end
      end
    end
  end
  -- trace[#trace+1] = {opcode=l, A, B, C, regs}
  __vmtrace[__vmtrace_count] = {
    i    = __vmtrace_count,
    pc   = pc   or 0,
    l    = l,
    A    = A,
    B    = B_op,
    C    = C,
    regs = regs,
  }
end

-- ── 旧 __vmhook (互換維持) ────────────────────────────────────────────
function __vmhook(ip, inst, stack, reg)
  if __vm_log_count >= __vm_max_logs then return end
  __vm_log_count = __vm_log_count + 1
  local entry = { ip = ip, ts = __vm_log_count }
  if type(inst) == "table" then
    entry.op = inst[1]; entry.arg1 = inst[2]
    entry.arg2 = inst[3]; entry.arg3 = inst[4]
    __vmtrace_hook(ip, inst[1], inst[2], inst[3], inst[4])
  elseif type(inst) == "number" then
    entry.op = inst
    __vmtrace_hook(ip, inst, nil, nil, nil)
  end
  table.insert(__vm_logs, entry)
end

-- ── [2] B テーブル プリダンプ ─────────────────────────────────────────
-- injectVmHook が "local B = ..." の直後に __dump_B(B) を注入する
function __dump_B(tbl)
  if type(tbl) ~= "table" or #tbl == 0 then return end
  if __bdump then return end  -- 初回のみキャプチャ
  local lines = {}
  for i = 1, #tbl do
    local v = tbl[i]
    if type(v) == "table" then
      lines[#lines+1] = tostring(i).."\\t"..tostring(v[1] or "nil").."\\t"
        ..tostring(v[2] or "nil").."\\t"..tostring(v[3] or "nil").."\\t"..tostring(v[4] or "nil")
    elseif type(v) == "number" then
      lines[#lines+1] = tostring(i).."\\t"..tostring(v).."\\tnil\\tnil\\tnil"
    end
  end
  __bdump = lines
end

-- ── [2] V テーブル プリダンプ ─────────────────────────────────────────
-- injectVmHook が "local V = ..." の直後に __dump_V(V) を注入する
function __dump_V(tbl)
  if type(tbl) ~= "table" then return end
  if __vdump then return end
  local lines = {}
  for k, v in pairs(tbl) do
    if type(k) == "number" then
      local vs
      if type(v) == "number" then vs = tostring(v)
      elseif type(v) == "string" then vs = "S:"..v:sub(1, 64)
      elseif type(v) == "boolean" then vs = tostring(v)
      else vs = type(v) end
      lines[#lines+1] = tostring(k).."\\t"..vs
    end
  end
  __vdump = lines
end

-- ── [3] __wrap_m: m(index) string accessor hook ───────────────────────
-- injectVmHook が "local m = ..." の直後に m = __wrap_m(m) を注入する
function __wrap_m(orig_m)
  if type(orig_m) ~= "function" then return orig_m end
  return function(idx)
    local result = orig_m(idx)
    if __strlog_count < __strlog_max then
      __strlog_count = __strlog_count + 1
      __strlog[__strlog_count] = {
        i   = __strlog_count,
        idx = idx,
        val = type(result) == "string" and result or tostring(result),
      }
    end
    return result
  end
end
-- ══ Bootstrap End ══
`;

// ────────────────────────────────────────────────────────────────────────
//  #28  vmDumpFooter — __VMLOG__ 形式で stdout に出力
// ────────────────────────────────────────────────────────────────────────
const vmDumpFooter = `
-- ══ YAJU VM Dump Footer v6 (Weredev専用) ══

-- ── string.char キャプチャログ ────────────────────────────────────────
if __strchar_count and __strchar_count > 0 then
  io.write("\\n__STRCHAR_START__\\n")
  for i = 1, math.min(__strchar_count, __strchar_max or 500) do
    local s = __strchar_log[i]
    if s then
      local bytes = {}
      for j = 1, #s do bytes[j] = tostring(s:byte(j)) end
      io.write(tostring(i).."\\t"..(#s).."\\t"..table.concat(bytes,",").."\\n")
    end
  end
  io.write("__STRCHAR_END__\\t"..tostring(__strchar_count).."\\n")
  io.flush()
end

-- ── table.concat キャプチャログ ──────────────────────────────────────
if __tconcat_count and __tconcat_count > 0 then
  io.write("\\n__TCONCAT_START__\\n")
  for i = 1, math.min(__tconcat_count, __tconcat_max or 500) do
    local s = __tconcat_log[i]
    if s then
      local bytes = {}
      for j = 1, #s do bytes[j] = tostring(s:byte(j)) end
      io.write(tostring(i).."\\t"..(#s).."\\t"..table.concat(bytes,",").."\\n")
    end
  end
  io.write("__TCONCAT_END__\\t"..tostring(__tconcat_count).."\\n")
  io.flush()
end

-- ── [2] B テーブル (bytecode) JSON ダンプ ─────────────────────────────
-- __dump_B() が injectVmHook により "local B=..." の直後に呼ばれ
-- __bdump にライン配列が格納されている
if __bdump and #__bdump > 0 then
  io.write("\\n__BTABLE_START__\\n")
  for _, line in ipairs(__bdump) do
    io.write(line.."\\n")
  end
  io.write("__BTABLE_END__\\t"..tostring(#__bdump).."\\n")
  io.flush()
end

-- フォールバック: __bdump が nil でも B がグローバルに残っていればダンプ
if not __bdump and type(B) == "table" and #B > 0 then
  io.write("\\n__BTABLE_START__\\n")
  for i = 1, #B do
    local v = B[i]
    if type(v) == "table" then
      io.write(tostring(i).."\\t"..tostring(v[1] or "nil").."\\t"
        ..tostring(v[2] or "nil").."\\t"..tostring(v[3] or "nil").."\\t"..tostring(v[4] or "nil").."\\n")
    elseif type(v) == "number" then
      io.write(tostring(i).."\\t"..tostring(v).."\\tnil\\tnil\\tnil\\n")
    end
  end
  io.write("__BTABLE_END__\\t"..tostring(#B).."\\n")
  io.flush()
end

-- ── [2] V テーブル (レジスタ) JSON ダンプ ────────────────────────────
if __vdump and #__vdump > 0 then
  io.write("\\n__VTABLE_START__\\n")
  for _, line in ipairs(__vdump) do io.write(line.."\\n") end
  io.write("__VTABLE_END__\\t"..tostring(#__vdump).."\\n")
  io.flush()
end

-- ── [3] m() string accessor ログ出力 ─────────────────────────────────
if __strlog_count and __strlog_count > 0 then
  io.write("\\n__STRLOG_START__\\n")
  for i = 1, __strlog_count do
    local e = __strlog[i]
    if e then
      local vs = tostring(e.val or ""):gsub("\\n","\\\\n"):gsub("\\t","\\\\t")
      io.write(tostring(i).."\\t"..tostring(e.idx).."\\t"..vs.."\\n")
    end
  end
  io.write("__STRLOG_END__\\t"..tostring(__strlog_count).."\\n")
  io.flush()
end

-- ── 旧 __VMLOG__ (互換) ───────────────────────────────────────────────
if __vm_log_count and __vm_log_count > 0 then
  for i, v in ipairs(__vm_logs) do
    local op   = tostring(v.op   or "nil")
    local arg1 = tostring(v.arg1 or "nil")
    local arg2 = tostring(v.arg2 or "nil")
    local arg3 = tostring(v.arg3 or "nil")
    print("__VMLOG__\\t"..tostring(v.ip).."\\t"..op.."\\t"..arg1.."\\t"..arg2.."\\t"..arg3)
  end
  print("__VMLOG_END__\\t"..tostring(__vm_log_count))
end

-- ── [1] __VMTRACE_START__ / __VMTRACE_END__ ───────────────────────────
-- フォーマット: idx \\t pc \\t l(opcode) \\t A \\t B \\t C \\t regs(k=v,...)
if __vmtrace_count and __vmtrace_count > 0 then
  io.write("\\n__VMTRACE_START__\\n")
  for i = 1, __vmtrace_count do
    local v = __vmtrace[i]
    if v then
      local pc_s = tostring(v.pc or 0)
      local l_s  = tostring(v.l  or "nil")
      local a_s  = tostring(v.A  or "nil")
      local b_s  = tostring(v.B  or "nil")
      local c_s  = tostring(v.C  or "nil")
      local regs_s = "nil"
      if type(v.regs) == "table" then
        local parts = {}
        for rk, rv in pairs(v.regs) do
          parts[#parts+1] = tostring(rk).."="..tostring(rv)
        end
        if #parts > 0 then regs_s = table.concat(parts, ",") end
      end
      io.write(tostring(i).."\\t"..pc_s.."\\t"..l_s.."\\t"..a_s.."\\t"..b_s.."\\t"..c_s.."\\t"..regs_s.."\\n")
    end
  end
  io.write("__VMTRACE_END__\\t"..tostring(__vmtrace_count).."\\n")
  io.flush()
end
-- ══ Dump End ══
`;

// ────────────────────────────────────────────────────────────────────────
//  #24/#30/#31/#32/#33  injectVmHook 強化版
//  — WereDev/MoonSec/Luraph それぞれに対応した注入
// ────────────────────────────────────────────────────────────────────────

function injectVmHook(code, vmInfo) {
  let modified = code;
  let injectedTrace = false;
  let injectedBDump = false;
  let injectedVDump = false;
  let injectedMHook = false;
  const type_ = vmInfo || {};

  // ══ [2] B テーブル プリダンプ注入 ══════════════════════════════════════
  // "local B = ..." の直後に __dump_B(B) を挿入
  // Weredev は "local B={...}" または "local B=proto.code" などの形式
  modified = modified.replace(
    /(local\s+B\s*=\s*[^\n]+\n)/g,
    (match) => {
      if (injectedBDump) return match;
      injectedBDump = true;
      return match + '  __dump_B(B)\n';
    }
  );

  // ══ [2] V テーブル プリダンプ注入 ══════════════════════════════════════
  // "local V = ..." の直後に __dump_V(V) を挿入
  modified = modified.replace(
    /(local\s+V\s*=\s*[^\n]+\n)/g,
    (match) => {
      if (injectedVDump) return match;
      injectedVDump = true;
      return match + '  __dump_V(V)\n';
    }
  );

  // ══ [3] m() string accessor フック注入 ═════════════════════════════════
  // "local m = ..." の直後に m = __wrap_m(m) を挿入
  modified = modified.replace(
    /(local\s+m\s*=\s*[^\n]+\n)/g,
    (match) => {
      if (injectedMHook) return match;
      injectedMHook = true;
      return match + '  m = __wrap_m(m)\n';
    }
  );

  // ══ [1] while dispatch ループ内 opcode(l) trace 注入 ═══════════════════
  // パターン A (Weredev 最頻出):
  //   local l = B[pc]
  //   → 直後に __vmtrace_hook(pc, l, l and l[2], l and l[3], l and l[4])
  modified = modified.replace(
    /(local\s+l\s*=\s*B\s*\[\s*pc\s*\][^\n]*\n)/g,
    (match) => {
      injectedTrace = true;
      return match
        + '  __vmtrace_hook(pc, type(l)=="table" and l[1] or l,'
        + ' type(l)=="table" and l[2] or nil,'
        + ' type(l)=="table" and l[3] or nil,'
        + ' type(l)=="table" and l[4] or nil)\n';
    }
  );

  // パターン B: Weredev スカラーopcode形式
  //   local l = B[pc][1]  または  local opcode = B[pc]
  if (!injectedTrace) {
    modified = modified.replace(
      /(local\s+(?:l|opcode)\s*=\s*B\s*\[\s*pc\s*\]\s*\[\s*1\s*\][^\n]*\n)/g,
      (match) => {
        injectedTrace = true;
        return match + '  __vmtrace_hook(pc, l or opcode, nil, nil, nil)\n';
      }
    );
  }

  // パターン C: 旧来の inst = bytecode[ip] 形式 (Weredev旧版 / 互換)
  if (!injectedTrace || type_.isWereDev) {
    modified = modified.replace(
      /(local\s+inst\s*=\s*bytecode\s*\[\s*ip\s*\][^\n]*\n)/g,
      (match) => {
        injectedTrace = true;
        return match
          + '  __vmtrace_hook(ip, inst and inst[1], inst and inst[2],'
          + ' inst and inst[3], inst and inst[4])\n'
          + '  __vmhook(ip, inst)\n';
      }
    );
  }

  // パターン D: MoonSec — dispatch[opcode](
  if (!injectedTrace || type_.isMoonSec) {
    modified = modified.replace(
      /(dispatch\s*\[\s*opcode\s*\]\s*\()/g,
      (match) => {
        injectedTrace = true;
        return `__vmtrace_hook(ip, opcode, nil, nil, nil); __vmhook(ip, opcode); ` + match;
      }
    );
    modified = modified.replace(
      /(dispatch\s*\[\s*inst\s*\[\s*1\s*\]\s*\]\s*\()/g,
      (match) => {
        injectedTrace = true;
        return `__vmtrace_hook(ip, inst and inst[1], inst and inst[2], inst and inst[3], inst and inst[4]); __vmhook(ip, inst); ` + match;
      }
    );
  }

  // パターン E: Luraph
  if (type_.isLuraph) {
    modified = modified.replace(/\bLPH_GetEnv\s*\(/g, (m) => {
      injectedTrace = true;
      return `__vmtrace_hook(0, "LPH_GetEnv", nil, nil, nil); __vmhook(0, "LPH_GetEnv"); ` + m;
    });
    modified = modified.replace(/\bLPH_String\s*\(/g, (m) => {
      injectedTrace = true;
      return `__vmtrace_hook(0, "LPH_String", nil, nil, nil); __vmhook(0, "LPH_String"); ` + m;
    });
  }

  // パターン F: 汎用 while true do ループ先頭 (フォールバック)
  modified = modified.replace(
    /(while\s+true\s+do\s*\n)/g,
    (match) => {
      injectedTrace = true;
      // l が存在すれば l、なければ inst or opcode を使う
      return match
        + '  if __vmtrace_hook then\n'
        + '    __vmtrace_hook(pc or ip or 0,'
        + ' type(l)=="table" and l[1] or l or (inst and inst[1]) or opcode,'
        + ' type(l)=="table" and l[2] or (inst and inst[2]),'
        + ' type(l)=="table" and l[3] or (inst and inst[3]),'
        + ' type(l)=="table" and l[4] or (inst and inst[4]))\n'
        + '  end\n';
    }
  );

  // パターン G: 汎用フォールバック local opcode =
  if (!injectedTrace) {
    modified = modified.replace(
      /(local\s+opcode\s*=\s*[^\n]+\n)/g,
      (match) => {
        injectedTrace = true;
        return match + '  __vmtrace_hook(ip, opcode, nil, nil, nil)\n  __vmhook(ip, opcode)\n';
      }
    );
  }

  const injected = injectedTrace || injectedBDump || injectedVDump || injectedMHook;
  return {
    code: modified, injected,
    injectedTrace, injectedBDump, injectedVDump, injectedMHook,
  };
}

// ────────────────────────────────────────────────────────────────────────
//  runLuaWithHooks  (#26: vmHookBootstrap を先頭に注入)
// ────────────────────────────────────────────────────────────────────────
function runLuaWithHooks(code) {
  return vmHookBootstrap + '\n' + code + '\n' + vmDumpFooter;
}


// ════════════════════════════════════════════════════════════════════════
//  BLOCK 3: VMログ解析 / 逆コンパイラ (#34-#54)
// ════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
//  #34/#35  parseVmLogs 強化版 — split("\t") で構造化
// ────────────────────────────────────────────────────────────────────────
function parseDecodedOutputs(stdout) {
  const results = [];

  // __DECODED_START_N__ / __DECODED_END_N__ マーカー
  const re = /__DECODED_START_(\d+)__\n([\s\S]*?)\n__DECODED_END_\1__/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    const idx  = parseInt(m[1]);
    const code = m[2];
    if (!code || code.length < 5) continue;
    const score = scoreLuaCode(code);
    if (score > 15) results.push({ idx, code, score });
  }

  // __DECODE_STAGE__ (table.concat フック)
  const reStage = /__DECODE_STAGE__\n([\s\S]*?)\n__DECODE_STAGE_END__/g;
  let idxStage = 1000;
  while ((m = reStage.exec(stdout)) !== null) {
    const code = m[1];
    if (!code || code.length < 5) continue;
    const score = scoreLuaCode(code);
    if (score > 15) results.push({ idx: idxStage++, code, score, source: 'decode_stage' });
  }

  // __LOAD_STAGE__ (load/loadstring 補助フック)
  const reLoad = /__LOAD_STAGE__\n([\s\S]*?)\n__LOAD_STAGE_END__/g;
  let idxLoad = 2000;
  while ((m = reLoad.exec(stdout)) !== null) {
    const code = m[1];
    if (!code || code.length < 5) continue;
    const score = scoreLuaCode(code);
    if (score > 15) results.push({ idx: idxLoad++, code, score, source: 'load_stage' });
  }

  // __PCALL__ (pcall フック — エラー文字列にLuaコードが含まれる場合)
  const rePcall = /__PCALL__\n([\s\S]*?)\n__PCALL_END__/g;
  let idxPcall = 3000;
  while ((m = rePcall.exec(stdout)) !== null) {
    const code = m[1];
    if (!code || code.length < 5) continue;
    const score = scoreLuaCode(code);
    if (score > 15) results.push({ idx: idxPcall++, code, score, source: 'pcall' });
  }

  // スコア順 (高い順) にソート → 最高スコアを best に
  results.sort((a, b) => b.score - a.score);
  // 重複除去 (同一コードを1件に)
  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.code.substring(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const best = unique[0] || null;
  return { all: unique, best: best ? best.code : null };
}



// ════════════════════════════════════════════════════════════════════════
//  YAJU Deobfuscator Engine v3
//  全20項目実装版
// ════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
//  #19  seenCodeCache  — SHA1ハッシュによる重複解析防止
// ────────────────────────────────────────────────────────────────────────
function parseVmLogs(stdout) {
  const vmTrace = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('__VMLOG__')) continue;
    // split("\t") で ip opcode arg1 arg2 を構造化
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const ip   = parseInt(parts[1]) || 0;
    const op   = parts[2] !== 'nil' ? (isNaN(Number(parts[2])) ? parts[2] : parseInt(parts[2])) : null;
    const arg1 = parts[3] !== undefined && parts[3] !== 'nil'
      ? (isNaN(Number(parts[3])) ? parts[3] : parseInt(parts[3])) : null;
    const arg2 = parts[4] !== undefined && parts[4] !== 'nil'
      ? (isNaN(Number(parts[4])) ? parts[4] : parseInt(parts[4])) : null;
    const arg3 = parts[5] !== undefined && parts[5] !== 'nil'
      ? (isNaN(Number(parts[5])) ? parts[5] : parseInt(parts[5])) : null;
    vmTrace.push({ ip, op, arg1, arg2, arg3 });
  }
  return vmTrace;
}

// ────────────────────────────────────────────────────────────────────────
//  parseVmTrace v6 — __VMTRACE_START__ / __VMTRACE_END__
//  フォーマット: idx \t pc \t l(opcode) \t A \t B \t C \t regs(k=v,...)
// ────────────────────────────────────────────────────────────────────────
function parseVmTrace(stdout) {
  if (!stdout) return { entries: [], count: 0, found: false };

  const startMarker = '__VMTRACE_START__';
  const endMarker   = '__VMTRACE_END__';
  const startIdx = stdout.indexOf(startMarker);
  const endIdx   = stdout.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx)
    return { entries: [], count: 0, found: false };

  const rawBlock = stdout.substring(startIdx + startMarker.length, endIdx).trim();
  if (!rawBlock) return { entries: [], count: 0, found: false };

  const toVal = (s) => {
    if (s === undefined || s === 'nil' || s === '') return null;
    const n = Number(s);
    return isNaN(n) ? s : n;
  };

  const entries = [];
  for (const line of rawBlock.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // idx \t pc \t l \t A \t B \t C \t regs
    const p = t.split('\t');
    if (p.length < 3) continue;
    const idx  = parseInt(p[0]) || 0;
    const pc   = toVal(p[1]);
    const l    = toVal(p[2]);   // opcode
    const A    = toVal(p[3]);
    const B    = toVal(p[4]);
    const C    = toVal(p[5]);
    // regs: "0=val,1=val,..." → オブジェクト
    const regs = {};
    if (p[6] && p[6] !== 'nil') {
      for (const kv of p[6].split(',')) {
        const eq = kv.indexOf('=');
        if (eq !== -1) {
          const k = parseInt(kv.substring(0, eq));
          const v = toVal(kv.substring(eq + 1));
          if (!isNaN(k)) regs[k] = v;
        }
      }
    }
    // 互換用に ip/op/a/b/c も設定
    entries.push({ idx, pc, l, A, B, C, regs, ip: pc, op: l, a: A, b: B, c: C });
  }

  const endLine = stdout.substring(endIdx, stdout.indexOf('\n', endIdx) + 1);
  const countMatch = endLine.match(/__VMTRACE_END__\t(\d+)/);
  return { entries, count: countMatch ? parseInt(countMatch[1]) : entries.length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  [2] parseBTableLog — __BTABLE_START__ / __BTABLE_END__
//  Weredev B テーブル (bytecode instructions) をパース
//  フォーマット: idx \t opcode \t A \t B \t C
// ────────────────────────────────────────────────────────────────────────
function parseBTableLog(stdout) {
  if (!stdout) return { instructions: [], count: 0, found: false };
  const si = stdout.indexOf('__BTABLE_START__');
  const ei = stdout.indexOf('__BTABLE_END__');
  if (si === -1 || ei === -1 || ei <= si) return { instructions: [], count: 0, found: false };

  const raw = stdout.substring(si + '__BTABLE_START__'.length, ei).trim();
  const instructions = [];
  const toV = (s) => (s === undefined || s === 'nil') ? null : (isNaN(Number(s)) ? s : Number(s));

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('\t');
    if (p.length < 2) continue;
    instructions.push({
      idx: parseInt(p[0]) || 0,
      op:  toV(p[1]),
      A:   toV(p[2]),
      B:   toV(p[3]),
      C:   toV(p[4]),
    });
  }
  const endLine = stdout.substring(ei, stdout.indexOf('\n', ei) + 1);
  const cm = endLine.match(/__BTABLE_END__\t(\d+)/);
  return { instructions, count: cm ? parseInt(cm[1]) : instructions.length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  [2] parseVTableLog — __VTABLE_START__ / __VTABLE_END__
//  Weredev V テーブル (registers) 初期状態をパース
//  フォーマット: reg_idx \t value
// ────────────────────────────────────────────────────────────────────────
function parseVTableLog(stdout) {
  if (!stdout) return { registers: {}, count: 0, found: false };
  const si = stdout.indexOf('__VTABLE_START__');
  const ei = stdout.indexOf('__VTABLE_END__');
  if (si === -1 || ei === -1 || ei <= si) return { registers: {}, count: 0, found: false };

  const raw = stdout.substring(si + '__VTABLE_START__'.length, ei).trim();
  const registers = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('\t');
    if (p.length < 2) continue;
    const k = parseInt(p[0]);
    if (!isNaN(k)) {
      const v = p[1];
      registers[k] = v.startsWith('S:') ? v.substring(2) : (isNaN(Number(v)) ? v : Number(v));
    }
  }
  const endLine = stdout.substring(ei, stdout.indexOf('\n', ei) + 1);
  const cm = endLine.match(/__VTABLE_END__\t(\d+)/);
  return { registers, count: cm ? parseInt(cm[1]) : Object.keys(registers).length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  [3] parseStrLog — __STRLOG_START__ / __STRLOG_END__
//  m(index) string accessor でアクセスされた文字列ログをパース
//  フォーマット: idx \t key_index \t value
// ────────────────────────────────────────────────────────────────────────
function parseStrLog(stdout) {
  if (!stdout) return { entries: [], count: 0, found: false };
  const si = stdout.indexOf('__STRLOG_START__');
  const ei = stdout.indexOf('__STRLOG_END__');
  if (si === -1 || ei === -1 || ei <= si) return { entries: [], count: 0, found: false };

  const raw = stdout.substring(si + '__STRLOG_START__'.length, ei).trim();
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('\t');
    if (p.length < 3) continue;
    entries.push({
      i:   parseInt(p[0]) || 0,
      idx: isNaN(Number(p[1])) ? p[1] : Number(p[1]),
      val: p[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
    });
  }
  const endLine = stdout.substring(ei, stdout.indexOf('\n', ei) + 1);
  const cm = endLine.match(/__STRLOG_END__\t(\d+)/);
  return { entries, count: cm ? parseInt(cm[1]) : entries.length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  [1] parseStrCharLog — __STRCHAR_START__ / __STRCHAR_END__ を解析して
//      string.char でキャプチャされた VM bytecode バイト列を取得する
// ────────────────────────────────────────────────────────────────────────
function parseStrCharLog(stdout) {
  if (!stdout) return { entries: [], count: 0, found: false };
  const startIdx = stdout.indexOf('__STRCHAR_START__');
  const endIdx   = stdout.indexOf('__STRCHAR_END__');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx)
    return { entries: [], count: 0, found: false };

  const raw = stdout.substring(startIdx + '__STRCHAR_START__'.length, endIdx).trim();
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // フォーマット: idx \t len \t b0,b1,b2,...
    const parts = t.split('\t');
    if (parts.length < 3) continue;
    const idx  = parseInt(parts[0]) || 0;
    const len  = parseInt(parts[1]) || 0;
    const bytes = parts[2].split(',').map(n => parseInt(n)).filter(n => !isNaN(n));
    // バイト列を文字列に復元
    const str = bytes.map(b => String.fromCharCode(b)).join('');
    entries.push({ idx, len, bytes, str });
  }
  const countLine = stdout.substring(endIdx, stdout.indexOf('\n', endIdx));
  const countMatch = countLine.match(/__STRCHAR_END__\t(\d+)/);
  return { entries, count: countMatch ? parseInt(countMatch[1]) : entries.length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  [1] parseTConcatLog — __TCONCAT_START__ / __TCONCAT_END__ を解析して
//      table.concat でキャプチャされた VM bytecode 結合文字列を取得する
// ────────────────────────────────────────────────────────────────────────
function parseTConcatLog(stdout) {
  if (!stdout) return { entries: [], count: 0, found: false };
  const startIdx = stdout.indexOf('__TCONCAT_START__');
  const endIdx   = stdout.indexOf('__TCONCAT_END__');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx)
    return { entries: [], count: 0, found: false };

  const raw = stdout.substring(startIdx + '__TCONCAT_START__'.length, endIdx).trim();
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split('\t');
    if (parts.length < 3) continue;
    const idx   = parseInt(parts[0]) || 0;
    const len   = parseInt(parts[1]) || 0;
    const bytes = parts[2].split(',').map(n => parseInt(n)).filter(n => !isNaN(n));
    const str   = bytes.map(b => String.fromCharCode(b)).join('');
    entries.push({ idx, len, bytes, str });
  }
  const countLine = stdout.substring(endIdx, stdout.indexOf('\n', endIdx));
  const countMatch = countLine.match(/__TCONCAT_END__\t(\d+)/);
  return { entries, count: countMatch ? parseInt(countMatch[1]) : entries.length, found: true };
}

// ────────────────────────────────────────────────────────────────────────
//  #36  saveVmTrace — vmトレースをJSONとして保存
// ────────────────────────────────────────────────────────────────────────
function saveVmTrace(vmTrace, suffix) {
  if (!vmTrace || vmTrace.length === 0) return null;
  try {
    const fname = path.join(tempDir, `vm_trace_${suffix || Date.now()}.json`);
    fs.writeFileSync(fname, JSON.stringify(vmTrace, null, 2), 'utf8');
    return fname;
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────
//  #37/#38/#39  vmTraceAnalyzer 強化版 — dispatch table推定 + 挙動推定
// ────────────────────────────────────────────────────────────────────────
function parseBytecodeDump(stdout) {
  const bytecodeDump = {};
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('__BYTECODE__')) continue;
    const parts = t.split('\t');
    if (parts.length < 4) continue;
    const tblName = parts[1], idx = parseInt(parts[2]), val = parseInt(parts[3]);
    if (!bytecodeDump[tblName]) bytecodeDump[tblName] = [];
    bytecodeDump[tblName][idx - 1] = val;
  }
  return bytecodeDump;
}
const VM_TRACE_THRESHOLD = 50;
function checkWereDevDetected(vmTrace) { return vmTrace.length >= VM_TRACE_THRESHOLD; }

module.exports = {
  safeEnvPreamble, hookLoadstringCode, vmHookBootstrap,
  injectVmHook, runLuaWithHooks, parseDecodedOutputs,
  parseVmLogs, parseVmTrace, parseBTableLog, parseVTableLog,
  parseStrLog, parseStrCharLog, parseTConcatLog,
  saveVmTrace, parseBytecodeDump,
  VM_TRACE_THRESHOLD, checkWereDevDetected,
};
