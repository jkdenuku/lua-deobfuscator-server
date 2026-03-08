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

// グローバルエラーハンドラー
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'コードが大きすぎます（最大10MB）' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'サーバー内部エラー' });
});

// temp ディレクトリ
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ════════════════════════════════════════════════════════
//  Lua / Prometheus 確認
// ════════════════════════════════════════════════════════
function checkLuaAvailable() {
  try { execSync('lua -v 2>&1', { timeout: 3000 }); return 'lua'; } catch {}
  try { execSync('luajit -v 2>&1', { timeout: 3000 }); return 'luajit'; } catch {}
  return null;
}

// Prometheus は Lua5.1 専用なので専用バイナリを探す
function checkLua51Available() {
  try { execSync('lua5.1 -v 2>&1', { timeout: 3000 }); return 'lua5.1'; } catch {}
  try { execSync('luajit -v 2>&1', { timeout: 3000 }); return 'luajit'; } catch {}
  // lua5.4 でも一応試す（動かない場合もある）
  try { execSync('lua -v 2>&1', { timeout: 3000 }); return 'lua'; } catch {}
  return null;
}

function checkPrometheusAvailable() {
  return fs.existsSync(path.join(__dirname, 'prometheus', 'cli.lua'))
      || fs.existsSync(path.join(__dirname, 'cli.lua'));
}

// ════════════════════════════════════════════════════════
//  STATUS  GET /api/status
// ════════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    lua: checkLuaAvailable() || 'not installed',
    prometheus: checkPrometheusAvailable() ? 'available' : 'not found',
    deobfuscateMethods: ['auto','advanced_static','eval_expressions','split_strings','xor','constant_array','dynamic','vmify','char_decoder','xor_decoder','math_eval','constant_call','str_transform','dead_branch','junk_clean','vm_detect','vm_extract','base64_detect'],
    obfuscatePresets:   ['Minify', 'Weak', 'Medium', 'Strong'],
    obfuscateSteps:     ['SplitStrings', 'EncryptStrings', 'ConstantArray', 'ProxifyLocals', 'WrapInFunction', 'Vmify'],
  });
});

// ════════════════════════════════════════════════════════
//  解読 API  POST /api/deobfuscate
// ════════════════════════════════════════════════════════
app.post('/api/deobfuscate', async (req, res) => {
  const { code, method } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });

  let result;
  switch (method) {
    case 'xor':             result = xorDecoder(code);                break;
    case 'split_strings':   result = deobfuscateSplitStrings(code);   break;
    case 'encrypt_strings': result = deobfuscateEncryptStrings(code); break;
    case 'constant_array':  result = constantArrayResolver(code);     break;
    case 'eval_expressions':result = evaluateExpressions(code);       break;
    case 'advanced_static': result = advancedStaticDeobfuscate(code); break;
    case 'char_decoder':    result = charDecoder(code);               break;
    case 'xor_decoder':     result = xorDecoder(code);                break;
    case 'math_eval':       result = mathEvaluator(code);             break;
    case 'constant_call':   result = constantCallEvaluator(code);     break;
    case 'str_transform':   result = stringTransformDecoder(code);    break;
    case 'dead_branch':     result = deadBranchRemover(code);         break;
    case 'junk_clean':      result = junkAssignmentCleaner(code);     break;
    case 'vm_detect':       result = { ...vmDetector(code), success: vmDetector(code).isVm }; break;
    case 'vm_extract':      result = vmBytecodeExtractor(code);       break;
    case 'base64_detect':   result = base64Detector(code, new CapturePool()); break;
    case 'vmify':           result = deobfuscateVmify(code);          break;
    case 'dynamic':         result = await tryDynamicExecution(code); break;
    case 'auto':
    default:                result = await autoDeobfuscate(code);    break;
  }

  res.json(result);
});

// 後方互換 (旧エンドポイント)
app.post('/deobfuscate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(deobfuscateXOR(code));
});

// ════════════════════════════════════════════════════════
//  難読化 API  POST /api/obfuscate  (Prometheus)
// ════════════════════════════════════════════════════════
app.post('/api/obfuscate', async (req, res) => {
  const { code, preset, steps } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await obfuscateWithPrometheus(code, { preset, steps }));
});

// ════════════════════════════════════════════════════════
//  VM難読化 API  POST /api/vm-obfuscate
// ════════════════════════════════════════════════════════
app.post('/api/vm-obfuscate', async (req, res) => {
  const { code, seed } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await obfuscateWithCustomVM(code, { seed }));
});


