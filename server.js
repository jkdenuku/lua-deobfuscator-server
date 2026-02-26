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

// ════════════════════════════════════════════════════════
//  STATUS
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
//  解読 API
// ════════════════════════════════════════════════════════
app.post('/api/deobfuscate', async (req, res) => {
  const { code, method } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });

  let result;
  switch (method) {
    case 'xor':             result = deobfuscateXOR(code);           break;
    case 'split_strings':   result = deobfuscateSplitStrings(code);  break;
    case 'encrypt_strings': result = deobfuscateEncryptStrings(code); break;
    case 'constant_array':  result = deobfuscateConstantArray(code);  break;
    case 'eval_expressions': result = evaluateExpressions(code);      break;
    case 'vmify':           result = deobfuscateVmify(code);         break;
    case 'dynamic':         result = await tryDynamicExecution(code); break;
    case 'auto':
    default:                result = await autoDeobfuscate(code);    break;
  }

  res.json(result);
});

app.post('/deobfuscate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await autoDeobfuscate(code));
});

// ════════════════════════════════════════════════════════
//  難読化 API
// ════════════════════════════════════════════════════════
app.post('/api/obfuscate', async (req, res) => {
  const { code, preset, steps } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });
  res.json(await obfuscateWithPrometheus(code, { preset, steps }));
});

// ════════════════════════════════════════════════════════
//  共通ユーティリティ
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

// 数式を評価（安全に）
function evalSimpleExpr(expr) {
  try {
    const clean = expr.trim();
    if (!/^[\d\s+\-*/%().]+$/.test(clean)) return null;
    const result = Function('"use strict"; return (' + clean + ')')();
    if (typeof result === 'number' && isFinite(result)) return Math.floor(result);
    return null;
  } catch { return null; }
}

