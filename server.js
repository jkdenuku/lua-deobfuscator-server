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
    deobfuscateMethods: ['auto', 'xor', 'split_strings', 'encrypt_strings', 'constant_array', 'vmify', 'dynamic'],
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
    case 'constant_array':  result = deobfuscateConstantArray(code);  break;
    case 'vmify':           result = deobfuscateVmify(code);         break;
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
//  動的実行 (オリジナル: loadstring フック)
// ════════════════════════════════════════════════════════
async function tryDynamicExecution(code) {
  const luaBin = checkLuaAvailable();
  if (!luaBin) return { success: false, error: 'Luaがインストールされていません', method: 'dynamic' };

  const timestamp = Date.now();
  const randomId  = Math.random().toString(36).substring(7);
  const tempFile  = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

  // [[ ]] の中に ]] が含まれる場合に備えてエスケープ
  const safeCode = code.replace(/\]\]/g, '] ]');

  const wrapper = `
-- loadstring をフック
local captured_code = nil
local original_loadstring = loadstring or load

_G.loadstring = function(code_str, ...)
  if type(code_str) == "string" and #code_str > 10 then
    captured_code = code_str
  end
  return original_loadstring(code_str, ...)
end
_G.load = _G.loadstring

-- 難読化コードを読み込んで実行
local obfuscated_code = [[
${safeCode}
]]

local success, result = pcall(function()
  local chunk, err = loadstring(obfuscated_code)
  if not chunk then error("Failed to load: " .. tostring(err)) end
  return chunk()
end)

if captured_code then
  io.write("__CAPTURED_START__")
  io.write(captured_code)
  io.write("__CAPTURED_END__")
elseif success and type(result) == "function" then
  local success2, result2 = pcall(result)
  if captured_code then
    io.write("__CAPTURED_START__")
    io.write(captured_code)
    io.write("__CAPTURED_END__")
  else
    io.write("__NO_CAPTURE__")
  end
else
  io.write("__NO_CAPTURE__")
  if not success then
    io.write("__ERROR__:")
    io.write(tostring(result))
  end
end
`;

  return new Promise(resolve => {
    fs.writeFileSync(tempFile, wrapper, 'utf8');

    exec(`${luaBin} ${tempFile}`, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch {}

      if (error && !stdout.includes('__CAPTURED_START__')) {
        return resolve({ success: false, error: '実行エラー: ' + (stderr || error.message), method: 'dynamic' });
      }

      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const start    = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const end      = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(start, end);
        if (captured && captured.length > 5) {
          return resolve({ success: true, result: captured, method: 'dynamic' });
        }
      }

      if (stdout.includes('__ERROR__:')) {
        return resolve({ success: false, error: 'Luaエラー: ' + stdout.split('__ERROR__:')[1], method: 'dynamic' });
      }

      resolve({ success: false, error: '解読に失敗しました。loadstring()が呼ばれていない可能性があります。', method: 'dynamic' });
    });
  });
}

// ════════════════════════════════════════════════════════
//  静的解読メソッド群
// ════════════════════════════════════════════════════════