// ════════════════════════════════════════════════════════
//  動的実行  —  Renderサーバー上のLuaを最大限活用
//
//  方針:
//   1. まず動的実行を試みる（これがメイン）
//   2. 動的実行が失敗した場合のみ静的解析にフォールバック
//   3. 多段難読化に対応（動的実行の結果を再帰的に動的実行）
//   4. アンチダンプ・アンチデバッグを無効化してから実行
// ════════════════════════════════════════════════════════
async function tryDynamicExecution(code) {
  const luaBin = checkLuaAvailable();
  if (!luaBin) return { success: false, error: 'Luaがインストールされていません', method: 'dynamic' };

  // #12 sandboxFilter — 危険関数除去 + サイズ制限
  const filtered = sandboxFilter(code);
  if (!filtered.safe) return { success: false, error: filtered.reason, method: 'dynamic' };
  if (filtered.removed.length > 0)
    console.log('[Dynamic] 危険関数を除去:', filtered.removed.join(', '));

  const safeCode = filtered.code.replace(/\]\]/g, '] ]');
  const tempFile = path.join(tempDir, `obf_${Date.now()}_${Math.random().toString(36).substring(7)}.lua`);

  const wrapper = `
-- ══════════════════════════════════════════
--  YAJU Deobfuscator - Dynamic Execution Wrapper
-- ══════════════════════════════════════════

-- 全キャプチャを格納するテーブル（多段対応）
local __captures = {}
local __capture_count = 0
local __original_loadstring = loadstring or load
local __original_load = load or loadstring

-- アンチダンプ・アンチデバッグを無効化
pcall(function()
  if debug then
    debug.sethook = function() end
    debug.getinfo = nil
    debug.getlocal = nil
    debug.setlocal = nil
    debug.getupvalue = nil
    debug.setupvalue = nil
  end
end)
pcall(function()
  if getfenv then
    local env = getfenv()
    env.saveinstance = nil
    env.dumpstring = nil
    env.save_instance = nil
  end
end)

-- loadstring / load を完全フック
local function __hook(code_str, ...)
  if type(code_str) == "string" and #code_str > 20 then
    __capture_count = __capture_count + 1
    __captures[__capture_count] = code_str
  end
  return __original_loadstring(code_str, ...)
end

_G.loadstring = __hook
_G.load       = __hook
if rawset then
  pcall(function() rawset(_G, "loadstring", __hook) end)
  pcall(function() rawset(_G, "load", __hook) end)
end

-- 難読化コードを実行
local __obf_code = [[
${safeCode}
]]

local __ok, __err = pcall(function()
  local chunk, err = __original_loadstring(__obf_code)
  if not chunk then error("parse error: " .. tostring(err)) end
  chunk()
end)

-- キャプチャ結果を出力（最後にキャプチャされたものが最も解読されたもの）
if __capture_count > 0 then
  -- 最も長い（＝最も展開された）コードを選択
  local best = __captures[1]
  for i = 2, __capture_count do
    if #__captures[i] > #best then best = __captures[i] end
  end
  io.write("__CAPTURED_START__")
  io.write(best)
  io.write("__CAPTURED_END__")
  -- 多段情報も出力
  if __capture_count > 1 then
    io.write("__LAYERS__:" .. tostring(__capture_count))
  end
else
  io.write("__NO_CAPTURE__")
  if not __ok then
    io.write("__ERROR__:" .. tostring(__err))
  end
end
`;

  return new Promise(resolve => {
    fs.writeFileSync(tempFile, wrapper, 'utf8');

    // #13 timeout=15秒, maxBuffer=5MB に制限して無限ループ・大量出力を防止
    exec(`${luaBin} ${tempFile}`, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch {}

      // キャプチャ成功
      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const start    = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const end      = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(start, end).trim();

        if (captured && captured.length > 5) {
          // 多段レイヤー数を取得
          const layerMatch = stdout.match(/__LAYERS__:(\d+)/);
          const layers = layerMatch ? parseInt(layerMatch[1]) : 1;
          return resolve({ success: true, result: captured, layers, method: 'dynamic' });
        }
      }

      // エラー情報
      if (stdout.includes('__ERROR__:')) {
        const errMsg = stdout.split('__ERROR__:')[1] || '';
        return resolve({ success: false, error: 'Luaエラー: ' + errMsg.substring(0, 300), method: 'dynamic' });
      }

      if (error && stderr) {
        return resolve({ success: false, error: '実行エラー: ' + stderr.substring(0, 300), method: 'dynamic' });
      }

      resolve({ success: false, error: 'loadstring()が呼ばれませんでした（VM系難読化の可能性）', method: 'dynamic' });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
//  YAJU Deobfuscator Engine v3
//  全20項目実装版
// ════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
//  #19  seenCodeCache  — SHA1ハッシュによる重複解析防止
// ────────────────────────────────────────────────────────────────────────
const _seenCodeCache = new Map(); // hash -> result
function cacheHash(code) {
  return require('crypto').createHash('sha1').update(code).digest('hex');
}
function cacheGet(code) { return _seenCodeCache.get(cacheHash(code)) || null; }
function cacheSet(code, result) {
  const h = cacheHash(code);
  if (_seenCodeCache.size > 500) {
    // LRU簡易: 古いエントリを半分削除
    const keys = [..._seenCodeCache.keys()].slice(0, 250);
    keys.forEach(k => _seenCodeCache.delete(k));
  }
  _seenCodeCache.set(h, result);
}

// ────────────────────────────────────────────────────────────────────────
//  #20  capturePool  — 解析途中の文字列・コードを蓄積して再利用
// ────────────────────────────────────────────────────────────────────────
class CapturePool {
  constructor() { this.entries = []; }
  add(code, source) {
    if (code && code.length > 5 && !this.entries.some(e => e.code === code))
      this.entries.push({ code, source, ts: Date.now() });
  }
  getLuaCandidates() {
    return this.entries
      .filter(e => scoreLuaCode(e.code) > 20)
      .sort((a, b) => scoreLuaCode(b.code) - scoreLuaCode(a.code));
  }
  getBest() {
    const cands = this.getLuaCandidates();
    return cands.length ? cands[0].code : null;
  }
}

// ────────────────────────────────────────────────────────────────────────
//  共通ユーティリティ  (v2から引継ぎ + 拡張)
// ────────────────────────────────────────────────────────────────────────
function scoreLuaCode(code) {
  if (!code || typeof code !== 'string') return 0;
  const keywords = ['local','function','end','if','then','else','return','for','do',
    'while','and','or','not','nil','true','false','print','table','string','math'];
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

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 4096); i++)
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(16);
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
        cur += content.substring(i, end + 2); i = end + 2; continue;
      }
      else if (c === '{') { depth++; cur += c; }
      else if (c === '}') { depth--; cur += c; }
      else if (c === ',' && depth === 0) { elements.push(cur.trim()); cur = ''; }
      else { cur += c; }
    } else {
      if (c === '\\') { cur += c + (content[i+1] || ''); i += 2; continue; }
      if (c === strChar) inStr = false;
      cur += c;
    }
    i++;
  }
  if (cur.trim()) elements.push(cur.trim());
  return elements;
}

