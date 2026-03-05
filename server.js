const express = require('express');
const cors    = require('cors');
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

function checkLuaAvailable() {
  try { execSync('lua -v 2>&1', { timeout: 3000 }); return 'lua'; } catch {}
  try { execSync('luajit -v 2>&1', { timeout: 3000 }); return 'luajit'; } catch {}
  return null;
}

function checkLua51Available() {
  try { execSync('lua5.1 -v 2>&1', { timeout: 3000 }); return 'lua5.1'; } catch {}
  try { execSync('luajit -v 2>&1', { timeout: 3000 }); return 'luajit'; } catch {}
  try { execSync('lua -v 2>&1', { timeout: 3000 }); return 'lua'; } catch {}
  return null;
}

function checkPrometheusAvailable() {
  return fs.existsSync(path.join(__dirname, 'prometheus', 'cli.lua'))
      || fs.existsSync(path.join(__dirname, 'cli.lua'));
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    lua: checkLuaAvailable() || 'not installed',
    prometheus: checkPrometheusAvailable() ? 'available' : 'not found',
    deobfuscateMethods: ['auto', 'xor', 'split_strings', 'encrypt_strings', 'constant_array', 'vmify', 'dynamic'],
    obfuscatePresets:   ['Minify', 'Weak', 'Medium', 'Strong'],
    obfuscateSteps:     ['SplitStrings', 'EncryptStrings', 'ConstantArray', 'ProxifyLocals', 'WrapInFunction', 'Vmify'],
  });
});

app.post('/api/deobfuscate', async (req, res) => {
  const { code, method } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });

  let result;
  switch (method) {
    case 'xor':             result = deobfuscateXOR(code);            break;
    case 'split_strings':   result = deobfuscateSplitStrings(code);   break;
    case 'encrypt_strings': result = deobfuscateEncryptStrings(code);  break;
    case 'constant_array':  result = deobfuscateConstantArray(code);   break;
    case 'eval_expressions':result = evaluateExpressions(code);        break;
    case 'vmify':           result = deobfuscateVmify(code);           break;
    case 'dynamic':         result = await tryDynamicExecution(code);  break;
    case 'auto':
    default:                result = await autoDeobfuscate(code);      break;
  }

  res.json(result);
});

app.post('/deobfuscate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(deobfuscateXOR(code));
});

app.post('/api/obfuscate', async (req, res) => {
  const { code, preset, steps } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await obfuscateWithPrometheus(code, { preset, steps }));
});

app.post('/api/vm-obfuscate', async (req, res) => {
  const { code, seed } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await obfuscateWithCustomVM(code, { seed }));
});

// ════════════════════════════════════════════════════════
//  動的実行 (全面強化版)
//
//  強化点:
//   1. Roblox依存関数を全てスタブ化 (task.wait, coroutine等)
//   2. string.charフックで数値配列からの文字列生成を捕捉
//   3. loadstring/loadを多重フック (rawset + metatable)
//   4. アンチデバッグを徹底的に無効化
//   5. VM opcodeループ対策: pcallでタイムアウト付き実行
//   6. 全キャプチャから最長・最高スコアのものを選択
//   7. 多段実行: 最大5ラウンド
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  Lua静的コード書き換えエンジン
//  対象パターンを全て書き換えてprint出力させる
// ════════════════════════════════════════════════════════════════

