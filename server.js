const express = require('express');
const cors    = require('cors');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── public/ フォルダを静的配信 (index.html が自動で返る) ──
app.use(express.static(path.join(__dirname, 'public')));

// temp ディレクトリ
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ════════════════════════════════════════════════════════
//  解読 API  POST /api/deobfuscate
// ════════════════════════════════════════════════════════
app.post('/api/deobfuscate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, error: 'コードが提供されていません' });

  const result = await tryDynamicExecution(code);
  res.json(result);
});

// ── Lua 動的実行 (loadstring フック) ────────────────────
async function tryDynamicExecution(code) {
  const timestamp = Date.now();
  const randomId  = Math.random().toString(36).substring(7);
  const tempFile  = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

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
${code}
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

    exec(`lua ${tempFile}`, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}

      if (error && !stdout.includes('__CAPTURED_START__')) {
        return resolve({ success: false, error: '実行エラー: ' + (stderr || error.message) });
      }

      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const start    = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const end      = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(start, end);
        if (captured && captured.length > 5) {
          return resolve({ success: true, result: captured });
        }
      }

      if (stdout.includes('__ERROR__:')) {
        return resolve({ success: false, error: 'Luaエラー: ' + stdout.split('__ERROR__:')[1] });
      }

      resolve({ success: false, error: '解読に失敗しました。loadstring()が呼ばれていない可能性があります。' });
    });
  });
}

// ── 古い一時ファイルのクリーンアップ ────────────────────
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
