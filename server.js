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
    deobfuscateMethods: ['auto', 'xor', 'split_strings', 'encrypt_strings', 'constant_array', 'vmify', 'dynamic', 'advanced_static'],
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
    case 'xor':             result = deobfuscateXOR(code);           break;
    case 'split_strings':   result = deobfuscateSplitStrings(code);  break;
    case 'encrypt_strings': result = deobfuscateEncryptStrings(code); break;
    case 'constant_array':   result = deobfuscateConstantArray(code);  break;
    case 'eval_expressions': result = evaluateExpressions(code);      break;
    case 'advanced_static':  result = advancedStaticDeobfuscate(code); break;
    case 'vmify':            result = deobfuscateVmify(code);         break;
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

  const tempFile = path.join(tempDir, `obf_${Date.now()}_${Math.random().toString(36).substring(7)}.lua`);

  // ]] が含まれる場合のエスケープ
  const safeCode = code.replace(/\]\]/g, '] ]');

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

    exec(`${luaBin} ${tempFile}`, { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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

// ════════════════════════════════════════════════════════
//  静的解読エンジン v2  —  AST評価 + 記号実行 + ハッシュキャッシュ
//
//  実装内容:
//   ① Constant Folding  — 10^6+225700+78 など任意深度の数値式を評価
//   ② string.char 完全解析  — 計算式引数も評価して文字に変換
//   ③ table.concat エミュレーション
//   ④ .. 連結の完全展開（混合クォート・多段）
//   ⑤ 配列/テーブル定数値追跡（変数代入まで追う）
//   ⑥ for ループ文字列構築エミュレーション
//   ⑦ getfenv()[string] 形式の関数名解析
//   ⑧ loadstring/load 以外の全文字列生成フック
//   ⑨ pcall 内コード再帰解析
//   ⑩ ハッシュキャッシュによる無限ループ防止
//   ⑪ 生成文字列がLuaコードなら再帰的に解析
// ════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────
//  共通ユーティリティ
// ────────────────────────────────────────────────────────

/** Luaコードらしさのスコア */
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

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 4096); i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
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

// ══════════════════════════════════════════════════════
//  ① Constant Folding  — 任意深度の数値式ASTを評価
//     対応: +, -, *, /, %, ^(累乗), 括弧, math.floor/ceil/abs/max/min
// ══════════════════════════════════════════════════════

/**
 * Lua数値式をJSで安全に評価するパーサー（再帰降下法）
 * eval()不使用・完全自前実装
 */
function evalLuaNumExpr(expr) {
  const src = (expr || '').trim();
  if (!src) return null;
  let pos = 0;

  function peek() { return pos < src.length ? src[pos] : ''; }
  function consume() { return pos < src.length ? src[pos++] : ''; }
  function skipWs() { while (pos < src.length && /\s/.test(src[pos])) pos++; }

  function parseExpr() { return parseAddSub(); }

  function parseAddSub() {
    let left = parseMulDiv();
    if (left === null) return null;
    skipWs();
    while (peek() === '+' || peek() === '-') {
      const op = consume(); skipWs();
      const right = parseMulDiv();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
      skipWs();
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePow();
    if (left === null) return null;
    skipWs();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume(); skipWs();
      const right = parsePow();
      if (right === null) return null;
      if (op === '*') left = left * right;
      else if (op === '/') { if (right === 0) return null; left = Math.floor(left / right); }
      else { if (right === 0) return null; left = ((left % right) + right) % right; }
      skipWs();
    }
    return left;
  }

  function parsePow() {
    let base = parseUnary();
    if (base === null) return null;
    skipWs();
    if (peek() === '^') {
      consume(); skipWs();
      const exp = parseUnary();
      if (exp === null) return null;
      base = Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    skipWs();
    if (peek() === '-') { consume(); skipWs(); const v = parseAtom(); return v === null ? null : -v; }
    if (peek() === '+') { consume(); skipWs(); }
    return parseAtom();
  }

  function parseAtom() {
    skipWs();
    if (peek() === '(') {
      consume();
      const v = parseExpr();
      skipWs();
      if (peek() === ')') consume();
      return v;
    }
    // math.xxx 関数
    if (src.startsWith('math.', pos)) {
      pos += 5;
      let fname = '';
      while (pos < src.length && /[a-z]/.test(src[pos])) fname += src[pos++];
      skipWs();
      if (peek() !== '(') return null;
      consume();
      const args = [];
      skipWs();
      while (peek() !== ')' && pos < src.length) {
        const a = parseExpr();
        if (a === null) return null;
        args.push(a);
        skipWs();
        if (peek() === ',') { consume(); skipWs(); }
      }
      if (peek() === ')') consume();
      if (fname === 'floor') return Math.floor(args[0] ?? 0);
      if (fname === 'ceil')  return Math.ceil(args[0] ?? 0);
      if (fname === 'abs')   return Math.abs(args[0] ?? 0);
      if (fname === 'max')   return args.length ? Math.max(...args) : null;
      if (fname === 'min')   return args.length ? Math.min(...args) : null;
      if (fname === 'sqrt')  return Math.sqrt(args[0] ?? 0);
      if (fname === 'huge')  return null; // 定数ではない
      return null;
    }
    // 16進数リテラル
    if (src[pos] === '0' && (src[pos+1] === 'x' || src[pos+1] === 'X')) {
      pos += 2;
      let h = '';
      while (pos < src.length && /[0-9a-fA-F]/.test(src[pos])) h += src[pos++];
      const n = parseInt(h, 16);
      return isNaN(n) ? null : n;
    }
    // 数値リテラル
    let numStr = '';
    while (pos < src.length && /[0-9.]/.test(src[pos])) numStr += src[pos++];
    if (numStr === '' || numStr === '.') return null;
    const n = parseFloat(numStr);
    return isNaN(n) ? null : n;
  }

  try {
    const result = parseExpr();
    skipWs();
    if (result === null || !isFinite(result)) return null;
    if (pos < src.length) return null; // 消費しきれていない
    return result;
  } catch { return null; }
}

/** 後方互換ラッパー */
function evalSimpleExpr(expr) {
  const r = evalLuaNumExpr(expr);
  if (r === null) return null;
  return Number.isInteger(r) ? r : Math.floor(r);
}

// ══════════════════════════════════════════════════════
//  ② 記号実行エンジン  — 変数の定数値を追跡する環境
// ══════════════════════════════════════════════════════

class SymbolicEnv {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return null;
  }
  set(name, entry) { this.vars.set(name, entry); }
  child() { return new SymbolicEnv(this); }
}

function stripLuaString(tok) {
  tok = (tok || '').trim();
  if ((tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'"))) {
    try { return resolveLuaStringEscapes(tok.slice(1, -1)); } catch { return null; }
  }
  if (tok.startsWith('[[') && tok.endsWith(']]')) {
    return tok.slice(2, -2);
  }
  return null;
}

/**
 * カンマ区切りのトークン列を括弧・クォート対応で分割
 */
function splitByComma(src) {
  const parts = [];
  let cur = '', depth = 0, inStr = false, strCh = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inStr) {
      if (c === '"' || c === "'") { inStr = true; strCh = c; cur += c; }
      else if (c === '(' || c === '{' || c === '[') { depth++; cur += c; }
      else if (c === ')' || c === '}' || c === ']') { depth--; cur += c; }
      else if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += c;
    } else {
      if (c === '\\') { cur += c + (src[i+1] || ''); i++; continue; }
      if (c === strCh) inStr = false;
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * .. 演算子でトークンを分割（文字列/関数呼び出し内の .. は無視）
 */
function splitByConcat(src) {
  const parts = [];
  let cur = '', depth = 0, inStr = false, strCh = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (!inStr) {
      if (c === '"' || c === "'") { inStr = true; strCh = c; cur += c; i++; continue; }
      if (c === '[' && src[i+1] === '[') {
        let end = src.indexOf(']]', i + 2);
        if (end === -1) end = src.length - 2;
        cur += src.slice(i, end + 2);
        i = end + 2; continue;
      }
      if (c === '(' || c === '{' || c === '[') { depth++; cur += c; i++; continue; }
      if (c === ')' || c === '}' || c === ']') { depth--; cur += c; i++; continue; }
      if (depth === 0 && c === '.' && src[i+1] === '.') {
        parts.push(cur.trim());
        cur = '';
        i += 2;
        if (src[i] === '.') i++; // variadic ...
        continue;
      }
    } else {
      if (c === '\\') { cur += c + (src[i+1] || ''); i += 2; continue; }
      if (c === strCh) inStr = false;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * string.char(expr, expr, ...) を評価して文字列にする
 */
function evalStringChar(argsStr, env) {
  const args = splitByComma(argsStr);
  const chars = [];
  for (const a of args) {
    const val = evalExprWithEnv(a.trim(), env);
    if (val === null || typeof val !== 'number') return null;
    const code = Math.round(val);
    if (code < 0 || code > 255) return null;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

/**
 * 算術式を環境付きで評価（変数を数値に置換してから evalLuaNumExpr）
 */
function evalArithWithEnv(expr, env) {
  if (!env) return evalLuaNumExpr(expr);
  let resolved = expr.replace(/\b([a-zA-Z_]\w*)\b/g, (m) => {
    if (/^(math)$/.test(m)) return m; // math.xxx は別途処理
    const entry = env ? env.get(m) : null;
    if (entry && entry.type === 'num') return String(entry.value);
    return m;
  });
  if (/[a-zA-Z_]/.test(resolved.replace(/math\./g, ''))) return null;
  return evalLuaNumExpr(resolved);
}

/**
 * 式を env を参照しながら評価し、string | number | null を返す
 */
function evalExprWithEnv(expr, env) {
  if (!expr) return null;
  expr = expr.trim();

  // 文字列リテラル
  const strVal = stripLuaString(expr);
  if (strVal !== null) return strVal;

  // true/false/nil
  if (expr === 'true') return 1;
  if (expr === 'false' || expr === 'nil') return 0;

  // 数値リテラル / 純粋算術（変数なし）
  if (/^[\d\s\+\-\*\/\%\(\)\.\^x0-9a-fA-FxX]+$/.test(expr) || /^[\-\+]?\s*math\./.test(expr)) {
    const n = evalLuaNumExpr(expr);
    if (n !== null) return n;
  }

  // string.char(...)
  const scMatch = expr.match(/^string\.char\((.+)\)$/s);
  if (scMatch) return evalStringChar(scMatch[1], env);

  // tostring(x)
  const tsMatch = expr.match(/^tostring\((.+)\)$/s);
  if (tsMatch) {
    const v = evalExprWithEnv(tsMatch[1], env);
    if (v !== null) return String(v);
  }

  // string.rep(s, n)
  const repMatch = expr.match(/^string\.rep\((.+?),\s*(\d+)\)$/s);
  if (repMatch) {
    const s = evalExprWithEnv(repMatch[1], env);
    const n = parseInt(repMatch[2]);
    if (typeof s === 'string' && !isNaN(n)) return s.repeat(n);
  }

  // string.sub(s, i[, j])
  const subMatch = expr.match(/^string\.sub\((.+?),\s*(-?\d+)(?:,\s*(-?\d+))?\)$/s);
  if (subMatch) {
    const s = evalExprWithEnv(subMatch[1], env);
    if (typeof s === 'string') {
      let i = parseInt(subMatch[2]);
      let j = subMatch[3] !== undefined ? parseInt(subMatch[3]) : s.length;
      if (i < 0) i = Math.max(0, s.length + i + 1);
      if (j < 0) j = s.length + j + 1;
      return s.slice(i - 1, j);
    }
  }

  // string.reverse(s)
  const revMatch = expr.match(/^string\.reverse\((.+)\)$/s);
  if (revMatch) {
    const s = evalExprWithEnv(revMatch[1], env);
    if (typeof s === 'string') return s.split('').reverse().join('');
  }

  // string.byte(s, i)
  const byteMatch = expr.match(/^string\.byte\((.+?),\s*(\d+)(?:,\s*\d+)?\)$/s);
  if (byteMatch) {
    const s = evalExprWithEnv(byteMatch[1], env);
    const i = parseInt(byteMatch[2]);
    if (typeof s === 'string' && i >= 1 && i <= s.length) return s.charCodeAt(i - 1);
  }

  // table.concat(tbl[, sep])
  const tcMatch = expr.match(/^table\.concat\((\w+)(?:,\s*(.+?))?\)$/s);
  if (tcMatch && env) {
    const tbl = env.get(tcMatch[1]);
    if (tbl && tbl.type === 'table' && Array.isArray(tbl.value)) {
      const sep = tcMatch[2] ? (evalExprWithEnv(tcMatch[2], env) ?? '') : '';
      const parts = tbl.value.map(v => {
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        return null;
      });
      if (parts.every(p => p !== null)) return parts.join(sep);
    }
  }

  // getfenv()[key] / rawget(_G, key) / _G[key]
  const gfMatch = expr.match(/^(?:getfenv\(\)|_G)\s*\[\s*(.+?)\s*\]$/s);
  if (gfMatch) {
    const key = evalExprWithEnv(gfMatch[1], env);
    if (typeof key === 'string') return key;
  }
  const rawgetMatch = expr.match(/^rawget\s*\(\s*(?:_G|getfenv\(\))\s*,\s*(.+?)\s*\)$/s);
  if (rawgetMatch) {
    const key = evalExprWithEnv(rawgetMatch[1], env);
    if (typeof key === 'string') return key;
  }

  // .. 連結式を分解して評価
  const concatParts = splitByConcat(expr);
  if (concatParts.length > 1) {
    const resolved = concatParts.map(p => evalExprWithEnv(p.trim(), env));
    if (resolved.every(v => v !== null)) return resolved.map(String).join('');
  }

  // 変数参照
  if (env && /^\w+$/.test(expr)) {
    const entry = env.get(expr);
    if (entry && (entry.type === 'num' || entry.type === 'str')) return entry.value;
  }

  // 変数[インデックス] — 配列アクセス
  const arrMatch = expr.match(/^(\w+)\[(.+)\]$/);
  if (arrMatch && env) {
    const tbl = env.get(arrMatch[1]);
    if (tbl && tbl.type === 'table' && Array.isArray(tbl.value)) {
      const idx = evalExprWithEnv(arrMatch[2], env);
      if (typeof idx === 'number') {
        const v = tbl.value[Math.round(idx) - 1];
        if (v !== undefined) return v;
      }
    }
  }

  // 算術式（変数参照含む）
  const numResult = evalArithWithEnv(expr, env);
  if (numResult !== null) return numResult;

  return null;
}

// ══════════════════════════════════════════════════════
//  ③ 記号実行コア  — コードを書き換えるメインエンジン
// ══════════════════════════════════════════════════════

function symbolicExecute(code, env, depth, visitedHashes) {
  if (depth > 8) return { code, env, changed: false };

  const h = hashCode(code);
  if (visitedHashes.has(h)) return { code, env, changed: false };
  visitedHashes.add(h);

  let modified = code;
  let changed = false;

  // ── パス1: Constant Folding ─────────────────────────
  {
    let prev;
    let iters = 0;
    do {
      prev = modified;
      // 括弧内の純粋数値式 (文字列内除外)
      modified = modified.replace(/\(([^()'"]{1,80})\)/g, (match, inner) => {
        if (/["']/.test(inner)) return match;
        const v = evalLuaNumExpr(inner);
        if (v === null || !Number.isInteger(v)) return match;
        if (String(v) === inner.trim()) return match;
        changed = true;
        return String(v);
      });
      // 代入右辺の裸の数値算術
      modified = modified.replace(/(=\s*)([0-9][0-9\s\+\-\*\/\%\^\(\)\.]*[0-9])/g, (match, eq, expr) => {
        if (/[a-zA-Z]/.test(expr)) return match;
        const v = evalLuaNumExpr(expr);
        if (v === null || !Number.isInteger(v)) return match;
        if (String(v) === expr.trim()) return match;
        changed = true;
        return eq + String(v);
      });
    } while (modified !== prev && ++iters < 30);
  }

  // ── パス2: string.char(式) の評価 ──────────────────
  {
    modified = modified.replace(/string\.char\(([^)]+)\)/g, (match, argsStr) => {
      const val = evalStringChar(argsStr, env);
      if (val === null) return match;
      const escaped = val
        .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0');
      changed = true;
      return `"${escaped}"`;
    });
  }

  // ── パス3: .. 連結の完全展開 ───────────────────────
  {
    let prev;
    let iters = 0;
    do {
      prev = modified;
      modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g,
        (_, a, b) => { changed = true; return `"${a}${b}"`; });
      modified = modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.]*)*)'/g,
        (_, a, b) => { changed = true; return `'${a}${b}'`; });
      modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*'((?:[^'\\]|\\.]*)*)'/g,
        (_, a, b) => { changed = true; return `"${a}${b}"`; });
      modified = modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g,
        (_, a, b) => { changed = true; return `"${a}${b}"`; });
    } while (modified !== prev && ++iters < 60);
  }

  // ── パス4: 変数代入を追って env を更新 ─────────────
  {
    modified.replace(/local\s+(\w+)\s*=\s*([\d\.\+\-\*\/\%\^\(\) ]+)(?=[\n;,)]|$)/g, (_, name, expr) => {
      if (/[a-zA-Z]/.test(expr)) return _;
      const v = evalLuaNumExpr(expr);
      if (v !== null) env.set(name, { type: 'num', value: v });
    });
    modified.replace(/local\s+(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[\[[\s\S]*?\]\])/g, (_, name, strExpr) => {
      const s = stripLuaString(strExpr);
      if (s !== null) env.set(name, { type: 'str', value: s });
    });
    modified.replace(/local\s+(\w+)\s*=\s*\{([^{}]*)\}/g, (_, name, content) => {
      const elems = parseLuaArrayElements(content);
      const values = elems.map(e => {
        const n = evalLuaNumExpr(e.trim());
        if (n !== null) return n;
        const s = stripLuaString(e.trim());
        if (s !== null) return s;
        return null;
      });
      if (values.every(v => v !== null)) {
        env.set(name, { type: 'table', value: values });
      }
    });
  }

  // ── パス5: ConstantArray 展開 ──────────────────────
  {
    let passCount = 0;
    while (passCount++ < 10) {
      let innerChanged = false;
      const arrayPattern = /local\s+(\w+)\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
      let match;
      const snapshot = modified;
      while ((match = arrayPattern.exec(snapshot)) !== null) {
        const varName = match[1], content = match[2];
        const elements = parseLuaArrayElements(content);
        if (elements.length < 1) continue;
        const values = elements.map(e => {
          const n = evalLuaNumExpr(e.trim());
          if (n !== null) return n;
          const s = stripLuaString(e.trim());
          if (s !== null) return s;
          return e.trim();
        });
        env.set(varName, { type: 'table', value: values });
        const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const indexRe = new RegExp(esc + '\\[([^\\]]+)\\]', 'g');
        modified = modified.replace(indexRe, (fullMatch, indexExpr) => {
          const idx = evalExprWithEnv(indexExpr, env);
          if (idx === null || typeof idx !== 'number') return fullMatch;
          const rounded = Math.round(idx);
          if (rounded < 1 || rounded > values.length) return fullMatch;
          changed = true; innerChanged = true;
          const v = values[rounded - 1];
          if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          if (typeof v === 'number') return String(v);
          return fullMatch;
        });
      }
      if (!innerChanged) break;
    }
  }

  // ── パス6: table.concat(var) の解決 ─────────────────
  {
    modified = modified.replace(/table\.concat\((\w+)(?:,\s*(.+?))?\)/g, (match, name, sepExpr) => {
      const tbl = env.get(name);
      if (!tbl || tbl.type !== 'table') return match;
      const sep = sepExpr ? (evalExprWithEnv(sepExpr.trim(), env) ?? '') : '';
      if (typeof sep !== 'string') return match;
      const parts = tbl.value.map(v => {
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        return null;
      });
      if (parts.some(p => p === null)) return match;
      changed = true;
      const result = parts.join(sep);
      return `"${result.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });
  }

  // ── パス7: for ループ文字列構築エミュレート ──────────
  // local r={}; for i=1,#src do r[#r+1]=string.char(src[i] op k) end; table.concat(r)
  {
    // パターン: local _r={}; for _i=1,#_src do _r[_i]=string.char(_src[_i] op val) end; table.concat(_r)
    const forStrPattern = /local\s+(\w+)\s*=\s*\{\s*\}\s*[\n;]+\s*for\s+(\w+)\s*=\s*1\s*,\s*#(\w+)\s+do\s+\1\[(?:\2|#\1\s*\+\s*1)\]\s*=\s*string\.char\(([^)]+)\)\s*end\s*[\n;]*\s*(?:return\s+)?(?:table\.concat\(\s*\1\s*\))/gs;
    modified = modified.replace(forStrPattern, (match, rVar, iVar, srcVar, charExpr) => {
      const srcTbl = env.get(srcVar);
      if (!srcTbl || srcTbl.type !== 'table') return match;
      const result = [];
      for (let i = 0; i < srcTbl.value.length; i++) {
        const localEnv = env.child();
        localEnv.set(iVar, { type: 'num', value: i + 1 });
        localEnv.set(srcVar, srcTbl);
        const charVal = evalExprWithEnv(charExpr.trim(), localEnv);
        if (typeof charVal !== 'number') return match;
        const code = Math.round(charVal);
        if (code < 0 || code > 255) return match;
        result.push(String.fromCharCode(code));
      }
      changed = true;
      const s = result.join('');
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });
  }

  // ── パス8: getfenv()[str] / _G[str] 形式の解析 ────────
  {
    modified = modified.replace(/(?:getfenv\(\)|_G)\s*\[\s*(string\.char\([^)]+\)|"[^"]*"|'[^']*')\s*\]/g, (match, keyExpr) => {
      const key = evalExprWithEnv(keyExpr, env);
      if (typeof key !== 'string') return match;
      changed = true;
      return `"${key.replace(/"/g, '\\"')}"`;
    });
    modified = modified.replace(/rawget\s*\(\s*(?:_G|getfenv\(\))\s*,\s*(string\.char\([^)]+\)|"[^"]*"|'[^']*')\s*\)/g, (match, keyExpr) => {
      const key = evalExprWithEnv(keyExpr, env);
      if (typeof key !== 'string') return match;
      changed = true;
      return `"${key.replace(/"/g, '\\"')}"`;
    });
  }

  // ── パス9: pcall 内コード再帰解析 ────────────────────
  {
    modified = modified.replace(/pcall\s*\(\s*function\s*\(\s*\)\s*([\s\S]{1,2000}?)\s*end\s*\)/g, (match, inner) => {
      const { code: innerCode, changed: innerChanged } = symbolicExecute(inner, env.child(), depth + 1, visitedHashes);
      if (!innerChanged) return match;
      changed = true;
      return `pcall(function() ${innerCode} end)`;
    });
  }

  // ── パス10: loadstring の引数展開 ───────────────────
  {
    modified = modified.replace(/\b(?:load|loadstring)\s*\(\s*([^)]{1,500})\s*\)/g, (match, argExpr) => {
      const val = evalExprWithEnv(argExpr.trim(), env);
      if (typeof val !== 'string') return match;
      const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      changed = true;
      return `loadstring("${escaped}")`;
    });
  }

  // ── パス11: 数値変数を文脈によって展開 ──────────────
  // 代入右辺に変数がある場合、env から解決を試みる
  {
    let prev;
    let iters = 0;
    do {
      prev = modified;
      // 変数が数値インデックスに使われている場合のみ展開
      modified = modified.replace(/\[(\s*[a-zA-Z_]\w*\s*(?:[+\-*\/]\s*\d+\s*)?)\]/g, (match, idxExpr) => {
        const v = evalExprWithEnv(idxExpr.trim(), env);
        if (typeof v !== 'number' || !Number.isInteger(v)) return match;
        changed = true;
        return `[${v}]`;
      });
    } while (modified !== prev && ++iters < 15);
  }

  return { code: modified, env, changed };
}