async function tryDynamicExecution(code) {
  const luaBin = checkLuaAvailable();
  if (!luaBin) return { success: false, error: 'Luaがインストールされていません', method: 'dynamic' };

  const tempDir2 = require('path').join(require('path').dirname(require('fs').realpathSync(__filename || '.')), 'temp');
  const tempFile = require('path').join(tempDir, 'obf_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.lua');
  const codeB64  = Buffer.from(code, 'utf8').toString('base64');

  // Luaテンプレートのプレースホルダーをコードで置換
  const luaTemplate = "-- ══════════════════════════════════════════════════════════════\n--  YAJU Dynamic Deobfuscator v8 - Full Hook Engine\n--  全フック実装版\n-- ══════════════════════════════════════════════════════════════\n\n-- ── Base64デコーダ ───────────────────────────────────────────\nlocal function b64decode(s)\n  local alpha=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\"\n  local map={}\n  for i=1,#alpha do map[string.byte(alpha,i,i)]=i-1 end\n  local out,p={},1\n  for i=1,#s,4 do\n    local a=map[string.byte(s,i,i)];local b=map[string.byte(s,i+1,i+1)]\n    local c=map[string.byte(s,i+2,i+2)];local d=map[string.byte(s,i+3,i+3)]\n    if not a or not b then break end\n    out[p]=string.char((a*4+math.floor(b/16))%256);p=p+1\n    if not c then break end\n    out[p]=string.char(((b%16)*16+math.floor(c/4))%256);p=p+1\n    if not d then break end\n    out[p]=string.char(((c%4)*64+d)%256);p=p+1\n  end\n  return table.concat(out)\nend\n\nlocal __obf_code = b64decode(\"__CODE_B64__\")\n\n-- ══════════════════════════════════════════════════════════════\n--  ユーティリティ\n-- ══════════════════════════════════════════════════════════════\nlocal function printable_ratio(s)\n  if not s or #s==0 then return 0 end\n  local n=0; local sample=math.min(#s,4000)\n  for i=1,sample do local c=s:byte(i); if c>=32 and c<=126 then n=n+1 end end\n  return n/sample\nend\n\nlocal function lua_score(s)\n  if not s or #s<4 then return 0 end\n  local score=0\n  for _,kw in ipairs({\"local\",\"function\",\"end\",\"if\",\"then\",\"return\",\"for\",\"do\",\n                       \"while\",\"loadstring\",\"load\",\"require\",\"pcall\",\"string\",\n                       \"table\",\"math\",\"print\",\"and\",\"or\",\"not\",\"repeat\",\"until\"}) do\n    local _,n=s:gsub(\"%f[%a]\"..kw..\"%f[%A]\",\"\"); score=score+n*8\n  end\n  return score + printable_ratio(s)*80\nend\n\nlocal function is_readable(s)\n  return s and #s>=6 and printable_ratio(s)>=0.55\nend\n\nlocal function is_lua_bytecode(s)\n  return s and #s>=4 and s:sub(1,4)==\"\\27Lua\"\nend\n\nlocal function shash(s)\n  if not s then return \"nil\" end\n  local h=0; local step=math.max(1,math.floor(#s/128))\n  for i=1,#s,step do h=(h*31+s:byte(i))%2000000011 end\n  return h..\"_\"..#s\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  ステージログ\n-- ══════════════════════════════════════════════════════════════\nlocal stage_log={}   -- 全キャプチャ (順番重要)\nlocal seen={}        -- 重複防止\nlocal trace_seen={}  -- trace_execute重複防止\n\nlocal function log_code(code_str, source, depth)\n  if not code_str or type(code_str)~=\"string\" then return end\n  if not is_readable(code_str) and not is_lua_bytecode(code_str) then return end\n  local h=shash(code_str)\n  if seen[h] then return end\n  seen[h]=true\n  stage_log[#stage_log+1]={\n    code  =code_str,\n    source=source,\n    depth =depth,\n    score =lua_score(code_str),\n    is_bc =is_lua_bytecode(code_str),\n  }\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  スタブ\n-- ══════════════════════════════════════════════════════════════\nlocal function stub()\n  return setmetatable({},{\n    __index   =function(_,k) return stub() end,\n    __newindex=function() end,\n    __call    =function(...) return stub() end,\n    __tostring=function() return \"\" end,\n    __len     =function() return 0 end,\n    __eq      =function() return false end,\n    __lt      =function() return false end,\n    __le      =function() return false end,\n    __add     =function() return 0 end,\n    __sub     =function() return 0 end,\n    __mul     =function() return 0 end,\n    __div     =function() return 0 end,\n    __mod     =function() return 0 end,\n    __unm     =function() return 0 end,\n    __concat  =function() return \"\" end,\n  })\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  原本関数を保存 (フック前に必ず保存)\n-- ══════════════════════════════════════════════════════════════\nlocal _ls         = loadstring or load\nlocal _ld         = load or loadstring\nlocal _sc         = string.char\nlocal _sb         = string.byte\nlocal _tc         = table.concat\nlocal _ti         = table.insert\nlocal _tu         = table.unpack or unpack\nlocal _pcall      = pcall\nlocal _xpcall     = xpcall\nlocal _tostring   = tostring\nlocal _rawget     = rawget\nlocal _rawset     = rawset\nlocal _setmt      = setmetatable\nlocal _getmt      = getmetatable\nlocal _select     = select\nlocal _require    = require\nlocal _type       = type\nlocal _pairs      = pairs\nlocal _ipairs     = ipairs\nlocal _next       = next\nlocal _orig_print = print\nlocal _io_write   = io.write\nlocal _sf         = string.format\nlocal _sg         = string.gsub\nlocal _sm         = string.match\nlocal _sgm        = string.gmatch\nlocal _ss         = string.sub\nlocal _sr         = string.rep\nlocal _srev       = string.reverse\nlocal _slen       = string.len\nlocal _sfind      = string.find\nlocal _co_cr      = coroutine.create\nlocal _co_wr      = coroutine.wrap\nlocal _co_res     = coroutine.resume\nlocal _co_sta     = coroutine.status\nlocal _co_cur     = coroutine.running\nlocal _math_floor = math.floor\nlocal _math_max   = math.max\nlocal _math_min   = math.min\nlocal _math_random= math.random\nlocal _os_time    = os.time\nlocal _os_clock   = os.clock\n\n-- bit32 or 互換実装\nlocal _bit32 = bit32 or {}\nif not _bit32.bxor then\n  local function _xor(a,b)\n    local r=0\n    for i=0,31 do\n      local x=_math_floor(a/2^i)%2\n      local y=_math_floor(b/2^i)%2\n      if x~=y then r=r+2^i end\n    end\n    return r\n  end\n  local function _and(a,b)\n    local r=0\n    for i=0,31 do\n      if _math_floor(a/2^i)%2==1 and _math_floor(b/2^i)%2==1 then r=r+2^i end\n    end\n    return r\n  end\n  local function _or(a,b)\n    local r=0\n    for i=0,31 do\n      if _math_floor(a/2^i)%2==1 or _math_floor(b/2^i)%2==1 then r=r+2^i end\n    end\n    return r\n  end\n  local function _not(a)\n    local r=0\n    for i=0,31 do\n      if _math_floor(a/2^i)%2==0 then r=r+2^i end\n    end\n    return r\n  end\n  _bit32={\n    bxor=_xor, band=_and, bor=_or, bnot=_not,\n    lshift=function(a,b) return _math_floor(a*2^b)%4294967296 end,\n    rshift=function(a,b) return _math_floor(a/2^b) end,\n    arshift=function(a,b) return _math_floor(a/2^b) end,\n    rol=function(a,b) b=b%32; return (_math_floor(a*2^b)+_math_floor(a/2^(32-b)))%4294967296 end,\n    ror=function(a,b) b=b%32; return (_math_floor(a/2^b)+_math_floor(a*2^(32-b)))%4294967296 end,\n    extract=function(n,f,w) w=w or 1; return _math_floor(n/2^f)%(2^w) end,\n    replace=function(n,v,f,w) w=w or 1; local m=2^w-1; return n-_and(n,_math_floor(m*2^f))+_math_floor(_and(v,m)*2^f) end,\n    tobit=function(a) return a%4294967296 end,\n    tohex=function(a) return _sf(\"%x\",a) end,\n  }\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  環境スタブ適用\n-- ══════════════════════════════════════════════════════════════\nlocal function apply_env_stubs()\n  local env={\n    wait=function()end, spawn=function(f,...)_pcall(f,...)end,\n    delay=function(t,f,...)_pcall(f,...)end,\n    getgenv=function()return _G end, getrenv=function()return _G end,\n    getsenv=function()return _G end,\n    hookfunction=function(f)return f end,\n    newcclosure=function(f)return f end,\n    iscclosure=function()return false end,\n    islclosure=function()return true end,\n    checkcaller=function()return false end,\n    isexecutorclosure=function()return false end,\n    saveinstance=function()end, dumpstring=function()end,\n    readfile=function()return\"\"end, writefile=function()end,\n    appendfile=function()end, listfiles=function()return{}end,\n    getrawmetatable=_getmt, setrawmetatable=_setmt,\n    rconsoleprint=function()end, rconsolewarn=function()end,\n    rconsoleerr=function()end, setclipboard=function()end,\n    printidentity=function()end,\n    identifyexecutor=function()return\"\",2 end,\n    getexecutorname=function()return\"\"end,\n    syn={protect_gui=function()end,queue_on_teleport=function()end},\n    game=stub(), workspace=stub(), script=stub(),\n    Instance={new=function()return stub()end,fromExisting=function()return stub()end},\n    Vector3={new=function(x,y,z)return{x=x or 0,y=y or 0,z=z or 0,Magnitude=0}end,\n             fromNormalId=function()return stub()end,zero=stub()},\n    CFrame={new=function(...)return stub()end,\n            Angles=function(...)return stub()end,\n            fromEulerAnglesXYZ=function(...)return stub()end,\n            fromMatrix=function(...)return stub()end,\n            identity=stub()},\n    Color3={new=function(...)return{}end,fromRGB=function(...)return{}end,\n            fromHSV=function(...)return{}end},\n    UDim2={new=function(...)return{}end,fromScale=function(...)return{}end,\n           fromOffset=function(...)return{}end},\n    UDim={new=function(...)return{}end},\n    Rect={new=function(...)return{}end},\n    Region3={new=function(...)return{}end},\n    NumberSequence={new=function(...)return{}end},\n    ColorSequence={new=function(...)return{}end},\n    Enum=_setmt({},{__index=function(t,k)\n      return _setmt({},{__index=function(t2,k2)return k2 end})\n    end}),\n    Players={LocalPlayer={\n      Character=nil,UserId=0,Name=\"Player\",DisplayName=\"Player\",\n      GetMouse=function()return stub()end,\n      WaitForChild=function()return stub()end,\n      FindFirstChild=function()return nil end,\n      IsA=function()return false end,\n    }},\n    RunService={\n      Heartbeat={Connect=function()return{Disconnect=function()end}end,Wait=function()return 0 end},\n      RenderStepped={Connect=function()return{Disconnect=function()end}end,Wait=function()return 0 end},\n      Stepped={Connect=function()return{Disconnect=function()end}end,Wait=function()return 0 end},\n      IsStudio=function()return false end,\n      IsRunning=function()return true end,\n      IsClient=function()return true end,\n      IsServer=function()return false end,\n    },\n    UserInputService=stub(),\n    TweenService={Create=function()return{Play=function()end,Completed=stub()}end},\n    HttpService={JSONDecode=function()return{}end,JSONEncode=function()return\"{}\"end,\n                 GetAsync=function()return\"\"end,PostAsync=function()return\"\"end},\n    task={\n      wait  =function()end,\n      spawn =function(f,...) if _type(f)==\"function\" then _pcall(f,...) end end,\n      defer =function(f,...) if _type(f)==\"function\" then _pcall(f,...) end end,\n      delay =function(t,f,...) if _type(f)==\"function\" then _pcall(f,...) end end,\n      cancel=function()end,\n      synchronize=function()end,\n      desynchronize=function()end,\n    },\n    shared={}, warn=function()end,\n    -- bit32互換\n    bit32=_bit32,\n    -- Lua5.1互換\n    bit=_bit32,\n    -- LuaJIT互換\n    jit={version=\"LuaJIT 2.0.0\",os=\"Linux\",arch=\"x64\",\n         opt={start=function()end,stop=function()end,flush=function()end},\n         on=function()end,off=function()end},\n    -- ffi stub\n    ffi={new=function()return stub()end,cast=function()return stub()end,\n         typeof=function()return stub()end,cdef=function()end,\n         string=function()return\"\"end,copy=function()end,fill=function()end,\n         C=stub()},\n  }\n  for k,v in _pairs(env) do _rawset(_G,k,v) end\nend\napply_env_stubs()\n\n-- ══════════════════════════════════════════════════════════════\n--  アンチデバッグ無効化 (debug.getinfoのみスタブ、sethookは後で再実装)\n-- ══════════════════════════════════════════════════════════════\npcall(function()\n  if debug then\n    -- getinfo: アンチデバッグチェックで使われるのでスタブ\n    debug.getinfo   =function(f,what)\n      -- 呼び出し元チェックに使われる場合は安全な値を返す\n      return {what=\"Lua\",currentline=1,source=\"@script\",short_src=\"script\",\n              nups=0,name=nil,namewhat=\"\",istailcall=false}\n    end\n    debug.getlocal  =function()return nil end\n    debug.setlocal  =function()end\n    debug.getupvalue=function(f,n)return nil end\n    debug.setupvalue=function()end\n    debug.traceback =function()return\"\"end\n    debug.getmetatable=_getmt\n    debug.setmetatable=_setmt\n    -- sethookはトレース用に後で再実装するので今は空にする\n    debug.sethook   =function()end\n  end\nend)\n\n-- ══════════════════════════════════════════════════════════════\n--  トレースエンジン\n-- ══════════════════════════════════════════════════════════════\nlocal DEPTH     = 0\nlocal MAX_DEPTH = 20\nlocal MAX_INSTR = 10000000\nlocal trace_execute  -- 前方宣言\n\n-- ── フック群を適用する関数 ───────────────────────────────────\nlocal function apply_hooks(depth)\n\n  -- ── loadstring / load フック ──────────────────────────────\n  local function ls_hook(code_str, name, ...)\n    if _type(code_str)==\"string\" and #code_str>8 then\n      -- Lua bytecodeも捕捉\n      if is_lua_bytecode(code_str) then\n        log_code(code_str, \"load_bytecode@d\"..depth, depth)\n      else\n        log_code(code_str, \"loadstring@d\"..depth, depth)\n      end\n      -- 次段階を再帰トレース\n      if depth < MAX_DEPTH then\n        trace_execute(code_str, depth+1)\n      end\n    end\n    return _ls(code_str, name, ...)\n  end\n  _rawset(_G,\"loadstring\",ls_hook)\n  _rawset(_G,\"load\",ls_hook)\n\n  -- _ENV対応 (Lua5.2+)\n  pcall(function()\n    if _ENV then _ENV.loadstring=ls_hook; _ENV.load=ls_hook end\n  end)\n\n  -- metatableでも捕捉\n  pcall(function()\n    local mt=_getmt(_G) or {}\n    local oi=mt.__index\n    mt.__index=function(t,k)\n      if k==\"loadstring\" or k==\"load\" then return ls_hook end\n      if oi then return _type(oi)==\"function\" and oi(t,k) or oi[k] end\n      return _rawget(t,k)\n    end\n    _setmt(_G,mt)\n  end)\n\n  -- ── string.char フック ────────────────────────────────────\n  string.char=function(...)\n    local r=_sc(...)\n    if is_readable(r) and lua_score(r)>=15 then\n      log_code(r,\"string.char@d\"..depth,depth)\n    end\n    return r\n  end\n\n  -- ── string.byte フック ────────────────────────────────────\n  -- byte配列→char変換ループ検出用にラップ\n  string.byte=function(s,i,j)\n    return _sb(s,i,j)\n  end\n\n  -- ── string.format フック ─────────────────────────────────\n  string.format=function(fmt,...)\n    local r=_sf(fmt,...)\n    if _type(r)==\"string\" and is_readable(r) and lua_score(r)>=20 then\n      log_code(r,\"string.format@d\"..depth,depth)\n    end\n    return r\n  end\n\n  -- ── string.gsub フック ────────────────────────────────────\n  string.gsub=function(s,p,r,n)\n    local res,cnt=_sg(s,p,r,n)\n    if _type(res)==\"string\" and is_readable(res) and lua_score(res)>=15 then\n      log_code(res,\"string.gsub@d\"..depth,depth)\n    end\n    return res,cnt\n  end\n\n  -- ── string.rep フック ─────────────────────────────────────\n  string.rep=function(s,n,sep)\n    local r=_sr(s,n,sep)\n    if _type(r)==\"string\" and is_readable(r) and lua_score(r)>=15 then\n      log_code(r,\"string.rep@d\"..depth,depth)\n    end\n    return r\n  end\n\n  -- ── string.reverse フック ─────────────────────────────────\n  string.reverse=function(s)\n    local r=_srev(s)\n    if _type(r)==\"string\" and is_readable(r) and lua_score(r)>=15 then\n      log_code(r,\"string.reverse@d\"..depth,depth)\n    end\n    return r\n  end\n\n  -- ── table.concat フック ───────────────────────────────────\n  table.concat=function(t,sep,i,j)\n    local r=_tc(t,sep,i,j)\n    if _type(r)==\"string\" then\n      if is_lua_bytecode(r) then\n        log_code(r,\"table.concat_bc@d\"..depth,depth)\n        trace_execute(r,depth+1)\n      elseif is_readable(r) and lua_score(r)>=15 then\n        log_code(r,\"table.concat@d\"..depth,depth)\n        if lua_score(r)>=40 then trace_execute(r,depth+1) end\n      end\n    end\n    return r\n  end\n\n  -- ── table.unpack / unpack フック ──────────────────────────\n  local function unpack_hook(t,i,j)\n    -- テーブル内容をチェック\n    if _type(t)==\"table\" then\n      local s=_tc(t,\"\")\n      if is_readable(s) and lua_score(s)>=20 then\n        log_code(s,\"table.unpack@d\"..depth,depth)\n      end\n    end\n    return _tu(t,i,j)\n  end\n  table.unpack=unpack_hook\n  rawset(_G,\"unpack\",unpack_hook)\n\n  -- ── print フック ─────────────────────────────────────────\n  print=function(...)\n    local args={...}\n    for _,v in _ipairs(args) do\n      if _type(v)==\"string\" and is_readable(v) then\n        log_code(v,\"print@d\"..depth,depth)\n      end\n    end\n  end\n\n  -- ── io.write フック ───────────────────────────────────────\n  io.write=function(...)\n    local args={...}\n    for _,v in _ipairs(args) do\n      if _type(v)==\"string\" and is_readable(v) and lua_score(v)>=10 then\n        log_code(v,\"io.write@d\"..depth,depth)\n      end\n    end\n    _io_write(...)\n  end\n\n  -- ── warn フック ───────────────────────────────────────────\n  rawset(_G,\"warn\",function(...)\n    local args={...}\n    for _,v in _ipairs(args) do\n      if _type(v)==\"string\" and is_readable(v) then\n        log_code(v,\"warn@d\"..depth,depth)\n      end\n    end\n  end)\n\n  -- ── tostring フック ───────────────────────────────────────\n  tostring=function(v)\n    local r=_tostring(v)\n    if _type(r)==\"string\" and is_readable(r) and lua_score(r)>=20 then\n      log_code(r,\"tostring@d\"..depth,depth)\n    end\n    return r\n  end\n\n  -- ── bit32フック (XOR/AND/OR復号検出) ────────────────────\n  local function make_bit_hook(orig_fn, fname)\n    return function(a,b,...)\n      local r=orig_fn(a,b,...)\n      -- bit演算の結果が可読文字コードなら記録\n      -- (単体では意味なし、string.charフックと組み合わせる)\n      return r\n    end\n  end\n  if _bit32 then\n    local bt={}\n    for k,v in _pairs(_bit32) do\n      if _type(v)==\"function\" then bt[k]=make_bit_hook(v,k)\n      else bt[k]=v end\n    end\n    rawset(_G,\"bit32\",bt)\n    rawset(_G,\"bit\",bt)\n    -- グローバルのbit32.*も上書き\n    if bit32 then\n      for k,v in _pairs(bt) do bit32[k]=v end\n    end\n  end\n\n  -- ── string.dump フック (bytecode生成捕捉) ────────────────\n  if string.dump then\n    local _sdump=string.dump\n    string.dump=function(f,strip)\n      local r=_sdump(f,strip)\n      if is_lua_bytecode(r) then\n        log_code(r,\"string.dump@d\"..depth,depth)\n      end\n      return r\n    end\n  end\n\n  -- ── pcall / xpcall フック ─────────────────────────────────\n  pcall=function(f,...)\n    if _type(f)==\"function\" then apply_hooks(depth) end\n    return _pcall(f,...)\n  end\n  xpcall=function(f,h,...)\n    if _type(f)==\"function\" then apply_hooks(depth) end\n    return _xpcall(f,h,...)\n  end\n\n  -- ── coroutine フック ─────────────────────────────────────\n  coroutine.create=function(f)\n    local function wrapped(...)\n      apply_hooks(depth)\n      return f(...)\n    end\n    return _co_cr(wrapped)\n  end\n  coroutine.wrap=function(f)\n    local function wrapped(...)\n      apply_hooks(depth)\n      return f(...)\n    end\n    return _co_wr(wrapped)\n  end\n  coroutine.resume=function(co,...)\n    return _co_res(co,...)\n  end\n\n  -- ── task フック (全て同期実行) ───────────────────────────\n  local task_tbl={\n    wait  =function()end,\n    spawn =function(f,...) if _type(f)==\"function\" then apply_hooks(depth);_pcall(f,...) end end,\n    defer =function(f,...) if _type(f)==\"function\" then apply_hooks(depth);_pcall(f,...) end end,\n    delay =function(t,f,...) if _type(f)==\"function\" then apply_hooks(depth);_pcall(f,...) end end,\n    cancel=function()end,synchronize=function()end,desynchronize=function()end,\n  }\n  _rawset(_G,\"task\",task_tbl)\n  _rawset(_G,\"spawn\",function(f,...) if _type(f)==\"function\" then apply_hooks(depth);_pcall(f,...) end end)\n  _rawset(_G,\"delay\",function(t,f,...) if _type(f)==\"function\" then apply_hooks(depth);_pcall(f,...) end end)\n\n  -- ── require フック ────────────────────────────────────────\n  require=function(modname)\n    -- 動的ロードを捕捉\n    log_code(\"require(\\\"\"..tostring(modname)..\"\\\")\", \"require@d\"..depth, depth)\n    local ok,r=_pcall(_require,modname)\n    if ok then return r end\n    return stub()\n  end\n\n  -- ── getfenv / setfenv フック (Lua5.1) ────────────────────\n  if getfenv then\n    local _gfe=getfenv\n    local _sfe=setfenv\n    getfenv=function(f)\n      local env=_gfe(f or 1)\n      return env\n    end\n    setfenv=function(f,env)\n      -- envに書き換えが入ったらフックを再適用\n      if env and _type(env)==\"table\" then\n        env.loadstring=_rawget(_G,\"loadstring\")\n        env.load=_rawget(_G,\"load\")\n      end\n      return _sfe(f,env)\n    end\n  end\n\n  -- ── rawset フック (metatable難読化監視) ──────────────────\n  rawset=function(t,k,v)\n    if _type(v)==\"string\" and is_readable(v) and lua_score(v)>=20 then\n      log_code(v,\"rawset_val@d\"..depth,depth)\n    end\n    return _rawset(t,k,v)\n  end\n\n  -- ── rawget フック ─────────────────────────────────────────\n  rawget=function(t,k)\n    local v=_rawget(t,k)\n    if _type(v)==\"string\" and is_readable(v) and lua_score(v)>=20 then\n      log_code(v,\"rawget_val@d\"..depth,depth)\n    end\n    return v\n  end\n\n  -- ── select フック ─────────────────────────────────────────\n  select=function(idx,...)\n    local args={...}\n    for _,v in _ipairs(args) do\n      if _type(v)==\"string\" and is_readable(v) and lua_score(v)>=20 then\n        log_code(v,\"select_arg@d\"..depth,depth)\n      end\n    end\n    return _select(idx,...)\n  end\n\n  -- ── os.time / math.random フック (動的キー復号ログ) ──────\n  os.time=function(t)\n    return 0  -- 固定値を返すことで動的キーを固定化\n  end\n  math.random=function(a,b)\n    -- 固定シードを返す\n    if a and b then return a end\n    if a then return 1 end\n    return 0\n  end\n  math.randomseed=function()end\n\n  -- ── utf8.char フック ──────────────────────────────────────\n  pcall(function()\n    if utf8 and utf8.char then\n      local _utf8c=utf8.char\n      utf8.char=function(...)\n        local r=_utf8c(...)\n        if is_readable(r) then log_code(r,\"utf8.char@d\"..depth,depth) end\n        return r\n      end\n    end\n  end)\n\n  -- ── string.gmatch / string.find フック ───────────────────\n  string.gmatch=function(s,p)\n    local iter=_sgm(s,p)\n    return function()\n      local r=iter()\n      if _type(r)==\"string\" and is_readable(r) and lua_score(r)>=15 then\n        log_code(r,\"string.gmatch@d\"..depth,depth)\n      end\n      return r\n    end\n  end\n\n  -- ── setmetatable フック (__call/__index経由実行捕捉) ─────\n  setmetatable=function(t,mt)\n    if mt then\n      -- __call フック\n      if _type(mt.__call)==\"function\" then\n        local orig_call=mt.__call\n        mt.__call=function(self,...)\n          apply_hooks(depth)\n          return orig_call(self,...)\n        end\n      end\n      -- __index フック (関数の場合)\n      if _type(mt.__index)==\"function\" then\n        local orig_idx=mt.__index\n        mt.__index=function(self,k)\n          local v=orig_idx(self,k)\n          if _type(v)==\"string\" and is_readable(v) and lua_score(v)>=20 then\n            log_code(v,\"mt.__index@d\"..depth,depth)\n          end\n          return v\n        end\n      end\n    end\n    return _setmt(t,mt)\n  end\n\n  -- LuaJIT互換\n  pcall(function()\n    if jit then\n      jit.on=function()end; jit.off=function()end\n      jit.flush=function()end; jit.opt={start=function()end}\n    end\n  end)\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  trace_execute 本体\n-- ══════════════════════════════════════════════════════════════\ntrace_execute=function(code_str, depth)\n  if depth > MAX_DEPTH then return end\n  if not code_str or #code_str<4 then return end\n  local h=shash(code_str)\n  if trace_seen[h] then return end\n  trace_seen[h]=true\n\n  -- フック適用\n  apply_hooks(depth)\n\n  -- 命令数カウンタ (debug.sethookを命令トレース用に再実装)\n  local instr=0\n  local limit_hit=false\n  _pcall(function()\n    if debug and debug.sethook then\n      debug.sethook=function(f,mask,count)\n        -- 外部からsethookされた場合は何もしない\n      end\n      -- 内部用のトレースフックを直接設定\n      local real_sethook=rawget(debug,\"sethook\") or function()end\n      -- Lua5.1ではdebug.sethookが使える\n      local ok=_pcall(function()\n        local ds=rawget(debug,\"sethook\")\n        if ds then\n          ds(function(event)\n            instr=instr+1\n            if instr>MAX_INSTR then\n              limit_hit=true\n              error(\"__INSTR_LIMIT__\",2)\n            end\n          end,\"\",1000)\n        end\n      end)\n    end\n  end)\n\n  -- Lua bytecodeの場合もloadで実行\n  local chunk,err=_ls(code_str)\n  if chunk then\n    _pcall(chunk)\n  end\n\n  -- sethookリセット\n  _pcall(function()\n    if debug then\n      local ds=_rawget(debug,\"sethook\")\n      if ds then ds() end\n    end\n  end)\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  メイン実行\n-- ══════════════════════════════════════════════════════════════\ntrace_execute(__obf_code, 0)\n\n-- ══════════════════════════════════════════════════════════════\n--  結果選択\n-- ══════════════════════════════════════════════════════════════\nlocal best=nil\nlocal best_score=-1\n\n-- loadstring系を後ろから探す (最終段階)\nfor i=#stage_log,1,-1 do\n  local e=stage_log[i]\n  if e.source:find(\"loadstring\") and e.code and #e.code>10 and not e.is_bc then\n    best=e; break\n  end\nend\n\n-- bytecodeより可読コードを優先、なければbytecodeも候補に\nif not best then\n  for i=#stage_log,1,-1 do\n    local e=stage_log[i]\n    if e.code and #e.code>10 and (e.score or 0)>best_score then\n      best_score=e.score; best=e\n    end\n  end\nend\n\n-- ══════════════════════════════════════════════════════════════\n--  出力\n-- ══════════════════════════════════════════════════════════════\nif best and best.code and #best.code>5 then\n  _io_write(\"__CAPTURED_START__\")\n  _io_write(best.code)\n  _io_write(\"__CAPTURED_END__\")\n  _io_write(_sf(\"__META__stages=%d,source=%s,score=%d,depth=%d,total=%d\",\n    #stage_log,\n    tostring(best.source):gsub(\",\",\"_\"),\n    _math_floor(best.score or 0),\n    best.depth or 0,\n    #stage_log\n  ))\nelse\n  _io_write(\"__NO_CAPTURE__stages=\".._tostring(#stage_log))\nend\n";
  const wrapper = luaTemplate.replace('__CODE_B64__', codeB64);

  return new Promise(resolve => {
    require('fs').writeFileSync(tempFile, wrapper, 'utf8');

    require('child_process').exec(luaBin + ' ' + tempFile, { timeout: 45000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { require('fs').unlinkSync(tempFile); } catch {}

      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const s        = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const e        = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(s, e);
        const meta     = stdout.substring(e + '__CAPTURED_END__'.length);

        const stagesM  = meta.match(/stages=(\d+)/);
        const sourceM  = meta.match(/source=([^,]+)/);
        const scoreM   = meta.match(/score=(\d+)/);
        const depthM   = meta.match(/depth=(\d+)/);
        const totalM   = meta.match(/total=(\d+)/);

        if (captured && captured.length > 5) {
          return resolve({
            success: true,
            result:  captured,
            stages:  stagesM ? parseInt(stagesM[1]) : 1,
            source:  sourceM ? sourceM[1]            : 'unknown',
            score:   scoreM  ? parseInt(scoreM[1])   : 0,
            depth:   depthM  ? parseInt(depthM[1])   : 0,
            total:   totalM  ? parseInt(totalM[1])   : 0,
            method:  'dynamic',
          });
        }
      }

      if (stdout.includes('__NO_CAPTURE__')) {
        const stagesM = stdout.match(/stages=(\d+)/);
        const stages  = stagesM ? parseInt(stagesM[1]) : 0;
        return resolve({
          success: false,
          error: '解読不可: '+stages+'段階処理しましたが可読コードが得られませんでした',
          method: 'dynamic',
        });
      }

      if (error && stderr) {
        return resolve({ success: false, error: 'プロセスエラー: ' + stderr.substring(0, 300), method: 'dynamic' });
      }

      resolve({ success: false, error: 'コードが生成されませんでした', method: 'dynamic' });
    });
  });
}