function resolveLuaStringEscapes(str) {
  return str
    .replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\r/g,'\r')
    .replace(/\\\\/g,'\\').replace(/\\"/g,'"').replace(/\\'/g,"'")
    .replace(/\\x([0-9a-fA-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/\\(\d{1,3})/g,(_,d)=>String.fromCharCode(parseInt(d,10)));
}

function stripLuaString(tok) {
  tok = (tok||'').trim();
  if ((tok.startsWith('"')&&tok.endsWith('"'))||(tok.startsWith("'")&&tok.endsWith("'"))) {
    try { return resolveLuaStringEscapes(tok.slice(1,-1)); } catch { return null; }
  }
  if (tok.startsWith('[[')&&tok.endsWith(']]')) return tok.slice(2,-2);
  return null;
}

function splitByComma(src) {
  const parts=[]; let cur='',depth=0,inStr=false,strCh='';
  for (let i=0;i<src.length;i++) {
    const c=src[i];
    if (!inStr) {
      if (c==='"'||c==="'") { inStr=true; strCh=c; cur+=c; }
      else if (c==='('||c==='{'||c==='[') { depth++; cur+=c; }
      else if (c===')'||c==='}'||c===']') { depth--; cur+=c; }
      else if (c===','&&depth===0) { parts.push(cur.trim()); cur=''; }
      else cur+=c;
    } else {
      if (c==='\\') { cur+=c+(src[i+1]||''); i++; continue; }
      if (c===strCh) inStr=false;
      cur+=c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function splitByConcat(src) {
  const parts=[]; let cur='',depth=0,inStr=false,strCh=''; let i=0;
  while (i<src.length) {
    const c=src[i];
    if (!inStr) {
      if (c==='"'||c==="'") { inStr=true; strCh=c; cur+=c; i++; continue; }
      if (c==='['&&src[i+1]==='[') {
        let end=src.indexOf(']]',i+2); if (end===-1) end=src.length-2;
        cur+=src.slice(i,end+2); i=end+2; continue;
      }
      if (c==='('||c==='{'||c==='[') { depth++; cur+=c; i++; continue; }
      if (c===')'||c==='}'||c===']') { depth--; cur+=c; i++; continue; }
      if (depth===0&&c==='.'&&src[i+1]==='.') {
        parts.push(cur.trim()); cur=''; i+=2;
        if (src[i]==='.') i++;
        continue;
      }
    } else {
      if (c==='\\') { cur+=c+(src[i+1]||''); i+=2; continue; }
      if (c===strCh) inStr=false;
    }
    cur+=c; i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ────────────────────────────────────────────────────────────────────────
//  Lua数値式パーサー  (evalLuaNumExpr — v2から引継ぎ)
// ────────────────────────────────────────────────────────────────────────
function evalLuaNumExpr(expr) {
  const src=(expr||'').trim(); if (!src) return null;
  let pos=0;
  const peek=()=>pos<src.length?src[pos]:'';
  const consume=()=>pos<src.length?src[pos++]:'';
  const skipWs=()=>{ while(pos<src.length&&/\s/.test(src[pos]))pos++; };
  function parseExpr(){ return parseAddSub(); }
  function parseAddSub(){
    let l=parseMulDiv(); if(l===null)return null; skipWs();
    while(peek()==='+' || peek()==='-'){
      const op=consume(); skipWs(); const r=parseMulDiv(); if(r===null)return null;
      l=op==='+'?l+r:l-r; skipWs();
    }
    return l;
  }
  function parseMulDiv(){
    let l=parsePow(); if(l===null)return null; skipWs();
    while(peek()==='*'||peek()==='/'||peek()==='%'){
      const op=consume(); skipWs(); const r=parsePow(); if(r===null)return null;
      if(op==='*')l=l*r;
      else if(op==='/'){if(r===0)return null; l=Math.floor(l/r);}
      else{if(r===0)return null; l=((l%r)+r)%r;}
      skipWs();
    }
    return l;
  }
  function parsePow(){
    let b=parseUnary(); if(b===null)return null; skipWs();
    if(peek()==='^'){ consume(); skipWs(); const e=parseUnary(); if(e===null)return null; b=Math.pow(b,e); }
    return b;
  }
  function parseUnary(){
    skipWs();
    if(peek()==='-'){ consume(); skipWs(); const v=parseAtom(); return v===null?null:-v; }
    if(peek()==='+') consume();
    return parseAtom();
  }
  function parseAtom(){
    skipWs();
    if(peek()==='('){ consume(); const v=parseExpr(); skipWs(); if(peek()===')') consume(); return v; }
    if(src.startsWith('math.',pos)){
      pos+=5; let fname='';
      while(pos<src.length&&/[a-z]/.test(src[pos])) fname+=src[pos++];
      skipWs(); if(peek()!=='(') return null; consume();
      const args=[]; skipWs();
      while(peek()!==')'&&pos<src.length){ const a=parseExpr(); if(a===null)return null; args.push(a); skipWs(); if(peek()===','){consume();skipWs();} }
      if(peek()===')') consume();
      if(fname==='floor') return Math.floor(args[0]??0);
      if(fname==='ceil')  return Math.ceil(args[0]??0);
      if(fname==='abs')   return Math.abs(args[0]??0);
      if(fname==='max')   return args.length?Math.max(...args):null;
      if(fname==='min')   return args.length?Math.min(...args):null;
      if(fname==='sqrt')  return Math.sqrt(args[0]??0);
      return null;
    }
    if(src[pos]==='0'&&(src[pos+1]==='x'||src[pos+1]==='X')){
      pos+=2; let h='';
      while(pos<src.length&&/[0-9a-fA-F]/.test(src[pos])) h+=src[pos++];
      const n=parseInt(h,16); return isNaN(n)?null:n;
    }
    let numStr='';
    while(pos<src.length&&/[0-9.]/.test(src[pos])) numStr+=src[pos++];
    if(numStr===''||numStr==='.') return null;
    const n=parseFloat(numStr); return isNaN(n)?null:n;
  }
  try {
    const result=parseExpr(); skipWs();
    if(result===null||!isFinite(result)) return null;
    if(pos<src.length) return null;
    return result;
  } catch { return null; }
}
function evalSimpleExpr(expr) {
  const r=evalLuaNumExpr(expr); if(r===null)return null;
  return Number.isInteger(r)?r:Math.floor(r);
}

// ────────────────────────────────────────────────────────────────────────
//  SymbolicEnv  (v2から引継ぎ)
// ────────────────────────────────────────────────────────────────────────
class SymbolicEnv {
  constructor(parent=null){ this.vars=new Map(); this.parent=parent; }
  get(name){ if(this.vars.has(name))return this.vars.get(name); if(this.parent)return this.parent.get(name); return null; }
  set(name,entry){ this.vars.set(name,entry); }
  child(){ return new SymbolicEnv(this); }
}

function evalStringChar(argsStr,env) {
  const args=splitByComma(argsStr); const chars=[];
  for(const a of args){
    const val=evalExprWithEnv(a.trim(),env);
    if(val===null||typeof val!=='number') return null;
    const code=Math.round(val); if(code<0||code>255) return null;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function evalArithWithEnv(expr,env){
  if(!env) return evalLuaNumExpr(expr);
  let resolved=expr.replace(/\b([a-zA-Z_]\w*)\b/g,(m)=>{
    if(/^(math)$/.test(m)) return m;
    const entry=env?env.get(m):null;
    if(entry&&entry.type==='num') return String(entry.value);
    return m;
  });
  if(/[a-zA-Z_]/.test(resolved.replace(/math\./g,''))) return null;
  return evalLuaNumExpr(resolved);
}

function evalExprWithEnv(expr,env){
  if(!expr) return null; expr=expr.trim();
  const strVal=stripLuaString(expr); if(strVal!==null) return strVal;
  if(expr==='true') return 1; if(expr==='false'||expr==='nil') return 0;
  if(/^[\d\s\+\-\*\/\%\(\)\.\^x0-9a-fA-FxX]+$/.test(expr)||/^[\-\+]?\s*math\./.test(expr)){
    const n=evalLuaNumExpr(expr); if(n!==null) return n;
  }
  const scMatch=expr.match(/^string\.char\((.+)\)$/s);
  if(scMatch) return evalStringChar(scMatch[1],env);
  const tsMatch=expr.match(/^tostring\((.+)\)$/s);
  if(tsMatch){ const v=evalExprWithEnv(tsMatch[1],env); if(v!==null) return String(v); }
  const tnMatch=expr.match(/^tonumber\((.+?)(?:,\s*(\d+))?\)$/s);
  if(tnMatch){
    const v=evalExprWithEnv(tnMatch[1],env);
    if(typeof v==='string'){ const base=tnMatch[2]?parseInt(tnMatch[2]):10; const n=parseInt(v,base); if(!isNaN(n)) return n; }
    if(typeof v==='number') return v;
  }
  const repMatch=expr.match(/^string\.rep\((.+?),\s*(\d+)\)$/s);
  if(repMatch){ const s=evalExprWithEnv(repMatch[1],env); const n=parseInt(repMatch[2]); if(typeof s==='string'&&!isNaN(n)) return s.repeat(n); }
  const subMatch=expr.match(/^string\.sub\((.+?),\s*(-?\d+)(?:,\s*(-?\d+))?\)$/s);
  if(subMatch){
    const s=evalExprWithEnv(subMatch[1],env);
    if(typeof s==='string'){
      let i=parseInt(subMatch[2]),j=subMatch[3]!==undefined?parseInt(subMatch[3]):s.length;
      if(i<0) i=Math.max(0,s.length+i+1); if(j<0) j=s.length+j+1;
      return s.slice(i-1,j);
    }
  }
  const revMatch=expr.match(/^string\.reverse\((.+)\)$/s);
  if(revMatch){ const s=evalExprWithEnv(revMatch[1],env); if(typeof s==='string') return s.split('').reverse().join(''); }
  const byteMatch=expr.match(/^string\.byte\((.+?),\s*(\d+)(?:,\s*\d+)?\)$/s);
  if(byteMatch){ const s=evalExprWithEnv(byteMatch[1],env); const i=parseInt(byteMatch[2]); if(typeof s==='string'&&i>=1&&i<=s.length) return s.charCodeAt(i-1); }
  const tcMatch=expr.match(/^table\.concat\((\w+)(?:,\s*(.+?))?\)$/s);
  if(tcMatch&&env){
    const tbl=env.get(tcMatch[1]);
    if(tbl&&tbl.type==='table'&&Array.isArray(tbl.value)){
      const sep=tcMatch[2]?(evalExprWithEnv(tcMatch[2],env)??''):'';
      if(typeof sep==='string'){
        const parts=tbl.value.map(v=>typeof v==='string'?v:typeof v==='number'?String(v):null);
        if(parts.every(p=>p!==null)) return parts.join(sep);
      }
    }
  }
  const gfMatch=expr.match(/^(?:getfenv\(\)|_G)\s*\[\s*(.+?)\s*\]$/s);
  if(gfMatch){ const key=evalExprWithEnv(gfMatch[1],env); if(typeof key==='string') return key; }
  const rawgetMatch=expr.match(/^rawget\s*\(\s*(?:_G|getfenv\(\))\s*,\s*(.+?)\s*\)$/s);
  if(rawgetMatch){ const key=evalExprWithEnv(rawgetMatch[1],env); if(typeof key==='string') return key; }
  const concatParts=splitByConcat(expr);
  if(concatParts.length>1){
    const resolved=concatParts.map(p=>evalExprWithEnv(p.trim(),env));
    if(resolved.every(v=>v!==null)) return resolved.map(String).join('');
  }
  if(env&&/^\w+$/.test(expr)){ const entry=env.get(expr); if(entry&&(entry.type==='num'||entry.type==='str')) return entry.value; }
  const arrMatch=expr.match(/^(\w+)\[(.+)\]$/);
  if(arrMatch&&env){
    const tbl=env.get(arrMatch[1]);
    if(tbl&&tbl.type==='table'&&Array.isArray(tbl.value)){
      const idx=evalExprWithEnv(arrMatch[2],env);
      if(typeof idx==='number'){ const v=tbl.value[Math.round(idx)-1]; if(v!==undefined) return v; }
    }
  }
  const numResult=evalArithWithEnv(expr,env); if(numResult!==null) return numResult;
  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  #1  autoDeobfuscate 処理順は後述 — まず全パスを実装
// ════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
//  #2  evaluateExpressions  — Lua定数式を正規表現で検出して評価
// ────────────────────────────────────────────────────────────────────────
function evaluateExpressions(code) {
  let modified=code, found=false;
  let prev, iters=0;
  do {
    prev=modified;
    // 括弧内の純粋数値式（文字列外）
    modified=modified.replace(/\(([^()'"\n]{1,120})\)/g,(match,inner)=>{
      if(/["']/.test(inner)) return match;
      const v=evalLuaNumExpr(inner);
      if(v===null||!Number.isInteger(v)) return match;
      if(String(v)===inner.trim()) return match;
      found=true; return String(v);
    });
    // 代入右辺の裸の数値算術
    modified=modified.replace(/(=\s*)([0-9][0-9\s\+\-\*\/\%\^\(\)\.]*[0-9])/g,(match,eq,expr)=>{
      if(/[a-zA-Z]/.test(expr)) return match;
      const v=evalLuaNumExpr(expr);
      if(v===null||!Number.isInteger(v)) return match;
      if(String(v)===expr.trim()) return match;
      found=true; return eq+String(v);
    });
    // 配列インデックス内の式
    modified=modified.replace(/\[\s*([0-9][0-9\s\+\-\*\/\%\^\(\)\.]*)\s*\]/g,(match,expr)=>{
      const v=evalLuaNumExpr(expr); if(v===null||!Number.isInteger(v)) return match;
      if(String(v)===expr.trim()) return match;
      found=true; return `[${v}]`;
    });
  } while(modified!==prev&&++iters<30);
  if(!found) return { success:false, error:'評価できる定数式がありませんでした', method:'eval_expressions' };
  return { success:true, result:modified, method:'eval_expressions' };
}

// ────────────────────────────────────────────────────────────────────────
//  #3  splitStrings  — 連続文字列連結を1つにまとめる
// ────────────────────────────────────────────────────────────────────────
function deobfuscateSplitStrings(code) {
  let modified=code, found=false;
  let prev, iters=0;
  do {
    prev=modified;
    // 任意の組み合わせ
    modified=modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.]*)*)"/g,(_,a,b)=>{ found=true; return `"${a}${b}"`; });
    modified=modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.]*)*)'/g,(_,a,b)=>{ found=true; return `'${a}${b}'`; });
    modified=modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*'((?:[^'\\]|\\.]*)*)'/g,(_,a,b)=>{ found=true; return `"${a}${b}"`; });
    modified=modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*"((?:[^"\\]|\\.]*)*)"/g,(_,a,b)=>{ found=true; return `"${a}${b}"`; });
  } while(modified!==prev&&++iters<80);
  if(!found) return { success:false, error:'SplitStringsパターンが見つかりません', method:'split_strings' };
  return { success:true, result:modified, method:'split_strings' };
}