// ══════════════════════════════════════════════════════
//  ④ 再帰的解析ループ  — ハッシュキャッシュで無限ループ防止
// ══════════════════════════════════════════════════════

function deepStaticDeobfuscate(code, maxDepth) {
  maxDepth = maxDepth || 6;
  const outerVisited = new Set();  // outer loop: prevent cycling back to same code
  let current = code;
  let totalChanged = false;
  let depth = 0;

  while (depth++ < maxDepth) {
    const h = hashCode(current);
    if (outerVisited.has(h)) break;
    outerVisited.add(h);

    // inner visitedHashes: prevent infinite recursion within one symbolicExecute call
    const innerVisited = new Set();
    const env = new SymbolicEnv();
    const { code: next, changed } = symbolicExecute(current, env, 0, innerVisited);

    if (!changed || next === current) break;
    current = next;
    totalChanged = true;
  }

  return { code: current, changed: totalChanged };
}

// ────────────────────────────────────────────────────────
//  XOR 解読
// ────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────
//  後方互換ラッパー群  (既存API維持)
// ────────────────────────────────────────────────────────
function deobfuscateSplitStrings(code) {
  const { code: result, changed } = deepStaticDeobfuscate(code);
  if (!changed) return { success: false, error: 'SplitStringsパターンが見つかりません', method: 'split_strings' };
  return { success: true, result, method: 'split_strings' };
}