// ════════════════════════════════════════════════════════
//  静的解読メソッド群
// ════════════════════════════════════════════════════════

function scoreLuaCode(code) {
  const keywords = ['local','function','end','if','then','else','return','for','do','while','and','or','not','nil','true','false','print','table','string','math'];
  let score = 0;
  keywords.forEach(kw => {
    const m = code.match(new RegExp('\\b' + kw + '\\b', 'g'));
    if (m) score += m.length * 10;
  });
  let printable = 0;
  for (let i = 0; i < Math.min(code.length, 2000); i++) {
    const c = code.charCodeAt(i);
    if (c >= 32 && c <= 126) printable++;
  }
  score += (printable / Math.min(code.length, 2000)) * 100;
  return score;
}

function parseLuaArrayElements(content) {
  const elements = [];
  let cur = '', depth = 0, inStr = false, strChar = '', i = 0;
  while (i < content.length) {
    const c = content[i];
    if (!inStr) {
      if (c === '"' || c === "'") { inStr = true; strChar = c; cur += c; }
      else if (c === '[' && content[i+1] === '[') {
        let end = content.indexOf(']]', i + 2);
        if (end === -1) end = content.length - 2;
        cur += content.substring(i, end + 2);
        i = end + 2; continue;
      }
      else if (c === '{') { depth++; cur += c; }
      else if (c === '}') { depth--; cur += c; }
      else if (c === ',' && depth === 0) { elements.push(cur.trim()); cur = ''; }
      else { cur += c; }
    } else {
      if (c === '\\') { cur += c + (content[i+1] || ''); i += 2; continue; }
      if (c === strChar) { inStr = false; }
      cur += c;
    }
    i++;
  }
  if (cur.trim()) elements.push(cur.trim());
  return elements;
}