// Luaエスケープシーケンスを解決
function resolveLuaStringEscapes(str) {
  return str
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\'/g, "'")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(\d{1,3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

// Luaの配列要素をパース（ネスト対応）
function parseLuaArrayElements(content) {
  const elements = [];
  let cur = '', depth = 0, inStr = false, strChar = '', i = 0;
  
  while (i < content.length) {
    const c = content[i];
    
    if (!inStr) {
      if (c === '"' || c === "'") {
        inStr = true;
        strChar = c;
        cur += c;
      } else if (c === '[' && content[i+1] === '[') {
        // 長い文字列リテラル [[...]]
        let end = content.indexOf(']]', i + 2);
        if (end === -1) end = content.length - 2;
        cur += content.substring(i, end + 2);
        i = end + 2;
        continue;
      } else if (c === '{') {
        depth++;
        cur += c;
      } else if (c === '}') {
        depth--;
        cur += c;
      } else if (c === ',' && depth === 0) {
        if (cur.trim()) elements.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    } else {
      // 文字列内
      if (c === '\\') {
        cur += c + (content[i+1] || '');
        i += 2;
        continue;
      }
      if (c === strChar) {
        inStr = false;
      }
      cur += c;
    }
    i++;
  }
  
  if (cur.trim()) elements.push(cur.trim());
  return elements;
}

// ════════════════════════════════════════════════════════
//  動的実行（改良版）
// ════════════════════════════════════════════════════════
async function tryDynamicExecution(code) {
  const luaBin = checkLuaAvailable();
  if (!luaBin) return { success: false, error: 'Luaがインストールされていません', method: 'dynamic' };

  const tempFile = path.join(tempDir, `obf_${Date.now()}_${Math.random().toString(36).substring(7)}.lua`);
  const safeCode = code.replace(/\]\]/g, '] ]');

  const wrapper = `
-- YAJU Deobfuscator - Enhanced Dynamic Execution
local __captures = {}
local __capture_count = 0
local __original_loadstring = loadstring or load
local __original_load = load or loadstring

-- アンチダンプ無効化
pcall(function()
  if debug then
    debug.sethook = function() end
    debug.getinfo = function() return {} end
  end
end)

-- loadstring/load完全フック
local function __hook(code_str, ...)
  if type(code_str) == "string" and #code_str > 20 then
    __capture_count = __capture_count + 1
    __captures[__capture_count] = code_str
  end
  return __original_loadstring(code_str, ...)
end

_G.loadstring = __hook
_G.load = __hook
if rawset then
  pcall(function() rawset(_G, "loadstring", __hook) end)
  pcall(function() rawset(_G, "load", __hook) end)
end

-- コード実行
local __obf_code = [[
${safeCode}
]]

local __ok, __err = pcall(function()
  local chunk, err = __original_loadstring(__obf_code)
  if not chunk then error("parse error: " .. tostring(err)) end
  chunk()
end)

-- 結果出力
if __capture_count > 0 then
  local best = __captures[1]
  for i = 2, __capture_count do
    if #__captures[i] > #best then best = __captures[i] end
  end
  io.write("__CAPTURED_START__")
  io.write(best)
  io.write("__CAPTURED_END__")
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

      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const start = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const end = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(start, end).trim();

        if (captured && captured.length > 5) {
          const layerMatch = stdout.match(/__LAYERS__:(\d+)/);
          const layers = layerMatch ? parseInt(layerMatch[1]) : 1;
          return resolve({ success: true, result: captured, layers, method: 'dynamic' });
        }
      }

      if (stdout.includes('__ERROR__:')) {
        const errMsg = stdout.split('__ERROR__:')[1] || '';
        return resolve({ success: false, error: 'Luaエラー: ' + errMsg.substring(0, 300), method: 'dynamic' });
      }

      if (error && stderr) {
        return resolve({ success: false, error: '実行エラー: ' + stderr.substring(0, 300), method: 'dynamic' });
      }

      resolve({ success: false, error: 'loadstring()が呼ばれませんでした', method: 'dynamic' });
    });
  });
}

// ════════════════════════════════════════════════════════
//  静的解読メソッド（完全改訂版）
// ════════════════════════════════════════════════════════

// ── XOR解読 ──
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
  
  if (encryptedArrays.length === 0) {
    return { success: false, error: '暗号化配列が見つかりません', method: 'xor' };
  }
  
  let bestResult = null, bestScore = -1, bestKey = -1;
  for (const arr of encryptedArrays) {
    for (let key = 0; key <= 255; key++) {
      const str = arr.map(b => String.fromCharCode(xorDecryptByte(b, key))).join('');
      const score = scoreLuaCode(str);
      if (score > bestScore) {
        bestScore = score;
        bestResult = str;
        bestKey = key;
      }
    }
  }
  
  if (bestScore < 10) {
    return { success: false, error: '有効なLuaコードが見つかりませんでした', method: 'xor' };
  }
  
  return { success: true, result: bestResult, key: bestKey, score: bestScore, method: 'xor' };
}

// ── 文字列分割の結合 ──
function deobfuscateSplitStrings(code) {
  let modified = code, found = false, iterations = 0;
  
  // "abc" .. "def" → "abcdef"
  while (/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.*)*)"/g.test(modified) && iterations < 60) {
    modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.*)*)"/g, (_, a, b) => {
      found = true;
      return `"${a}${b}"`;
    });
    iterations++;
  }
  
  // 'abc' .. 'def' → 'abcdef'
  while (/'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.*)*)'/g.test(modified) && iterations < 120) {
    modified = modified.replace(/'((?:[^'\\]|\\.)*)'\s*\.\.\s*'((?:[^'\\]|\\.*)*)'/g, (_, a, b) => {
      found = true;
      return `'${a}${b}'`;
    });
    iterations++;
  }
  
  if (!found) {
    return { success: false, error: 'SplitStringsパターンが見つかりません', method: 'split_strings' };
  }
  
  return { success: true, result: modified, method: 'split_strings' };
}

// ── 文字列暗号化の解読（強化版）──
function deobfuscateEncryptStrings(code) {
  let modified = code, found = false;
  
  // string.char(112, 114, 105, 110, 116) → "print"
  modified = modified.replace(/string\.char\s*\(\s*([\d,\s]+)\s*\)/g, (match, nums) => {
    const chars = nums.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 65535);
    if (chars.length === 0) return match;
    found = true;
    const str = chars.map(c => {
      const ch = String.fromCharCode(c);
      // エスケープが必要な文字
      if (ch === '"') return '\\"';
      if (ch === '\\') return '\\\\';
      if (ch === '\n') return '\\n';
      if (ch === '\t') return '\\t';
      if (ch === '\r') return '\\r';
      return ch;
    }).join('');
    return `"${str}"`;
  });
  
  // "\112\114\105\110\116" → "print"
  modified = modified.replace(/"((?:\\[0-9]{1,3}|\\x[0-9a-fA-F]{2}|[^"\\]|\\.)*)"/g, (match, inner) => {
    if (!/\\[0-9]|\\x/i.test(inner)) return match;
    try {
      const decoded = resolveLuaStringEscapes(inner);
      // 印字可能文字のみならデコード
      if ([...decoded].every(c => {
        const code = c.charCodeAt(0);
        return code >= 32 && code <= 126;
      })) {
        found = true;
        // 再エスケープ
        const escaped = decoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
    } catch {}
    return match;
  });
  
  // 16進数: 0x70, 0x72 → 112, 114
  modified = modified.replace(/0x([0-9a-fA-F]+)/g, (match, hex) => {
    const dec = parseInt(hex, 16);
    if (!isNaN(dec) && dec >= 0 && dec <= 65535) {
      found = true;
      return String(dec);
    }
    return match;
  });
  
  if (!found) {
    return { success: false, error: 'EncryptStringsパターンが見つかりません', method: 'encrypt_strings' };
  }
  
  return { success: true, result: modified, method: 'encrypt_strings' };
}

// ── 定数配列の展開（完全改訂版）──
function deobfuscateConstantArray(code) {
  let modified = code;
  let found = false;
  let passCount = 0;
  
  // 最大10パス（多段テーブル対応）
  while (passCount++ < 10) {
    let changed = false;
    
    // テーブル定義を探す: local name = { ... }
    const arrayPattern = /local\s+(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    const snapshot = modified;
    let match;
    
    while ((match = arrayPattern.exec(snapshot)) !== null) {
      const varName = match[1];
      const content = match[2];
      
      // 配列要素をパース
      const elements = parseLuaArrayElements(content);
      if (elements.length < 1) continue;
      
      // varName[index] を置換
      const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const indexRe = new RegExp(escaped + '\\[([^\\]]+)\\]', 'g');
      
      modified = modified.replace(indexRe, (fullMatch, indexExpr) => {
        // インデックス式を評価
        const idx = evalSimpleExpr(indexExpr.trim());
        if (idx === null || idx < 1 || idx > elements.length) return fullMatch;
        
        found = true;
        changed = true;
        return elements[idx - 1];
      });
    }
    
    if (!changed) break;
  }
  
  if (!found) {
    return { success: false, error: 'ConstantArrayパターンが見つかりません', method: 'constant_array' };
  }
  
  return { success: true, result: modified, method: 'constant_array' };
}

// ── 式の評価 ──
function evaluateExpressions(code) {
  let modified = code, found = false;
  
  // (1 + 2) → 3
  let prev, iters = 0;
  do {
    prev = modified;
    modified = modified.replace(/\(\s*([\d.]+)\s*([\+\-\*\/\%])\s*([\d.]+)\s*\)/g, (match, a, op, b) => {
      const result = evalSimpleExpr(`${a}${op}${b}`);
      if (result === null) return match;
      found = true;
      return String(result);
    });
  } while (modified !== prev && ++iters < 20);
  
  // [1 + 0] → [1]
  modified = modified.replace(/\[\s*([\d\s+\-*\/%().]+)\s*\]/g, (match, expr) => {
    const result = evalSimpleExpr(expr);
    if (result === null) return match;
    found = true;
    return `[${result}]`;
  });
  
  // "abc" .. "def" → "abcdef"
  let concatIter = 0;
  while (/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.*)*)"/g.test(modified) && concatIter++ < 40) {
    modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.*)*)"/g, (_, a, b) => {
      found = true;
      return `"${a}${b}"`;
    });
  }
  
  if (!found) {
    return { success: false, error: '評価できる式がありませんでした', method: 'eval_expressions' };
  }
  
  return { success: true, result: modified, method: 'eval_expressions' };
}

// ── Vmify静的解析 ──
function deobfuscateVmify(code) {
  const hints = [];
  
  if (/return\s*\(function\s*\([^)]*\)/s.test(code)) {
    hints.push('VMラッパー検出');
  }
  
  if (/\bInstructions\b|\bProto\b|\bupValues\b/i.test(code)) {
    hints.push('Luaバイトコード構造を検出');
  }
  
  const strings = [];
  const strPattern = /"([^"\\]{4,}(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = strPattern.exec(code)) !== null) {
    if (m[1].length > 4) strings.push(m[1]);
  }
  
  if (strings.length > 0) {
    hints.push(`${strings.length}件の文字列リテラルを抽出`);
  }
  
  if (/\{(\s*\d+\s*,){8,}/.test(code)) {
    hints.push('大規模バイトコードテーブルを検出');
  }
  
  if (hints.length === 0) {
    return { success: false, error: 'Vmifyパターンが検出されませんでした', method: 'vmify' };
  }
  
  return {
    success: true,
    result: code,
    hints,
    strings: strings.slice(0, 50),
    warning: 'Vmify完全解読には動的実行を推奨',
    method: 'vmify'
  };
}

// ════════════════════════════════════════════════════════
//  AUTO解読（最適化版）
//
//  戦略:
//   1. まず静的解析で前処理（string.char, 配列展開など）
//   2. 動的実行を試みる
//   3. 動的実行の結果をさらに静的解析
//   4. 必要に応じて多段実行
// ════════════════════════════════════════════════════════
async function autoDeobfuscate(code) {
  const results = [];
  let current = code;
  const luaBin = checkLuaAvailable();
  
  // ステップ1: 静的解析で前処理
  const staticSteps = [
    { name: 'EncryptStrings',  fn: deobfuscateEncryptStrings },
    { name: 'SplitStrings',    fn: deobfuscateSplitStrings },
    { name: 'EvalExpressions', fn: evaluateExpressions },
    { name: 'ConstantArray',   fn: deobfuscateConstantArray },
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
  
  // ステップ2: 動的実行
  if (luaBin) {
    const dynRes = await tryDynamicExecution(current);
    results.push({ step: '動的実行 (1回目)', ...dynRes });
    
    if (dynRes.success && dynRes.result) {
      current = dynRes.result;
      
      // ステップ3: 動的実行の結果をさらに静的解析
      for (const step of staticSteps) {
        const res = step.fn(current);
        if (res.success && res.result && res.result !== current) {
          results.push({ step: `${step.name} (動的実行後)`, ...res });
          current = res.result;
        }
      }
      
      // ステップ4: まだ難読化されていれば再度動的実行（最大3回）
      for (let round = 2; round <= 4; round++) {
        const stillObfuscated = /loadstring|load\s*\(|[A-Za-z0-9+/]{60,}={0,2}/.test(current);
        if (!stillObfuscated) break;
        
        const dynRes2 = await tryDynamicExecution(current);
        results.push({ step: `動的実行 (${round}回目)`, ...dynRes2 });
        
        if (dynRes2.success && dynRes2.result && dynRes2.result !== current) {
          current = dynRes2.result;
          
          // 静的解析も再実行
          for (const step of staticSteps) {
            const res = step.fn(current);
            if (res.success && res.result && res.result !== current) {
              current = res.result;
            }
          }
        } else {
          break;
        }
      }
    } else if (staticChanged) {
      // 動的実行が失敗したが静的解析で変化があった場合、XORも試す
      const xorRes = deobfuscateXOR(current);
      results.push({ step: 'XOR', ...xorRes });
      if (xorRes.success && xorRes.result) current = xorRes.result;
    }
  } else {
    // Luaなし → 静的解析のみ
    results.push({ step: '動的実行', success: false, error: 'Luaがインストールされていません', method: 'dynamic' });
    
    const xorRes = deobfuscateXOR(current);
    results.push({ step: 'XOR', ...xorRes });
    if (xorRes.success && xorRes.result) current = xorRes.result;
    
    const vmifyRes = deobfuscateVmify(current);
    results.push({ step: 'Vmify', ...vmifyRes });
  }
  
  return {
    success: results.some(r => r.success),
    steps: results,
    finalCode: current
  };
}

// ════════════════════════════════════════════════════════
//  Prometheus難読化
// ════════════════════════════════════════════════════════
function obfuscateWithPrometheus(code, options = {}) {
  return new Promise(resolve => {
    const luaBin = checkLua51Available();
    if (!luaBin) {
      resolve({ success: false, error: 'lua5.1またはLuaJITがインストールされていません' });
      return;
    }

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
      
      if (err) {
        resolve({ success: false, error: 'Lua: ' + (stderr || '').trim() });
        return;
      }
      
      if (!fs.existsSync(tmpOut)) {
        resolve({ success: false, error: 'Prometheusが出力ファイルを生成しませんでした' });
        return;
      }
      
      const result = fs.readFileSync(tmpOut, 'utf8');
      try { fs.unlinkSync(tmpOut); } catch {}
      
      if (!result || result.trim().length === 0) {
        resolve({ success: false, error: 'Prometheusの出力が空でした' });
        return;
      }
      
      resolve({ success: true, result, preset });
    });
  });
}

// ════════════════════════════════════════════════════════
//  クリーンアップ
// ════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const fp = path.join(tempDir, file);
      fs.stat(fp, (err, stats) => {
        if (!err && now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlink(fp, () => {});
        }
      });
    });
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🔥 Lua Obfuscator/Deobfuscator Server running on port ${PORT}`);
  console.log(`   Lua:        ${checkLuaAvailable() || 'NOT FOUND'}`);
  console.log(`   Prometheus: ${checkPrometheusAvailable() ? 'OK' : 'NOT FOUND (optional)'}`);
});