// ────────────────────────────────────────────────────────────────────────
//  #4  charDecoder  — string.char(n,n,...) を文字列へ復元
// ────────────────────────────────────────────────────────────────────────
function charDecoder(code, env) {
  env=env||new SymbolicEnv();
  let modified=code, found=false;
  // まず定数式を畳み込む
  modified=modified.replace(/string\.char\(([^)]+)\)/g,(match,argsStr)=>{
    const val=evalStringChar(argsStr,env); if(val===null) return match;
    const esc=val.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\0/g,'\\0');
    found=true; return `"${esc}"`;
  });
  if(!found) return { success:false, error:'string.charパターンが見つかりません', method:'char_decoder' };
  return { success:true, result:modified, method:'char_decoder' };
}

// ────────────────────────────────────────────────────────────────────────
//  #5  xorDecoder  — string.char(x^y) や bit.bxor(x,y) パターンのXOR復号
// ────────────────────────────────────────────────────────────────────────
function xorDecoder(code) {
  let modified=code, found=false;

  // string.char(a ~ b) — Lua5.3以降の ~ 演算子
  modified=modified.replace(/string\.char\((\d+)\s*~\s*(\d+)\)/g,(_,a,b)=>{
    const v=parseInt(a)^parseInt(b); found=true;
    return `string.char(${v})`;
  });

  // bit.bxor(a, b) パターン
  modified=modified.replace(/bit\.bxor\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g,(_,a,b)=>{
    found=true; return String(parseInt(a)^parseInt(b));
  });

  // string.char(x ^ y) — Lua5.3 XOR
  modified=modified.replace(/\b(\d+)\s*\^\s*(\d+)\b/g,(match,a,b)=>{
    // ^ がべき乗ではなくXORとして使われているかを判断
    // 両方255以下なら XOR として扱う（べき乗なら結果が大きすぎる）
    const ia=parseInt(a),ib=parseInt(b);
    if(ia<=255&&ib<=255){ found=true; return String(ia^ib); }
    return match;
  });

  // XOR配列ブルートフォース (既存コード)
  const xorRes=deobfuscateXOR(code);
  if(xorRes.success) return { ...xorRes, method:'xor_decoder' };

  if(!found) return { success:false, error:'XORパターンが見つかりません', method:'xor_decoder' };
  return { success:true, result:modified, method:'xor_decoder' };
}