function resolveLuaStringEscapes(str) {
  return str
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\'/g, "'")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(\d{1,3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function evalSimpleExpr(expr) {
  try {
    const clean = expr.trim();
    if (!/^[\d\s+\-*/%().]+$/.test(clean)) return null;
    const result = Function('"use strict"; return (' + clean + ')')();
    if (typeof result === 'number' && isFinite(result)) return Math.floor(result);
    return null;
  } catch { return null; }
}

function xorDecryptByte(byte, key) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    const a = (byte >> i) & 1, b = (key >> i) & 1;
    if (a !== b) result |= (1 << i);
  }
  return result;
}

function deobfuscateXOR(code) {
  const patterns = [/local\s+\w+\s*=\s*\{([0-9,\s]+)\}/g, /\{([0-9,\s]+)\}/g];
  let encryptedArrays = [];
  for (const pattern of patterns) {
    let match;
    const p = new RegExp(pattern.source, pattern.flags);
    while ((match = p.exec(code)) !== null) {
      const nums = match[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      if (nums.length > 3) encryptedArrays.push(nums);
    }
    if (encryptedArrays.length > 0) break;
  }
  if (encryptedArrays.length === 0) return { success: false, error: '暗号化配列が見つかりません', method: 'xor' };
  let bestResult = null, bestScore = -1, bestKey = -1;
  for (const arr of encryptedArrays) {
    for (let key = 0; key <= 255; key++) {
      const str = arr.map(b => String.fromCharCode(xorDecryptByte(b, key))).join('');
      const score = scoreLuaCode(str);
      if (score > bestScore) { bestScore = score; bestResult = str; bestKey = key; }
    }
  }
  if (bestScore < 10) return { success: false, error: '有効なLuaコードが見つかりませんでした', method: 'xor' };
  return { success: true, result: bestResult, key: bestKey, score: bestScore, method: 'xor' };
}

function deobfuscateSplitStrings(code) {
  let modified = code, found = false, iterations = 0;
  const re1 = /"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g;
  const re2 = /'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.)*)'/g;
  while (re1.test(modified) && iterations < 60) {
    modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g, (_, a, b) => `"${a}${b}"`);
    found = true; iterations++; re1.lastIndex = 0;
  }
  while (re2.test(modified) && iterations < 120) {
    modified = modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.)*)'/g, (_, a, b) => `'${a}${b}'`);
    found = true; iterations++; re2.lastIndex = 0;
  }
  if (!found) return { success: false, error: 'SplitStringsパターンが見つかりません', method: 'split_strings' };
  return { success: true, result: modified, method: 'split_strings' };
}

