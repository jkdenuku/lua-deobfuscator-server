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
🚀 サーバー側で実際にLuaコードを実行してprint()の出力をキャプチャ<br>
📁 ファイルアップロード対応（.lua / .txt）
</div>

<div class="control-group">
<label>1. 難読化されたコードを入力</label>
<label for="fileInput" class="file-btn">📂 ファイルを選択 (.lua / .txt)</label>
<input type="file" id="fileInput" accept=".lua,.txt">
<div id="fileNameDisplay" class="file-name">ファイル未選択</div>
<textarea id="input" placeholder="難読化されたLuaコードをここに貼り付け、またはファイルを選択..."></textarea>
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
// ファイル読み込み
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

  // 方法1: 動的実行を試す
  const dynamicResult = await tryDynamicExecution(code);
  if (dynamicResult.success) {
    return res.json(dynamicResult);
  }

  // 方法2: 静的解析（WeAreDevs形式）
  const staticResult = tryStaticAnalysis(code);
  if (staticResult.success) {
    return res.json(staticResult);
  }

  // 失敗
  res.json({
    success: false,
    error: '解読に失敗しました。対応していない形式の可能性があります。'
  });
});

// 動的実行
async function tryDynamicExecution(code) {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const tempFile = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

  // コードをそのまま実行（vararg問題を回避）
  const wrapper = `
local captured_output = {}
local original_print = print

_G.print = function(...)
  local args = {...}
  local line = {}
  for i = 1, select('#', ...) do
    table.insert(line, tostring(select(i, ...)))
  end
  table.insert(captured_output, table.concat(line, "\\t"))
end

-- 実行
local success, err = pcall(function()
  ${code}
end)

-- 出力
if #captured_output > 0 then
  for _, line in ipairs(captured_output) do
    original_print(line)
  end
else
  original_print("__NO_OUTPUT__")
end

if not success then
  original_print("__ERROR__: " .. tostring(err))
end
`;

  return new Promise((resolve) => {
    fs.writeFileSync(tempFile, wrapper, 'utf8');

    exec(`lua ${tempFile}`, { timeout: 5000 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}

      if (error) {
        return resolve({ success: false, error: stderr || error.message });
      }

      if (stdout.includes('__ERROR__:')) {
        return resolve({ success: false, error: '実行エラー' });
      }

      if (stdout.includes('__NO_OUTPUT__')) {
        return resolve({ success: false, error: '出力なし' });
      }

      resolve({ success: true, result: stdout.trim() });
    });
  });
}

// 静的解析（WeAreDevs）
function tryStaticAnalysis(code) {
  try {
    const match = code.match(/local o=\{([\s\S]+?)\}(?:local function|do\s)/);
    if (!match) return { success: false };

    const tableContent = match[1];
    const strings = [];
    const regex = /"((?:[^"\\]|\\.)*)"/g;
    let m;

    while ((m = regex.exec(tableContent)) !== null) {
      const raw = m[1];
      let decoded = '';
      let i = 0;

      while (i < raw.length) {
        if (raw[i] === '\\' && i + 3 < raw.length) {
          const oct = raw.substring(i + 1, i + 4);
          if (/^\d{3}$/.test(oct)) {
            decoded += String.fromCharCode(parseInt(oct, 8));
            i += 4;
            continue;
          }
        }
        decoded += raw[i];
        i++;
      }

      strings.push(decoded);
    }

    // Luaコードを含む文字列を探す
    let best = '';
    let bestScore = 0;

    for (const str of strings) {
      let score = 0;
      if (str.includes('print')) score += 1000;
      if (str.includes('local')) score += 100;
      if (str.includes('function')) score += 50;
      score += str.length;

      if (score > bestScore) {
        bestScore = score;
        best = str;
      }
    }

    if (best && bestScore > 100) {
      return { success: true, result: best };
    }

    return { success: false };
  } catch (e) {
    return { success: false };
  }
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