// ── XOR ──────────────────────────────────────────────────
function xorDecryptByte(byte, key) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    const a = (byte >> i) & 1, b = (key >> i) & 1;
    if (a !== b) result |= (1 << i);
  }
  return result;
}
function scoreLuaCode(code) {
  const keywords = ['local','function','end','if','then','else','return','for','do','while','and','or','not','nil','true','false','print','table','string','math'];
  let score = 0;
  keywords.forEach(kw => { const m = code.match(new RegExp('\\b'+kw+'\\b','g')); if (m) score += m.length * 10; });
  let printable = 0;
  for (let i = 0; i < code.length; i++) { const c = code.charCodeAt(i); if (c >= 32 && c <= 126) printable++; }
  score += (printable / code.length) * 100;
  return score;
}
function deobfuscateXOR(code) {
  const patterns = [/local\s+\w+\s*=\s*\{([0-9,\s]+)\}/g, /\{([0-9,\s]+)\}/g];
  let encryptedArrays = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
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

// ── SplitStrings ─────────────────────────────────────────
function deobfuscateSplitStrings(code) {
  let modified = code, found = false, iterations = 0;
  while (/"([^"\\]*(\\.[^"\\]*)*)"\s*\.\.\s*"([^"\\]*(\\.[^"\\]*)*)"/.test(modified) && iterations < 30) {
    modified = modified.replace(/"([^"\\]*(\\.[^"\\]*)*)"\s*\.\.\s*"([^"\\]*(\\.[^"\\]*)*)"/g, (_, p1, _2, p2) => `"${p1}${p2}"`);
    found = true; iterations++;
  }
  while (/'([^'\\]*(\\.[^'\\]*)*)'\s*\.\.\s*'([^'\\]*(\\.[^'\\]*)*)'/.test(modified) && iterations < 60) {
    modified = modified.replace(/'([^'\\]*(\\.[^'\\]*)*)'\s*\.\.\s*'([^'\\]*(\\.[^'\\]*)*)'/g, (_, p1, _2, p2) => `'${p1}${p2}'`);
    found = true; iterations++;
  }
  if (!found) return { success: false, error: 'SplitStringsパターンが見つかりません', method: 'split_strings' };
  return { success: true, result: modified, method: 'split_strings' };
}

// ── EncryptStrings ───────────────────────────────────────
function deobfuscateEncryptStrings(code) {
  let modified = code, found = false;
  modified = modified.replace(/string\.char\(([0-9,\s]+)\)/g, (_, nums) => {
    const chars = nums.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 127);
    if (chars.length === 0) return _;
    found = true;
    return `"${chars.map(c => String.fromCharCode(c)).join('')}"`;
  });
  if (/\\x[0-9a-fA-F]{2}/.test(modified)) {
    modified = modified.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => { found = true; return String.fromCharCode(parseInt(hex, 16)); });
  }
  if (!found) return { success: false, error: 'EncryptStringsパターンが見つかりません', method: 'encrypt_strings' };
  return { success: true, result: modified, method: 'encrypt_strings' };
}

// ── ConstantArray ────────────────────────────────────────
function deobfuscateConstantArray(code) {
  const arrayPattern = /local\s+(\w+)\s*=\s*\{([^}]+)\}/g;
  let modified = code, found = false, match;
  while ((match = arrayPattern.exec(code)) !== null) {
    const varName = match[1], content = match[2];
    const elements = [];
    let cur = '', depth = 0, inStr = false, strChar = '';
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (!inStr && (c==='"'||c==="'")) { inStr=true; strChar=c; cur+=c; }
      else if (inStr && c===strChar && content[i-1]!=='\\') { inStr=false; cur+=c; }
      else if (!inStr && c==='{') { depth++; cur+=c; }
      else if (!inStr && c==='}') { depth--; cur+=c; }
      else if (!inStr && c===',' && depth===0) { elements.push(cur.trim()); cur=''; }
      else cur+=c;
    }
    if (cur.trim()) elements.push(cur.trim());
    if (elements.length < 2) continue;
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    for (let i = 0; i < elements.length; i++) {
      const re = new RegExp(escaped+'\\[\\s*'+(i+1)+'\\s*\\]','g');
      if (re.test(modified)) { modified = modified.replace(re, elements[i]); found = true; }
    }
  }
  if (!found) return { success: false, error: 'ConstantArrayパターンが見つかりません', method: 'constant_array' };
  return { success: true, result: modified, method: 'constant_array' };
}

// ── Vmify (静的解析) ─────────────────────────────────────
function deobfuscateVmify(code) {
  const hints = [];
  if (/return\s*\(function\s*\([^)]*\)[^e]*end\s*\)\s*\(/s.test(code)) hints.push('VMラッパー検出 (関数ラップパターン)');
  const strings = [];
  const strPattern = /"([^"\\]{4,}(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = strPattern.exec(code)) !== null) { if (!m[1].includes('\\') || m[1].length > 8) strings.push(m[1]); }
  if (strings.length > 0) hints.push(`VMコードから${strings.length}件の文字列を抽出`);
  if (/\{(\s*\d+\s*,){5,}/.test(code)) hints.push('バイトコード命令テーブルを検出');
  if (hints.length === 0) return { success: false, error: 'Vmifyパターンが検出されませんでした。動的実行モードをお試しください。', method: 'vmify' };
  return { success: true, result: code, hints, strings: strings.slice(0, 50), warning: 'Vmify解読は静的解析のみです。完全な解読には動的実行 (AUTO) が有効です。', method: 'vmify' };
}

// ── AUTO (静的 → 動的実行の順で試行) ───────────────────
async function autoDeobfuscate(code) {
  const results = [];
  let current = code;

  const staticSteps = [
    { name: 'SplitStrings',   fn: deobfuscateSplitStrings },
    { name: 'EncryptStrings', fn: deobfuscateEncryptStrings },
    { name: 'ConstantArray',  fn: deobfuscateConstantArray },
    { name: 'XOR',            fn: deobfuscateXOR },
    { name: 'Vmify',          fn: deobfuscateVmify },
  ];

  let anyStaticSuccess = false;
  for (const step of staticSteps) {
    const res = step.fn(current);
    results.push({ step: step.name, ...res });
    if (res.success && res.result && res.result !== current) {
      current = res.result;
      anyStaticSuccess = true;
    }
  }

  // Luaが使える場合は動的実行も試みる
  const luaBin = checkLuaAvailable();
  if (luaBin) {
    const dynRes = await tryDynamicExecution(anyStaticSuccess ? current : code);
    results.push({ step: '動的実行 (loadstring hook)', ...dynRes });
    if (dynRes.success && dynRes.result) current = dynRes.result;
  } else {
    results.push({ step: '動的実行', success: false, error: 'Luaがインストールされていないためスキップ', method: 'dynamic' });
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
    const steps  = options.steps  || [];

    // 正しい引数順: lua cli.lua --preset Medium input.lua --out output.lua
    const cmd = `${luaBin} ${cliPath} --preset ${preset} ${tmpIn} --out ${tmpOut}`;

    exec(cmd, { timeout: 30000, cwd: path.dirname(cliPath) }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      try {
        if (err) { resolve({ success: false, error: stderr || err.message }); return; }
        if (!fs.existsSync(tmpOut)) { resolve({ success: false, error: 'Prometheusが出力を生成しませんでした' }); return; }
        const result = fs.readFileSync(tmpOut, 'utf8');
        resolve({ success: true, result, preset, steps });
      } finally {
        try { fs.unlinkSync(tmpOut); } catch {}
      }
    });
  });
}

// ════════════════════════════════════════════════════════
//  古い一時ファイルのクリーンアップ
// ════════════════════════════════════════════════════════
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