// XOR配列ブルートフォース（後方互換）
function deobfuscateXOR(code) {
  function xorByte(b,k){ let r=0; for(let i=0;i<8;i++){const a=(b>>i)&1,bk=(k>>i)&1; if(a!==bk)r|=(1<<i);} return r; }
  const patterns=[/local\s+\w+\s*=\s*\{([0-9,\s]+)\}/g,/\{([0-9,\s]+)\}/g];
  let encryptedArrays=[];
  for(const pattern of patterns){
    let match; const p=new RegExp(pattern.source,pattern.flags);
    while((match=p.exec(code))!==null){
      const nums=match[1].split(',').map(n=>parseInt(n.trim())).filter(n=>!isNaN(n));
      if(nums.length>3) encryptedArrays.push(nums);
    }
    if(encryptedArrays.length>0) break;
  }
  if(encryptedArrays.length===0) return { success:false, error:'暗号化配列が見つかりません', method:'xor' };
  let bestResult=null,bestScore=-1,bestKey=-1;
  for(const arr of encryptedArrays){
    for(let key=0;key<=255;key++){
      const str=arr.map(b=>String.fromCharCode(xorByte(b,key))).join('');
      const score=scoreLuaCode(str);
      if(score>bestScore){ bestScore=score; bestResult=str; bestKey=key; }
    }
  }
  if(bestScore<10) return { success:false, error:'有効なLuaコードが見つかりませんでした', method:'xor' };
  return { success:true, result:bestResult, key:bestKey, score:bestScore, method:'xor' };
}