function deobfuscateEncryptStrings(code) {
  const { code: after, changed } = deepStaticDeobfuscate(code);
  if (!changed) {
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
  return { success: true, result: after, method: 'encrypt_strings' };
}

function deobfuscateConstantArray(code) {
  const { code: result, changed } = deepStaticDeobfuscate(code);
  if (!changed) return { success: false, error: 'ConstantArrayパターンが見つかりません', method: 'constant_array' };
  return { success: true, result, method: 'constant_array' };
}

function evaluateExpressions(code) {
  const { code: result, changed } = deepStaticDeobfuscate(code);
  if (!changed) return { success: false, error: '評価できる式がありませんでした', method: 'eval_expressions' };
  return { success: true, result, method: 'eval_expressions' };
}

// ────────────────────────────────────────────────────────
//  advancedStaticDeobfuscate  —  新メイン静的解析
//  全パスを組み合わせて最大限解析する
// ────────────────────────────────────────────────────────
function advancedStaticDeobfuscate(code) {
  const visitedHashes = new Set();
  let current = code;
  let totalChanged = false;
  const stepDetails = [];

  // ① deepStaticDeobfuscate (Constant Folding + SymExec)
  {
    const { code: r, changed } = deepStaticDeobfuscate(current);
    if (changed) {
      stepDetails.push('ConstantFolding/SymExec');
      current = r;
      totalChanged = true;
    }
  }

  // ② XOR ブルートフォース
  {
    const xorRes = deobfuscateXOR(current);
    if (xorRes.success && xorRes.result !== current) {
      stepDetails.push(`XOR(key=0x${xorRes.key.toString(16).toUpperCase()})`);
      current = xorRes.result;
      totalChanged = true;
      const { code: r2, changed: c2 } = deepStaticDeobfuscate(current);
      if (c2) { current = r2; stepDetails.push('ConstantFolding(post-XOR)'); }
    }
  }

  // ③ 生成コードがLuaなら再帰解析
  {
    const h = hashCode(current);
    if (!visitedHashes.has(h) && scoreLuaCode(current) > 50) {
      visitedHashes.add(h);
      const { code: r3, changed: c3 } = deepStaticDeobfuscate(current);
      if (c3) { current = r3; stepDetails.push('RecursiveStatic'); totalChanged = true; }
    }
  }

  return {
    success: totalChanged,
    result: current,
    steps: stepDetails,
    method: 'advanced_static',
    error: totalChanged ? undefined : '静的解析で変化なし（動的実行が必要な可能性があります）',
  };
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
//  AUTO  —  動的実行メイン、静的解析はフォールバック
//
//  フロー:
//   ① まず動的実行を試みる（Renderサーバーのluaを使う）
//   ② 成功した場合、結果をさらに動的実行（多段難読化対応）
//   ③ 動的実行が失敗した場合のみ静的解析を試みる
//   ④ 静的解析で変化があれば、もう一度動的実行を試みる
// ════════════════════════════════════════════════════════
async function autoDeobfuscate(code) {
  const results = [];
  let current = code;
  const luaBin = checkLuaAvailable();

  // ① メイン: 動的実行
  if (luaBin) {
    const dynRes = await tryDynamicExecution(current);
    results.push({ step: '動的実行 (1回目)', ...dynRes });

    if (dynRes.success && dynRes.result) {
      current = dynRes.result;

      // ② 多段難読化対応: 結果をさらに動的実行（最大3回）
      for (let round = 2; round <= 4; round++) {
        // 結果がまだ難読化されていそうか確認（loadstringやBase64の特徴があるか）
        const stillObfuscated = /loadstring|load\s*\(|[A-Za-z0-9+/]{60,}={0,2}/.test(current);
        if (!stillObfuscated) break;

        const dynRes2 = await tryDynamicExecution(current);
        results.push({ step: `動的実行 (${round}回目)`, ...dynRes2 });
        if (dynRes2.success && dynRes2.result && dynRes2.result !== current) {
          current = dynRes2.result;
        } else {
          break; // これ以上変化しないので停止
        }
      }
    } else {
      // ③ 動的実行が失敗 → 高精度静的解析で前処理してから再挑戦
      results.push({ step: '静的解析フォールバック開始', success: true, result: current, method: 'info' });

      // v2: advancedStaticDeobfuscate で一括処理（ConstantFolding + SymExec + XOR）
      const advRes = advancedStaticDeobfuscate(current);
      results.push({
        step: '高精度静的解析 (ConstantFolding/SymExec/XOR)',
        success: advRes.success,
        result: advRes.result,
        method: advRes.method,
        error: advRes.error,
        hints: advRes.steps && advRes.steps.length ? [`実行ステップ: ${advRes.steps.join(' → ')}`] : undefined,
      });
      const staticChanged = advRes.success && advRes.result !== current;
      if (staticChanged) current = advRes.result;

      // ④ 静的解析で変化があれば動的実行を再試行
      if (staticChanged) {
        const dynRes3 = await tryDynamicExecution(current);
        results.push({ step: '動的実行 (静的解析後)', ...dynRes3 });
        if (dynRes3.success && dynRes3.result) current = dynRes3.result;
      }
    }
  } else {
    // Luaなし → 高精度静的解析のみ
    results.push({ step: '動的実行', success: false, error: 'Luaがインストールされていません', method: 'dynamic' });

    // v2: advancedStaticDeobfuscate で一括処理
    const advRes = advancedStaticDeobfuscate(current);
    results.push({
      step: '高精度静的解析 (ConstantFolding/SymExec/XOR)',
      success: advRes.success,
      result: advRes.result,
      method: advRes.method,
      error: advRes.error,
      hints: advRes.steps && advRes.steps.length ? [`実行ステップ: ${advRes.steps.join(' → ')}`] : undefined,
    });
    if (advRes.success && advRes.result !== current) current = advRes.result;

    // 追加: Vmify ヒント解析
    const vmRes = deobfuscateVmify(current);
    if (vmRes.success) results.push({ step: 'Vmify', ...vmRes });
  }

  return { success: results.some(r => r.success), steps: results, finalCode: current };
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