function deobfuscateEncryptStrings(code) {
  let modified = code, found = false;
  modified = modified.replace(/string\.char\(([\d,\s]+)\)/g, (_, nums) => {
    const chars = nums.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 65535);
    if (chars.length === 0) return _;
    found = true;
    return `"${chars.map(c => { const ch = String.fromCharCode(c); return ch === '"' ? '\\"' : ch === '\\' ? '\\\\' : ch; }).join('')}"`;
  });
  modified = modified.replace(/"((?:\\[0-9]{1,3}|\\x[0-9a-fA-F]{2}|[^"\\])+)"/g, (match, inner) => {
    if (!/\\[0-9]|\\x/i.test(inner)) return match;
    try {
      const decoded = resolveLuaStringEscapes(inner);
      if ([...decoded].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)) {
        found = true;
        return `"${decoded.replace(/"/g, '\\"').replace(/\\/g, '\\\\')}"`;
      }
    } catch {}
    return match;
  });
  if (!found) return { success: false, error: 'EncryptStringsパターンが見つかりません', method: 'encrypt_strings' };
  return { success: true, result: modified, method: 'encrypt_strings' };
}

function deobfuscateConstantArray(code) {
  let modified = code, found = false;
  let passCount = 0;
  while (passCount++ < 10) {
    let changed = false;
    const arrayPattern = /local\s+(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let match;
    const snapshot = modified;
    while ((match = arrayPattern.exec(snapshot)) !== null) {
      const varName = match[1], content = match[2];
      const elements = parseLuaArrayElements(content);
      if (elements.length < 1) continue;
      const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const indexRe = new RegExp(escaped + '\\[([^\\]]+)\\]', 'g');
      modified = modified.replace(indexRe, (fullMatch, indexExpr) => {
        const idx = evalSimpleExpr(indexExpr.trim());
        if (idx === null || idx < 1 || idx > elements.length) return fullMatch;
        found = true; changed = true;
        return elements[idx - 1];
      });
    }
    if (!changed) break;
  }
  if (!found) return { success: false, error: 'ConstantArrayパターンが見つかりません', method: 'constant_array' };
  return { success: true, result: modified, method: 'constant_array' };
}

function evaluateExpressions(code) {
  let modified = code, found = false;
  let prev, iters = 0;
  do {
    prev = modified;
    modified = modified.replace(/\(\s*([\d.]+)\s*([\+\-\*\/\%])\s*([\d.]+)\s*\)/g, (_, a, op, b) => {
      const result = evalSimpleExpr(`${a}${op}${b}`);
      if (result === null) return _;
      found = true; return String(result);
    });
  } while (modified !== prev && ++iters < 20);
  modified = modified.replace(/\[\s*([\d\s+\-*\/%().]+)\s*\]/g, (match, expr) => {
    const result = evalSimpleExpr(expr);
    if (result === null) return match;
    found = true; return `[${result}]`;
  });
  let concatIter = 0;
  while (/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g.test(modified) && concatIter++ < 40) {
    modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g, (_, a, b) => { found = true; return `"${a}${b}"`; });
  }
  if (!found) return { success: false, error: '評価できる式がありませんでした', method: 'eval_expressions' };
  return { success: true, result: modified, method: 'eval_expressions' };
}