// ────────────────────────────────────────────────────────────────────────
//  #6  constantArrayResolver  — local t={...} の t[i] を直接値へ置換
// ────────────────────────────────────────────────────────────────────────
function constantArrayResolver(code, env) {
  env=env||new SymbolicEnv();
  let modified=code, found=false;
  let passCount=0;
  while(passCount++<12){
    let changed=false;
    const arrayPattern=/local\s+(\w+)\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match; const snapshot=modified;
    while((match=arrayPattern.exec(snapshot))!==null){
      const varName=match[1],content=match[2];
      const elements=parseLuaArrayElements(content);
      if(elements.length<1) continue;
      const values=elements.map(e=>{
        const n=evalLuaNumExpr(e.trim()); if(n!==null) return n;
        const s=stripLuaString(e.trim()); if(s!==null) return s;
        return null;
      });
      if(values.some(v=>v===null)) continue;
      env.set(varName,{type:'table',value:values});
      const esc=varName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const indexRe=new RegExp(esc+'\\[([^\\]]+)\\]','g');
      modified=modified.replace(indexRe,(fullMatch,indexExpr)=>{
        const idx=evalExprWithEnv(indexExpr,env);
        if(idx===null||typeof idx!=='number') return fullMatch;
        const rounded=Math.round(idx);
        if(rounded<1||rounded>values.length) return fullMatch;
        found=true; changed=true;
        const v=values[rounded-1];
        if(typeof v==='string') return `"${v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
        return String(v);
      });
    }
    if(!changed) break;
  }
  if(!found) return { success:false, error:'ConstantArrayパターンが見つかりません', method:'constant_array' };
  return { success:true, result:modified, method:'constant_array' };
}
// 後方互換
function deobfuscateConstantArray(code){ return constantArrayResolver(code); }

// ────────────────────────────────────────────────────────────────────────
//  #7  constantCallEvaluator  — tonumber/tostring の定数呼び出しを変換
// ────────────────────────────────────────────────────────────────────────
function constantCallEvaluator(code) {
  let modified=code, found=false;
  // tonumber("123") -> 123, tonumber("0xff") -> 255
  modified=modified.replace(/\btonumber\s*\(\s*"([^"]+)"\s*(?:,\s*(\d+))?\s*\)/g,(_,s,base)=>{
    const n=parseInt(s,base?parseInt(base):10);
    if(isNaN(n)) return _;
    found=true; return String(n);
  });
  modified=modified.replace(/\btonumber\s*\(\s*'([^']+)'\s*(?:,\s*(\d+))?\s*\)/g,(_,s,base)=>{
    const n=parseInt(s,base?parseInt(base):10);
    if(isNaN(n)) return _;
    found=true; return String(n);
  });
  // tostring(123) -> "123"
  modified=modified.replace(/\btostring\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g,(_,n)=>{
    found=true; return `"${n}"`;
  });
  if(!found) return { success:false, error:'tonumber/tostringの定数呼び出しが見つかりません', method:'constant_call' };
  return { success:true, result:modified, method:'constant_call' };
}

// ────────────────────────────────────────────────────────────────────────
//  #8  mathEvaluator  — math.* の引数が定数なら結果に置換
// ────────────────────────────────────────────────────────────────────────
function mathEvaluator(code) {
  let modified=code, found=false;
  const fns=['floor','ceil','abs','sqrt','max','min'];
  for(const fn of fns){
    const re=new RegExp(`math\\.${fn}\\s*\\(([^)]+)\\)`,'g');
    modified=modified.replace(re,(match,args)=>{
      const argList=splitByComma(args).map(a=>evalLuaNumExpr(a.trim()));
      if(argList.some(v=>v===null)) return match;
      let result;
      if(fn==='floor') result=Math.floor(argList[0]);
      else if(fn==='ceil') result=Math.ceil(argList[0]);
      else if(fn==='abs') result=Math.abs(argList[0]);
      else if(fn==='sqrt') result=Math.sqrt(argList[0]);
      else if(fn==='max') result=Math.max(...argList);
      else if(fn==='min') result=Math.min(...argList);
      if(result===undefined||!isFinite(result)) return match;
      found=true;
      return Number.isInteger(result)?String(result):result.toFixed(6);
    });
  }
  if(!found) return { success:false, error:'math.*の定数呼び出しが見つかりません', method:'math_eval' };
  return { success:true, result:modified, method:'math_eval' };
}

// ────────────────────────────────────────────────────────────────────────
//  #9  deadBranchRemover  — if true/false の不要分岐を削除
// ────────────────────────────────────────────────────────────────────────
function deadBranchRemover(code) {
  let modified=code, found=false;
  // if true then ... end  → 中身だけ残す
  modified=modified.replace(/\bif\s+true\s+then\s+([\s\S]*?)\s*end\b/g,(_,body)=>{ found=true; return body.trim(); });
  // if false then ... end  → 完全削除
  modified=modified.replace(/\bif\s+false\s+then\s+[\s\S]*?\s*end\b/g,()=>{ found=true; return ''; });
  // if true then ... else ... end → then節だけ残す
  modified=modified.replace(/\bif\s+true\s+then\s+([\s\S]*?)\s*else\s+[\s\S]*?\s*end\b/g,(_,thenPart)=>{ found=true; return thenPart.trim(); });
  // if false then ... else ... end → else節だけ残す
  modified=modified.replace(/\bif\s+false\s+then\s+[\s\S]*?\s*else\s+([\s\S]*?)\s*end\b/g,(_,elsePart)=>{ found=true; return elsePart.trim(); });
  // while false do ... end → 削除
  modified=modified.replace(/\bwhile\s+false\s+do\s+[\s\S]*?\s*end\b/g,()=>{ found=true; return ''; });
  // repeat ... until true → 1回実行（内容だけ残す）
  modified=modified.replace(/\brepeat\s+([\s\S]*?)\s*until\s+true\b/g,(_,body)=>{ found=true; return body.trim(); });
  if(!found) return { success:false, error:'デッドブランチが見つかりません', method:'dead_branch' };
  return { success:true, result:modified, method:'dead_branch' };
}

// ────────────────────────────────────────────────────────────────────────
//  #10  junkAssignmentCleaner  — 無意味代入・自己代入を削除
// ────────────────────────────────────────────────────────────────────────
function junkAssignmentCleaner(code) {
  let modified=code, found=false;
  // local a = a  (自己代入)
  modified=modified.replace(/local\s+(\w+)\s*=\s*\1\s*[\n;]/g,(_,name)=>{ found=true; return ''; });
  // local _ = ... (アンダースコア変数への代入)
  modified=modified.replace(/local\s+_\s*=\s*[^\n;]+[\n;]/g,()=>{ found=true; return ''; });
  // 連続する空行を1行に圧縮
  modified=modified.replace(/\n{3,}/g,'\n\n');
  if(!found) return { success:false, error:'ジャンク代入が見つかりません', method:'junk_clean' };
  return { success:true, result:modified, method:'junk_clean' };
}

// ────────────────────────────────────────────────────────────────────────
//  #11  duplicateConstantReducer  — 重複定数を1つにまとめる
// ────────────────────────────────────────────────────────────────────────
function duplicateConstantReducer(code) {
  let modified=code, found=false;
  // 同じ string.char(...) が3回以上出現する場合に変数化
  const scMap=new Map();
  modified.replace(/string\.char\([^)]+\)/g,m=>{ scMap.set(m,(scMap.get(m)||0)+1); });
  for(const [expr,count] of scMap) {
    if(count<3) continue;
    const varName=`_sc${Math.abs(hashCode(expr)&0xffff).toString(16)}`;
    // 変数宣言を先頭に追加し、使用箇所を置換
    const escapedExpr=expr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(escapedExpr,'g');
    if(re.test(modified)){
      modified=`local ${varName}=${expr}\n`+modified.replace(re,varName);
      found=true;
    }
  }
  if(!found) return { success:false, error:'重複定数が見つかりません', method:'dup_reduce' };
  return { success:true, result:modified, method:'dup_reduce' };
}

// ────────────────────────────────────────────────────────────────────────
//  #12  sandboxFilter  — 危険関数除去 + サイズ制限
// ────────────────────────────────────────────────────────────────────────
const MAX_DYNAMIC_SIZE = 512 * 1024; // 512KB
const DANGEROUS_PATTERNS = [
  /\bos\.execute\s*\(/g,
  /\bio\.popen\s*\(/g,
  /\bio\.open\s*\([^,)]+,\s*["']w/g,
  /\brequire\s*\(\s*["']socket/g,
  /\bloadfile\s*\(/g,
  /\bdofile\s*\(/g,
  /\bpackage\.loadlib\s*\(/g,
];
function sandboxFilter(code) {
  if(code.length>MAX_DYNAMIC_SIZE)
    return { safe:false, reason:`コードが大きすぎます (${(code.length/1024).toFixed(1)}KB > 512KB)`, code };
  let filtered=code;
  const removed=[];
  for(const pat of DANGEROUS_PATTERNS){
    if(pat.test(filtered)){
      filtered=filtered.replace(pat,m=>{ removed.push(m.replace(/\(/,'')); return '--[[REMOVED]]--'; });
      pat.lastIndex=0;
    }
  }
  return { safe:true, code:filtered, removed };
}

// ────────────────────────────────────────────────────────────────────────
//  #14  vmDetector  — while true do opcode=... のVMパターン検出
// ────────────────────────────────────────────────────────────────────────
function vmDetector(code) {
  const hints=[];
  const patterns=[
    { re:/while\s+true\s+do[\s\S]{0,200}opcode/i,       desc:'while-true opcodeループ検出' },
    { re:/\bopcode\b.*\bInstructions\b/s,                desc:'opcode+Instructionsテーブル' },
    { re:/local\s+\w+\s*=\s*Instructions\s*\[/,         desc:'Instructions配列アクセス' },
    { re:/\bProto\b[\s\S]{0,100}\bupValues\b/s,          desc:'Proto/upValues構造体' },
    { re:/\bVStack\b|\bVEnv\b|\bVPC\b/,                  desc:'仮想スタック/環境変数' },
    { re:/if\s+opcode\s*==\s*\d+\s*then/,                desc:'opcodeディスパッチ' },
    { re:/\{(\s*\d+\s*,){20,}/,                          desc:'大規模バイトコードテーブル(20+要素)' },
    { re:/\bbit\.bxor\b|\bbit\.band\b|\bbit\.bor\b/,     desc:'ビット演算 (VM難読化特徴)' },
  ];
  if(/return\s*\(function\s*\([^)]*\)/s.test(code)) hints.push('自己実行関数ラッパー');
  for(const p of patterns){ if(p.re.test(code)) hints.push(p.desc); }
  const strings=[];
  const strPattern=/"([^"\\]{4,}(?:\\.[^"\\]*)*)"/g;
  let m; while((m=strPattern.exec(code))!==null){ if(m[1].length>4) strings.push(m[1]); }
  if(strings.length>0) hints.push(`${strings.length}件の文字列リテラル抽出`);
  const isVm=hints.length>=2;
  return { isVm, hints, strings:strings.slice(0,50), method:'vm_detect' };
}
function deobfuscateVmify(code){
  const r=vmDetector(code);
  if(!r.isVm&&r.hints.length===0) return { success:false, error:'VMパターンが検出されませんでした', method:'vmify' };
  return { success:true, result:code, hints:r.hints, strings:r.strings, warning:'VM完全解読には動的実行を推奨', method:'vmify' };
}

// ────────────────────────────────────────────────────────────────────────
//  #15  vmBytecodeExtractor  — bytecodeテーブル・opcodeテーブルを抽出
// ────────────────────────────────────────────────────────────────────────
function vmBytecodeExtractor(code) {
  const tables=[];
  // 大きな数値配列テーブルを抽出
  const tblPattern=/local\s+(\w+)\s*=\s*\{((?:\s*\d+\s*,){10,}[^}]*)\}/g;
  let m;
  while((m=tblPattern.exec(code))!==null){
    const name=m[1];
    const nums=m[2].split(',').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
    if(nums.length>=10) tables.push({ name, count:nums.length, sample:nums.slice(0,16) });
  }
  if(tables.length===0) return { success:false, error:'バイトコードテーブルが見つかりません', method:'vm_extract' };
  return { success:true, tables, method:'vm_extract',
    hints:tables.map(t=>`${t.name}[${t.count}要素]: [${t.sample.join(',')}...]`) };
}

// ────────────────────────────────────────────────────────────────────────
//  #16  stringTransformDecoder  — string.reverse/string.sub 型難読化復元
// ────────────────────────────────────────────────────────────────────────
function stringTransformDecoder(code) {
  let modified=code, found=false;
  const env=new SymbolicEnv();
  // string.reverse("...") を直接評価
  modified=modified.replace(/string\.reverse\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g,(match,strExpr)=>{
    const s=stripLuaString(strExpr); if(s===null) return match;
    found=true;
    const rev=s.split('').reverse().join('');
    return `"${rev.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
  });
  // string.sub("...", i, j)
  modified=modified.replace(/string\.sub\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(-?\d+)\s*(?:,\s*(-?\d+))?\s*\)/g,(match,strExpr,iStr,jStr)=>{
    const s=stripLuaString(strExpr); if(s===null) return match;
    let i=parseInt(iStr),j=jStr!==undefined?parseInt(jStr):s.length;
    if(i<0) i=Math.max(0,s.length+i+1); if(j<0) j=s.length+j+1;
    found=true;
    const sub=s.slice(i-1,j);
    return `"${sub.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
  });
  // string.rep("...", n)
  modified=modified.replace(/string\.rep\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(\d+)\s*\)/g,(match,strExpr,nStr)=>{
    const s=stripLuaString(strExpr); const n=parseInt(nStr);
    if(s===null||isNaN(n)) return match;
    found=true;
    return `"${s.repeat(n).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
  });
  if(!found) return { success:false, error:'stringTransformパターンが見つかりません', method:'str_transform' };
  return { success:true, result:modified, method:'str_transform' };
}

