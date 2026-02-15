const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// ルートでHTMLを返す
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lua解読ツール by YAJU</title>
<style>
:root{--bg:#0a0a0a;--panel:#141414;--primary:#4db6ac;--text:#e0e0e0}
body{font-family:'Meiryo',sans-serif;background:var(--bg);color:var(--text);margin:0;padding:20px;display:flex;justify-content:center;align-items:center;min-height:100vh}
.container{width:100%;max-width:850px;background:var(--panel);padding:30px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.8);border:1px solid #333}
h1{color:var(--primary);text-align:center;margin-top:0;text-shadow:0 0 10px rgba(77,182,172,.5)}
.info{background:rgba(77,182,172,.1);border-left:4px solid var(--primary);padding:12px;margin:15px 0;border-radius:4px;font-size:.9em}
.control-group{margin-bottom:20px;padding:20px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid #2a2a2a}
label{display:block;margin-bottom:10px;font-weight:bold;color:var(--primary)}
input[type="file"]{display:none}
.file-btn{display:inline-block;background:#222;color:#eee;padding:12px 20px;border-radius:6px;cursor:pointer;border:2px dashed #555;transition:.3s;text-align:center;width:100%;box-sizing:border-box;font-weight:bold;margin-bottom:10px}
.file-btn:hover{background:#333;border-color:var(--primary);color:var(--primary)}
.file-name{font-size:.9em;color:#888;text-align:right;margin-top:5px}
textarea{width:100%;height:200px;background:#080808;color:#2ecc71;border:1px solid #333;border-radius:6px;font-family:'Consolas',monospace;padding:15px;box-sizing:border-box;resize:vertical;font-size:14px}
button.main-btn{background:linear-gradient(135deg,var(--primary),#26a69a);color:#fff;border:none;padding:18px;font-size:18px;font-weight:bold;border-radius:8px;cursor:pointer;width:100%;margin:15px 0;box-shadow:0 4px 15px rgba(77,182,172,.4);transition:.3s;text-transform:uppercase}
button.main-btn:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(77,182,172,.6)}
button.main-btn:disabled{background:#555;cursor:not-allowed;transform:none}
button.copy-btn{background:var(--secondary);color:#fff;border:none;padding:12px;font-weight:bold;border-radius:6px;cursor:pointer;width:100%;margin-top:10px;transition:.2s;background:#ff5252}
button.copy-btn:hover{background:#d32f2f}
.status{text-align:center;margin:10px 0;font-weight:bold;min-height:24px}
.loader{border:3px solid #333;border-top:3px solid var(--primary);border-radius:50%;width:30px;height:30px;animation:spin 1s linear infinite;margin:10px auto;display:none}
@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
.badge{display:inline-block;background:rgba(77,182,172,.2);color:var(--primary);padding:4px 12px;border-radius:12px;font-size:.8em;font-weight:bold;margin-left:10px}
</style>
</head>
<body>
<div class="container">
<h1>🔓 Lua解読ツール<span class="badge">動的実行</span></h1>
<div class="info">
✨ WeAreDevs、YAJU、その他の難読化に対応<br>
🚀 サーバー側で実際にLuaコードを実行して元のコードをキャプチャ<br>
📁 ファイルアップロード対応（.lua / .txt）
</div>

<div class="control-group">
<label>1. 難読化されたコードを入力</label>
<label for="fileInput" class="file-btn">📂 ファイルを選択 (.lua / .txt)</label>
<input type="file" id="fileInput" accept=".lua,.txt">
<div id="fileNameDisplay" class="file-name">ファイル未選択</div>
<textarea id="input" placeholder="難読化されたLuaコードをここに貼り付け..."></textarea>
</div>

<button class="main-btn" onclick="deobfuscate()">🔓 解読を実行</button>
<div class="loader" id="loader"></div>
<div class="status" id="status"></div>

<div class="control-group">
<label>2. 解読結果</label>
<textarea id="output" readonly placeholder="ここに結果が表示されます..."></textarea>
<button class="copy-btn" onclick="copy()">📋 クリップボードにコピー</button>
</div>
</div>

<script>
document.getElementById('fileInput').addEventListener('change', function(e){
const file = e.target.files[0];
if(!file) return;
document.getElementById('fileNameDisplay').textContent = \`選択中: \${file.name} (\${(file.size/1024).toFixed(1)} KB)\`;
const reader = new FileReader();
reader.onload = function(e){
document.getElementById('input').value = e.target.result;
showStatus('ファイルを読み込みました','success');
};
reader.onerror = function(){
showStatus('ファイルの読み込みに失敗しました','error');
};
reader.readAsText(file);
});

async function deobfuscate(){
const input=document.getElementById('input').value;
if(!input.trim()){
showStatus('コードを入力してください','error');
return;
}

const btn=event.target;
btn.disabled=true;
document.getElementById('loader').style.display='block';
showStatus('サーバーでLuaコードを実行中...','process');

try{
const res=await fetch('/api/deobfuscate',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({code:input})
});

const data=await res.json();

if(data.success){
document.getElementById('output').value=data.result;
showStatus('✅ 解読完了！','success');
}else{
document.getElementById('output').value='エラー:\\n'+data.error;
showStatus('❌ '+data.error,'error');
}
}catch(e){
showStatus('❌ サーバーエラー: '+e.message,'error');
}finally{
btn.disabled=false;
document.getElementById('loader').style.display='none';
}
}

function copy(){
const output=document.getElementById('output');
output.select();
document.execCommand('copy');
showStatus('📋 コピーしました','success');
}

function showStatus(msg,type){
const status=document.getElementById('status');
status.textContent=msg;
status.style.color=type==='error'?'#ff5252':type==='success'?'#4db6ac':'#bb86fc';
}
</script>
</body>
</html>
  `);
});

// 解読API
app.post('/api/deobfuscate', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.json({ success: false, error: 'コードが提供されていません' });
  }

  // 動的実行で解読
  const result = await tryDynamicExecution(code);
  res.json(result);
});

// 動的実行
async function tryDynamicExecution(code) {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const tempFile = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

  // 難読化コードをそのまま実行してloadstringをキャプチャ
  const wrapper = `
-- loadstringをフック
local captured_code = nil
local original_loadstring = loadstring or load

_G.loadstring = function(code_str, ...)
  if type(code_str) == "string" and #code_str > 10 then
    captured_code = code_str
  end
  return original_loadstring(code_str, ...)
end

_G.load = _G.loadstring

-- 難読化コードを文字列として読み込み
local obfuscated_code = [[
${code}
]]

-- 実行
local success, result = pcall(function()
  local chunk, err = loadstring(obfuscated_code)
  if not chunk then
    error("Failed to load: " .. tostring(err))
  end
  local ret = chunk()
  return ret
end)

-- 結果を出力
if captured_code then
  io.write("__CAPTURED_START__")
  io.write(captured_code)
  io.write("__CAPTURED_END__")
elseif success and type(result) == "function" then
  -- 関数が返された場合、実行してみる
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

  return new Promise((resolve) => {
    fs.writeFileSync(tempFile, wrapper, 'utf8');

    exec(`lua ${tempFile}`, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}

      if (error && !stdout.includes('__CAPTURED_START__')) {
        return resolve({ 
          success: false, 
          error: '実行エラー: ' + (stderr || error.message)
        });
      }

      if (stdout.includes('__CAPTURED_START__') && stdout.includes('__CAPTURED_END__')) {
        const start = stdout.indexOf('__CAPTURED_START__') + '__CAPTURED_START__'.length;
        const end = stdout.indexOf('__CAPTURED_END__');
        const captured = stdout.substring(start, end);
        
        if (captured && captured.length > 5) {
          return resolve({ success: true, result: captured });
        }
      }

      if (stdout.includes('__ERROR__:')) {
        const errMsg = stdout.split('__ERROR__:')[1];
        return resolve({ success: false, error: 'Luaエラー: ' + errMsg });
      }

      resolve({ success: false, error: '解読に失敗しました。loadstring()が呼ばれていない可能性があります。' });
    });
  });
}

// クリーンアップ
setInterval(() => {
  const now = Date.now();
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