function deobfuscateVmify(code) {
  const hints = [];
  if (/return\s*\(function\s*\([^)]*\)/s.test(code)) hints.push('VMラッパー検出');
  if (/\bInstructions\b|\bProto\b|\bupValues\b/i.test(code)) hints.push('Luaバイトコード構造を検出');
  const strings = [];
  const strPattern = /"([^"\\]{4,}(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = strPattern.exec(code)) !== null) { if (m[1].length > 4) strings.push(m[1]); }
  if (strings.length > 0) hints.push(`${strings.length}件の文字列リテラルを抽出`);
  if (/\{(\s*\d+\s*,){8,}/.test(code)) hints.push('大規模バイトコードテーブルを検出');
  if (hints.length === 0) return { success: false, error: 'Vmifyパターンが検出されませんでした', method: 'vmify' };
  return { success: true, result: code, hints, strings: strings.slice(0, 50), warning: 'Vmify完全解読には動的実行を推奨', method: 'vmify' };
}

// ════════════════════════════════════════════════════════
//  AUTO
// ════════════════════════════════════════════════════════
async function autoDeobfuscate(code) {
  const results = [];
  let current = code;
  const luaBin = checkLuaAvailable();

  if (luaBin) {
    const dynRes = await tryDynamicExecution(current);
    results.push({ step: '動的実行 (1回目)', ...dynRes });

    if (dynRes.success && dynRes.result) {
      current = dynRes.result;

      for (let round = 2; round <= 5; round++) {
        const stillObfuscated = /loadstring|load\s*\(|[A-Za-z0-9+/]{60,}={0,2}/.test(current);
        if (!stillObfuscated) break;

        const dynRes2 = await tryDynamicExecution(current);
        results.push({ step: `動的実行 (${round}回目)`, ...dynRes2 });
        if (dynRes2.success && dynRes2.result && dynRes2.result !== current) {
          current = dynRes2.result;
        } else {
          break;
        }
      }
    } else {
      results.push({ step: '静的解析フォールバック開始', success: true, result: current, method: 'info' });

      const staticSteps = [
        { name: 'SplitStrings',    fn: deobfuscateSplitStrings },
        { name: 'EncryptStrings',  fn: deobfuscateEncryptStrings },
        { name: 'EvalExpressions', fn: evaluateExpressions },
        { name: 'ConstantArray',   fn: deobfuscateConstantArray },
        { name: 'XOR',             fn: deobfuscateXOR },
      ];

      let staticChanged = false;
      for (const step of staticSteps) {
        const res = step.fn(current);
        results.push({ step: step.name, ...res });
        if (res.success && res.result && res.result !== current) {
          current = res.result;
          staticChanged = true;
        }
      }

      if (staticChanged) {
        const dynRes3 = await tryDynamicExecution(current);
        results.push({ step: '動的実行 (静的解析後)', ...dynRes3 });
        if (dynRes3.success && dynRes3.result) current = dynRes3.result;
      }
    }
  } else {
    results.push({ step: '動的実行', success: false, error: 'Luaがインストールされていません', method: 'dynamic' });
    const staticSteps = [
      { name: 'SplitStrings',    fn: deobfuscateSplitStrings },
      { name: 'EncryptStrings',  fn: deobfuscateEncryptStrings },
      { name: 'EvalExpressions', fn: evaluateExpressions },
      { name: 'ConstantArray',   fn: deobfuscateConstantArray },
      { name: 'XOR',             fn: deobfuscateXOR },
      { name: 'Vmify',           fn: deobfuscateVmify },
    ];
    for (const step of staticSteps) {
      const res = step.fn(current);
      results.push({ step: step.name, ...res });
      if (res.success && res.result && res.result !== current) current = res.result;
    }
  }

  return { success: results.some(r => r.success), steps: results, finalCode: current };
}

// ════════════════════════════════════════════════════════
//  Prometheus 難読化
// ════════════════════════════════════════════════════════
function obfuscateWithPrometheus(code, options = {}) {
  return new Promise(resolve => {
    const luaBin = checkLua51Available();
    if (!luaBin) { resolve({ success: false, error: 'lua5.1またはLuaJITがインストールされていません' }); return; }

    const cliPath = fs.existsSync(path.join(__dirname, 'prometheus', 'cli.lua'))
      ? path.join(__dirname, 'prometheus', 'cli.lua')
      : path.join(__dirname, 'cli.lua');

    if (!fs.existsSync(cliPath)) {
      resolve({ success: false, error: 'Prometheusが見つかりません' });
      return;
    }

    const tmpIn  = path.join(tempDir, `prom_in_${crypto.randomBytes(8).toString('hex')}.lua`);
    const tmpOut = path.join(tempDir, `prom_out_${crypto.randomBytes(8).toString('hex')}.lua`);
    fs.writeFileSync(tmpIn, code);

    const preset = options.preset || 'Medium';
    const cmd = `${luaBin} ${cliPath} --preset ${preset} ${tmpIn} --out ${tmpOut}`;

    exec(cmd, { timeout: 30000, cwd: path.dirname(cliPath) }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      const errText = (stderr || '').trim();
      try {
        if (err) { resolve({ success: false, error: 'Lua: ' + errText }); return; }
        if (!fs.existsSync(tmpOut)) { resolve({ success: false, error: 'Prometheusが出力ファイルを生成しませんでした。stderr: ' + errText }); return; }
        const result = fs.readFileSync(tmpOut, 'utf8');
        if (!result || result.trim().length === 0) { resolve({ success: false, error: 'Prometheusの出力が空でした' }); return; }
        resolve({ success: true, result, preset });
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    });
  });
}

// ════════════════════════════════════════════════════════
//  カスタムVM難読化
// ════════════════════════════════════════════════════════
function obfuscateWithCustomVM(code, options = {}) {
  return new Promise(resolve => {
    const luaBin = checkLuaAvailable();
    if (!luaBin) { resolve({ success: false, error: 'Luaがインストールされていません' }); return; }

    const vmScript = path.join(__dirname, 'vm_obfuscator.lua');
    if (!fs.existsSync(vmScript)) { resolve({ success: false, error: 'vm_obfuscator.luaが見つかりません' }); return; }

    const seed = options.seed || (Math.floor(Math.random() * 900000) + 100000);
    const tmpIn  = path.join(tempDir, `vm_in_${crypto.randomBytes(8).toString('hex')}.lua`);
    const tmpOut = path.join(tempDir, `vm_out_${crypto.randomBytes(8).toString('hex')}.lua`);
    fs.writeFileSync(tmpIn, code, 'utf8');

    const cmd = `${luaBin} ${vmScript} ${tmpIn} --out ${tmpOut} --seed ${seed}`;

    exec(cmd, { timeout: 30000, cwd: __dirname }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch {}

      const outText = (stdout || '').trim();
      const errText = (stderr || '').trim();

      if (err) { resolve({ success: false, error: 'VM難読化エラー: ' + (errText || err.message) }); return; }
      if (!outText.startsWith('OK:') && !fs.existsSync(tmpOut)) { resolve({ success: false, error: 'VM難読化失敗: ' + (errText || outText || '出力なし') }); return; }

      try {
        if (!fs.existsSync(tmpOut)) { resolve({ success: false, error: '出力ファイルが見つかりません' }); return; }
        const result = fs.readFileSync(tmpOut, 'utf8');
        if (!result || result.trim().length === 0) { resolve({ success: false, error: 'VM難読化の出力が空でした' }); return; }
        resolve({ success: true, result, seed, method: 'custom_vm' });
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    });
  });
}

// ════════════════════════════════════════════════════════
//  フル難読化 API  POST /api/full-obfuscate
// ════════════════════════════════════════════════════════
app.post('/api/full-obfuscate', async (req, res) => {
  const { code, seed } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });

  let current = code;

  const vmRes = await obfuscateWithCustomVM(current, { seed });
  if (vmRes.success && vmRes.result) {
    current = vmRes.result;
  } else {
    return res.json({ success: false, error: 'VM難読化失敗: ' + (vmRes.error || '') });
  }

  const XOR_DEPTH = 36;
  const B64_LAYERS = 10;
  const JUNK_COUNT = 250;

  const masterSeed = seed || (Math.floor(Math.random() * 99999999) + 100000);
  let rngState = masterSeed;
  const rng = () => { rngState = (rngState * 1664525 + 1013904223) % 4294967296; return rngState; };

  const ops = [];
  for (let i = 0; i < XOR_DEPTH; i++) {
    const r = rng();
    ops.push({
      type: Math.floor((r % 100) / 34),
      keyBase: Math.floor((r / 256) % 255) + 1,
      prime: [2,3,5,7,11,13,17,19,23,29,31][Math.floor((r % 1000) / 100)] || 3
    });
  }

  let bytes = Buffer.from(current, 'utf8');
  for (let pass = 0; pass < XOR_DEPTH; pass++) {
    const { type: tp, keyBase: k, prime: p } = ops[pass];
    for (let i = 0; i < bytes.length; i++) {
      const dk = (k * (i + p)) % 256;
      if (tp === 0) bytes[i] = bytes[i] ^ dk;
      else if (tp === 1) bytes[i] = (bytes[i] + dk) % 256;
      else bytes[i] = (bytes[i] - dk + 256) % 256;
    }
  }

  let encoded = bytes.toString('base64');
  for (let i = 1; i < B64_LAYERS; i++) {
    encoded = Buffer.from(encoded).toString('base64');
  }

  const usedVars = new Set();
  const makeVar = () => {
    const starts = ['I','l','O','Il','lI','OI','IO','lO','Ol'];
    const chars  = ['I','l','O','_','1','0'];
    let name;
    do {
      name = starts[Math.floor(Math.random() * starts.length)];
      const len = 10 + Math.floor(Math.random() * 8);
      for (let i = 0; i < len; i++) name += chars[Math.floor(Math.random() * chars.length)];
    } while (usedVars.has(name));
    usedVars.add(name);
    return name;
  };

  const numExpr = (n) => {
    const a = Math.floor(Math.random() * 40) + 2;
    const b = Math.floor(n / a);
    const c = n - a * b;
    return `(${a}*${b}+${c})`;
  };

  const makeJunk = (count) => {
    let out = '';
    for (let i = 0; i < count; i++) {
      const r = Math.random();
      const v = makeVar();
      if (r < 0.3) out += `local ${v}=${numExpr(Math.floor(Math.random()*9999)+1)}\n`;
      else if (r < 0.6) out += `local ${v}=function()return ${numExpr(Math.floor(Math.random()*100))} end\n`;
      else out += `local ${v}={${[1,2,3].map(()=>numExpr(Math.floor(Math.random()*100)+1)).join(',')}}\n`;
    }
    return out;
  };

  const vLib  = makeVar(), vStr = makeVar(), vTbl = makeVar();
  const vMap  = makeVar(), vIdx = makeVar(), vS   = makeVar();
  const vRr   = makeVar(), vPp  = makeVar(), vNn  = makeVar();
  const vAa   = makeVar(), vBb  = makeVar(), vCc  = makeVar(), vDd = makeVar();
  const vAlpha= makeVar(), vParts= makeVar();
  const vLd   = makeVar();
  const vXorFn= makeVar(), vXA  = makeVar(), vXB  = makeVar();
  const vXSeed= makeVar(), vXNxt= makeVar(), vXOps= makeVar();
  const vXPrim= makeVar(), vXI  = makeVar(), vXR  = makeVar();
  const vXTp  = makeVar(), vXKb = makeVar(), vXPr = makeVar();
  const vXPass= makeVar(), vXOp = makeVar(), vXDk = makeVar();
  const vXB2  = makeVar(), vXOut= makeVar(), vXVar= makeVar();
  const vVM2  = makeVar(), vVMSt= makeVar();

  const fullAlpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const aKey = Math.floor(Math.random() * 40) + 5;
  const chunks = [];
  for (let i = 0; i < fullAlpha.length; i += 11) {
    const chunk = fullAlpha.substring(i, i + 11);
    const enc = chunk.split('').map(c => c.charCodeAt(0) + aKey).join(',');
    chunks.push(`(function()local _t={${enc}};local _r={};for _i=1,#_t do _r[_i]=string.char(_t[_i]-${aKey})end;return table.concat(_r)end)()`);
  }

  const sA = Math.floor(Math.random() * 800) + 100;
  const sB = Math.floor(masterSeed / sA);
  const sC = masterSeed - sA * sB;
  const mulA = Math.floor(Math.random() * 900) + 100;
  const mulB = Math.floor(1664525 / mulA);
  const mulC = 1664525 - mulA * mulB;
  const addA = Math.floor(Math.random() * 900) + 100;
  const addB = Math.floor(1013904223 / addA);
  const addC = 1013904223 - addA * addB;

  const xorDecoder = `
local function ${vXorFn}(${vXA},${vXB})
  local _=0
  for _i=0,7 do
    local _a=math.floor(${vXA}/2^_i)%2
    local _b=math.floor(${vXB}/2^_i)%2
    if _a~=_b then _=_+2^_i end
  end
  return _
end
local function ${vXVar}(${vS})
  local ${vXB2}={}
  for ${vXI}=1,#${vS} do ${vXB2}[${vXI}]=string.byte(${vS},${vXI}) end
  local ${vXSeed}=${sA}*${sB}+${sC}
  local function ${vXNxt}() ${vXSeed}=(${vXSeed}*(${mulA}*${mulB}+${mulC})+${addA}*${addB}+${addC})%(2^32);return ${vXSeed} end
  local ${vXOps}={}
  local ${vXPrim}={2,3,5,7,11,13,17,19,23,29,31}
  for ${vXI}=1,${XOR_DEPTH} do
    local ${vXR}=${vXNxt}()
    local ${vXTp}=math.floor((${vXR}%100)/34)
    local ${vXKb}=math.floor((${vXR}/256)%255)+1
    local ${vXPr}=${vXPrim}[math.floor((${vXR}%1000)/100)+1] or 3
    table.insert(${vXOps},{${vXTp},${vXKb},${vXPr}})
  end
  for ${vXPass}=${XOR_DEPTH},1,-1 do
    local ${vXOp}=${vXOps}[${vXPass}]
    local ${vXTp},${vXKb},${vXPr}=${vXOp}[1],${vXOp}[2],${vXOp}[3]
    for ${vXI}=1,#${vXB2} do
      local ${vXDk}=(${vXKb}*(${vXI}+${vXPr}))%256
      if ${vXTp}==0 then ${vXB2}[${vXI}]=${vXorFn}(${vXB2}[${vXI}],${vXDk})
      elseif ${vXTp}==1 then ${vXB2}[${vXI}]=(${vXB2}[${vXI}]-${vXDk}+256)%256
      elseif ${vXTp}==2 then ${vXB2}[${vXI}]=(${vXB2}[${vXI}]+${vXDk})%256 end
    end
  end
  local ${vXOut}={}
  for ${vXI}=1,#${vXB2} do ${vXOut}[${vXI}]=string.char(${vXB2}[${vXI}]) end
  return table.concat(${vXOut})
end
`;

  const b64Decoder = `
local ${vParts}={${chunks.join(',')}}
local ${vAlpha}=table.concat(${vParts})
local ${vMap}={}
for ${vIdx}=1,#${vAlpha} do ${vMap}[string.byte(${vAlpha},${vIdx},${vIdx})]=${vIdx}-1 end
local function ${vLib}(${vS})
  local ${vRr},${vPp},${vNn}={},1,#${vS}
  for ${vIdx}=1,${vNn},4 do
    local ${vAa},${vBb},${vCc},${vDd}=${vMap}[string.byte(${vS},${vIdx},${vIdx})],${vMap}[string.byte(${vS},${vIdx}+1,${vIdx}+1)],${vMap}[string.byte(${vS},${vIdx}+2,${vIdx}+2)],${vMap}[string.byte(${vS},${vIdx}+3,${vIdx}+3)]
    if not ${vAa} or not ${vBb} then break end
    ${vRr}[${vPp}]=string.char((${vAa}*4+math.floor(${vBb}/16))%256) ${vPp}=${vPp}+1
    if not ${vCc} then break end
    ${vRr}[${vPp}]=string.char(((${vBb}%16)*16+math.floor(${vCc}/4))%256) ${vPp}=${vPp}+1
    if not ${vDd} then break end
    ${vRr}[${vPp}]=string.char(((${vCc}%4)*64+${vDd})%256) ${vPp}=${vPp}+1
  end
  return table.concat(${vRr})
end
`;

  const lsKey = Math.floor(Math.random() * 40) + 5;
  const lsEnc = 'loadstring'.split('').map(c => c.charCodeAt(0) + lsKey).join(',');
  const ldRef = `local ${vLd}=(function()local _t={${lsEnc}};local _r={};for _i=1,#_t do _r[_i]=string.char(_t[_i]-${lsKey})end;return rawget(_G,table.concat(_r)) or loadstring end)()`;

  const steps = [];
  for (let i = 0; i < B64_LAYERS; i++) steps.push(`${vStr}=${vLib}(${vStr})`);
  steps.push(`${vStr}=${vXVar}(${vStr})`);
  steps.push(`local _f,_e=${vLd}(${vStr});if _f then _f() else error(_e) end return`);

  let vmDisp = '{';
  for (let i = 0; i < steps.length; i++) {
    vmDisp += `[${i}]=function()${steps[i]} return ${i === steps.length - 1 ? -1 : i + 1}end,`;
  }
  vmDisp += '}';

  const finalLua = `(function()
${makeJunk(Math.floor(JUNK_COUNT / 5))}
${b64Decoder}
${xorDecoder}
${ldRef}
local ${vStr}="${encoded}"
local ${vVMSt}=0
local ${vVM2}=${vmDisp}
while ${vVMSt}~=-1 do ${vVMSt}=${vVM2}[${vVMSt}]()end
end)()`;

  res.json({ success: true, result: finalLua, seed: masterSeed, method: 'full' });
});

// 古い一時ファイルのクリーンアップ
setInterval(() => {
  const now = Date.now();
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const fp = path.join(tempDir, file);
      fs.stat(fp, (err, stats) => {
        if (!err && now - stats.mtimeMs > 10 * 60 * 1000) fs.unlink(fp, () => {});
      });
    });
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🔥 Lua Obfuscator/Deobfuscator Server running on port ${PORT}`);
  console.log(`   Lua:        ${checkLuaAvailable() || 'NOT FOUND'}`);
  console.log(`   Prometheus: ${checkPrometheusAvailable() ? 'OK' : 'NOT FOUND (optional)'}`);
});