// ────────────────────────────────────────────────────────────────────────
//  #17  base64Detector  — Base64文字列を自動デコード
// ────────────────────────────────────────────────────────────────────────
function base64Detector(code, pool) {
  const B64_RE=/[A-Za-z0-9+\/]{32,}={0,2}/g;
  const found=[]; let m;
  while((m=B64_RE.exec(code))!==null){
    const b64=m[0];
    try {
      const decoded=Buffer.from(b64,'base64').toString('utf8');
      // デコード結果がLuaコードっぽければプールに追加
      if(scoreLuaCode(decoded)>20){
        if(pool) pool.add(decoded,'base64_decode');
        found.push({ b64:b64.substring(0,30)+'...', score:scoreLuaCode(decoded).toFixed(1), decoded:decoded.substring(0,60) });
      }
    } catch {}
  }
  if(found.length===0) return { success:false, error:'Base64Luaコードが見つかりません', method:'base64_detect' };
  return { success:true, found, hints:found.map(f=>`score=${f.score}: "${f.decoded}..."`), method:'base64_detect' };
}

// ────────────────────────────────────────────────────────────────────────
//  EncryptStrings  (後方互換 + charDecoder統合)
// ────────────────────────────────────────────────────────────────────────
function deobfuscateEncryptStrings(code) {
  const env=new SymbolicEnv();
  let res=charDecoder(code,env);
  if(res.success) return res;
  // フォールバック: 数値エスケープ展開
  let modified=code, found=false;
  modified=modified.replace(/"((?:\\[0-9]{1,3}|\\x[0-9a-fA-F]{2}|[^"\\])+)"/g,(match,inner)=>{
    if(!/\\[0-9]|\\x/i.test(inner)) return match;
    try {
      const decoded=resolveLuaStringEscapes(inner);
      if([...decoded].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)<=126)){
        found=true; return `"${decoded.replace(/"/g,'\\"').replace(/\\/g,'\\\\')}"`;
      }
    } catch {}
    return match;
  });
  if(!found) return { success:false, error:'EncryptStringsパターンが見つかりません', method:'encrypt_strings' };
  return { success:true, result:modified, method:'encrypt_strings' };
}

// ════════════════════════════════════════════════════════════════════════
//  #18 + #19  recursiveDeobfuscate  — 再帰的解析 + seenCodeCache
// ════════════════════════════════════════════════════════════════════════
function recursiveDeobfuscate(code, maxDepth, pool) {
  maxDepth=maxDepth||8;
  pool=pool||new CapturePool();
  const seenHashes=new Set();

  // 静的パスのリスト（処理順: #1の要件に対応）
  const staticPasses=[
    { name:'ConstantFolding',    fn: c=>evaluateExpressions(c) },
    { name:'EvalExpressions',    fn: c=>evaluateExpressions(c) },
    { name:'SplitStrings',       fn: c=>deobfuscateSplitStrings(c) },
    { name:'XOR',                fn: c=>xorDecoder(c) },
    { name:'ConstantArray',      fn: c=>constantArrayResolver(c) },
    { name:'CharDecoder',        fn: c=>charDecoder(c) },
    { name:'MathEval',           fn: c=>mathEvaluator(c) },
    { name:'ConstantCall',       fn: c=>constantCallEvaluator(c) },
    { name:'StringTransform',    fn: c=>stringTransformDecoder(c) },
    { name:'DeadBranch',         fn: c=>deadBranchRemover(c) },
    { name:'JunkClean',          fn: c=>junkAssignmentCleaner(c) },
  ];

  let current=code;
  let depth=0;
  const allSteps=[];

  while(depth++<maxDepth){
    const h=cacheHash(current);
    if(seenHashes.has(h)) break;
    seenHashes.add(h);

    // キャッシュチェック
    const cached=cacheGet(current);
    if(cached){ current=cached; allSteps.push({step:'CacheHit',success:true,method:'cache'}); break; }

    let anyChange=false;
    for(const pass of staticPasses){
      const res=pass.fn(current);
      if(res.success&&res.result&&res.result!==current){
        allSteps.push({ step:pass.name, success:true, method:res.method });
        pool.add(res.result, pass.name);
        current=res.result;
        anyChange=true;
      }
    }

    // base64チェック
    base64Detector(current, pool);

    if(!anyChange) break;
  }

  // キャッシュに保存
  if(current!==code) cacheSet(code, current);

  return { code:current, steps:allSteps, pool };
}

// ════════════════════════════════════════════════════════════════════════
//  advancedStaticDeobfuscate  — 全パス統合エントリーポイント
// ════════════════════════════════════════════════════════════════════════
function advancedStaticDeobfuscate(code) {
  const pool=new CapturePool();
  const { code:result, steps } = recursiveDeobfuscate(code, 8, pool);
  const changed=result!==code;
  return {
    success: changed,
    result,
    steps: steps.map(s=>s.step),
    method: 'advanced_static',
    error: changed?undefined:'静的解析で変化なし（動的実行が必要な可能性があります）',
  };
}

// deepStaticDeobfuscate (後方互換)
function deepStaticDeobfuscate(code, maxDepth) {
  const { code:result, steps } = recursiveDeobfuscate(code, maxDepth||6, new CapturePool());
  return { code:result, changed:result!==code };
}

// symbolicExecute, SymbolicEnv (後方互換エクスポート用スタブ)
function symbolicExecute(code, env, depth, visited) {
  const res=recursiveDeobfuscate(code, 2, new CapturePool());
  return { code:res.code, env:env||new SymbolicEnv(), changed:res.code!==code };
}





// ════════════════════════════════════════════════════════
//  AUTO  — v3 解析パイプライン
//
//  処理順 (#1要件):
//   1. advanced_static (ConstantFolding / SymExec / 全静的パス)
//   2. evaluate_expressions
//   3. split_strings
//   4. xor
//   5. constant_array
//   6. dynamic (Lua実行 → 多段ループ)
//   7. vmify (VM検出ヒント)
// ════════════════════════════════════════════════════════
async function autoDeobfuscate(code) {
  const results = [];
  let current = code;
  const luaBin = checkLuaAvailable();
  const pool = new CapturePool();
  pool.add(current, 'input');

  // ── ① advanced_static ──────────────────────────────
  {
    const res = advancedStaticDeobfuscate(current);
    results.push({
      step: 'AdvancedStatic',
      success: res.success,
      result: res.result,
      method: res.method,
      hints: res.steps && res.steps.length ? [`ステップ: ${res.steps.join(' → ')}`] : undefined,
    });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      pool.add(current, 'advanced_static');
    }
  }

  // ── ② evaluate_expressions ─────────────────────────
  {
    const res = evaluateExpressions(current);
    results.push({ step: 'EvaluateExpressions', ...res });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      pool.add(current, 'eval_expr');
    }
  }

  // ── ③ split_strings ────────────────────────────────
  {
    const res = deobfuscateSplitStrings(current);
    results.push({ step: 'SplitStrings', ...res });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      pool.add(current, 'split_strings');
    }
  }

  // ── ④ xor ──────────────────────────────────────────
  {
    const res = xorDecoder(current);
    results.push({ step: 'XOR', ...res });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      pool.add(current, 'xor');
    }
  }

  // ── ⑤ constant_array ───────────────────────────────
  {
    const res = constantArrayResolver(current);
    results.push({ step: 'ConstantArray', ...res });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      pool.add(current, 'constant_array');
    }
  }

  // ── ⑥ dynamic (Lua実行) ────────────────────────────
  if (luaBin) {
    const dynRes = await tryDynamicExecution(current);
    results.push({ step: '動的実行 (1回目)', ...dynRes });
    if (dynRes.success && dynRes.result) {
      current = dynRes.result;
      pool.add(current, 'dynamic_1');

      // #18 recursiveDeobfuscate: 動的実行後も静的解析を再試行
      const postRes = advancedStaticDeobfuscate(current);
      if (postRes.success && postRes.result !== current) {
        results.push({ step: 'AdvancedStatic (post-dynamic)', success: true, method: 'advanced_static' });
        current = postRes.result;
        pool.add(current, 'post_dynamic_static');
      }

      // 多段難読化: 最大3回動的実行を繰り返す
      for (let round = 2; round <= 4; round++) {
        const stillObfuscated = /loadstring|load\s*\(|[A-Za-z0-9+\/]{60,}={0,2}/.test(current);
        if (!stillObfuscated) break;
        const dynRes2 = await tryDynamicExecution(current);
        results.push({ step: `動的実行 (${round}回目)`, ...dynRes2 });
        if (dynRes2.success && dynRes2.result && dynRes2.result !== current) {
          current = dynRes2.result;
          pool.add(current, `dynamic_${round}`);
        } else break;
      }
    } else {
      // 動的実行失敗 → capturePool の最善候補を使う
      const poolBest = pool.getBest();
      if (poolBest && poolBest !== current) {
        results.push({ step: 'CapturePool fallback', success: true, method: 'pool', result: poolBest });
        current = poolBest;
      }
    }
  } else {
    results.push({ step: '動的実行', success: false, error: 'Luaがインストールされていません', method: 'dynamic' });
  }

  // ── ⑦ vmify ────────────────────────────────────────
  {
    const vmRes = deobfuscateVmify(current);
    if (vmRes.success) {
      results.push({ step: 'VmDetect', ...vmRes });
      // VMパターンあり → バイトコード抽出も試みる
      const vmEx = vmBytecodeExtractor(current);
      if (vmEx.success) results.push({ step: 'VmBytecodeExtract', ...vmEx });
    }
  }

  // base64検出結果もステップに追加
  {
    const b64res = base64Detector(current, pool);
    if (b64res.success) results.push({ step: 'Base64Detect', ...b64res });
  }

  return {
    success: results.some(r => r.success),
    steps: results,
    finalCode: current,
    poolSize: pool.entries.length,
  };
}

// ════════════════════════════════════════════════════════
//  Prometheus 難読化
// ════════════════════════════════════════════════════════
function obfuscateWithPrometheus(code, options = {}) {
  return new Promise(resolve => {
    // PrometheusはLua5.1専用 → lua5.1 → luajit → lua の順で探す
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
    // stepsは現状Prometheusのargとして渡すと問題が起きるため使わない
    // preset のみで制御する
    const cmd = `${luaBin} ${cliPath} --preset ${preset} ${tmpIn} --out ${tmpOut}`;

    console.log('[Prometheus] cmd:', cmd);
    console.log('[Prometheus] input preview:', JSON.stringify(code.substring(0, 120)));

    exec(cmd, { timeout: 30000, cwd: path.dirname(cliPath) }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      const errText = (stderr || '').trim();
      const outText = (stdout || '').trim();
      console.log('[Prometheus] stdout:', outText.substring(0, 200));
      console.log('[Prometheus] stderr:', errText.substring(0, 200));
      try {
        if (err) {
          // エラー内容をそのままフロントに返す
          resolve({ success: false, error: 'Lua: ' + errText });
          return;
        }
        if (!fs.existsSync(tmpOut)) {
          resolve({ success: false, error: 'Prometheusが出力ファイルを生成しませんでした。stderr: ' + errText });
          return;
        }
        const result = fs.readFileSync(tmpOut, 'utf8');
        if (!result || result.trim().length === 0) {
          resolve({ success: false, error: 'Prometheusの出力が空でした' });
          return;
        }
        resolve({ success: true, result, preset });
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    });
  });
}

// ════════════════════════════════════════════════════════
//  古い一時ファイルのクリーンアップ
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  カスタムVM難読化
//  Renderサーバー上のLuaで実行される独自VMを生成する
//
//  フロー:
//   1. 入力Luaコードをサーバーに送る
//   2. vm_obfuscator.luaがコードをVM命令列に変換
//      - luacが使える場合: バイトコード → XOR暗号化 → VMランタイム
//      - luacがない場合: ソース → 加算暗号化 → VMランタイム
//   3. 生成されたVMコード（独自インタープリタ付き）を返す
// ════════════════════════════════════════════════════════
function obfuscateWithCustomVM(code, options = {}) {
  return new Promise(resolve => {
    const luaBin = checkLuaAvailable();
    if (!luaBin) {
      resolve({ success: false, error: 'Luaがインストールされていません' });
      return;
    }

    // vm_obfuscator.lua の場所を確認
    const vmScript = path.join(__dirname, 'vm_obfuscator.lua');
    if (!fs.existsSync(vmScript)) {
      resolve({ success: false, error: 'vm_obfuscator.luaが見つかりません' });
      return;
    }

    const seed = options.seed || (Math.floor(Math.random() * 900000) + 100000);
    const tmpIn  = path.join(tempDir, `vm_in_${crypto.randomBytes(8).toString('hex')}.lua`);
    const tmpOut = path.join(tempDir, `vm_out_${crypto.randomBytes(8).toString('hex')}.lua`);
    fs.writeFileSync(tmpIn, code, 'utf8');

    const cmd = `${luaBin} ${vmScript} ${tmpIn} --out ${tmpOut} --seed ${seed}`;
    console.log('[VM] cmd:', cmd);

    exec(cmd, { timeout: 30000, cwd: __dirname }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch {}

      const outText = (stdout || '').trim();
      const errText = (stderr || '').trim();
      console.log('[VM] stdout:', outText.substring(0, 200));
      if (errText) console.log('[VM] stderr:', errText.substring(0, 200));

      if (err) {
        resolve({ success: false, error: 'VM難読化エラー: ' + (errText || err.message) });
        return;
      }

      // vm_obfuscator.lua は成功時 "OK:<outfile>" を stdout に出力する
      if (!outText.startsWith('OK:') && !fs.existsSync(tmpOut)) {
        resolve({ success: false, error: 'VM難読化失敗: ' + (errText || outText || '出力なし') });
        return;
      }

      try {
        if (!fs.existsSync(tmpOut)) {
          resolve({ success: false, error: '出力ファイルが見つかりません' });
          return;
        }
        const result = fs.readFileSync(tmpOut, 'utf8');
        if (!result || result.trim().length === 0) {
          resolve({ success: false, error: 'VM難読化の出力が空でした' });
          return;
        }
        resolve({ success: true, result, seed, method: 'custom_vm' });
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    });
  });
}

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
