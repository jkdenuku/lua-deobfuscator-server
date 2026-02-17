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

// ── ルート: 難読化 + 解読 統合UI ──────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lua コードツール by YAJU</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Noto+Sans+JP:wght@300;400;700&display=swap');
:root{
  --bg:#060810;--panel:#0d1117;
  --obf-primary:#ff3c5a;--obf-glow:rgba(255,60,90,.5);
  --deobf-primary:#00e5ff;--deobf-glow:rgba(0,229,255,.5);
  --text:#d0d8e8;--muted:#556070;--border:#1e2535;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans JP',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,229,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrapper{position:relative;z-index:1;max-width:1000px;margin:0 auto;padding:28px 20px 60px}
.site-header{text-align:center;margin-bottom:36px}
.site-title{font-family:'Share Tech Mono',monospace;font-size:clamp(20px,4vw,34px);letter-spacing:.12em;color:#fff;text-shadow:0 0 20px rgba(255,255,255,.25);margin-bottom:6px}
.site-sub{font-size:.82em;color:var(--muted);letter-spacing:.08em}
.mode-selector{display:flex;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:30px;position:relative}
.mode-btn{flex:1;padding:18px 12px;border:none;background:transparent;color:var(--muted);font-family:'Share Tech Mono',monospace;font-size:clamp(13px,2.5vw,17px);letter-spacing:.1em;cursor:pointer;transition:all .3s;position:relative;z-index:1}
.mode-btn::after{content:'';position:absolute;inset:0;opacity:0;transition:opacity .3s}
.mode-btn.obf::after{background:linear-gradient(135deg,rgba(255,60,90,.12),transparent)}
.mode-btn.deobf::after{background:linear-gradient(135deg,rgba(0,229,255,.12),transparent)}
.mode-btn.active.obf{color:var(--obf-primary);text-shadow:0 0 12px var(--obf-glow)}
.mode-btn.active.deobf{color:var(--deobf-primary);text-shadow:0 0 12px var(--deobf-glow)}
.mode-btn.active::after{opacity:1}
.mode-divider{width:1px;background:var(--border);flex-shrink:0}
.mode-indicator{position:absolute;bottom:0;left:0;height:3px;width:50%;border-radius:3px 3px 0 0;transition:all .4s cubic-bezier(.4,0,.2,1)}
.mode-indicator.obf{background:var(--obf-primary);box-shadow:0 0 12px var(--obf-glow)}
.mode-indicator.deobf{background:var(--deobf-primary);box-shadow:0 0 12px var(--deobf-glow);left:50%}
.tool-panel{display:none}
.tool-panel.active{display:block}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:22px;margin-bottom:20px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.obf-panel .card::before{background:linear-gradient(90deg,transparent,var(--obf-primary),transparent)}
.deobf-panel .card::before{background:linear-gradient(90deg,transparent,var(--deobf-primary),transparent)}
.card-label{font-family:'Share Tech Mono',monospace;font-size:.78em;letter-spacing:.14em;margin-bottom:14px}
.obf-panel .card-label{color:var(--obf-primary)}
.deobf-panel .card-label{color:var(--deobf-primary)}
.file-btn{display:block;background:#0a0f18;color:#aaa;padding:14px;border-radius:6px;cursor:pointer;border:1px dashed var(--border);transition:.25s;text-align:center;font-size:.9em;margin-bottom:10px}
.obf-panel .file-btn:hover{border-color:var(--obf-primary);color:var(--obf-primary)}
.deobf-panel .file-btn:hover{border-color:var(--deobf-primary);color:var(--deobf-primary)}
.file-name{font-size:.8em;color:var(--muted);text-align:right;margin-bottom:8px}
input[type="file"]{display:none}
textarea{width:100%;background:#060a10;color:#41e882;border:1px solid var(--border);border-radius:6px;font-family:'Share Tech Mono',monospace;padding:14px;resize:vertical;font-size:13px;line-height:1.6;transition:border-color .25s}
textarea:focus{outline:none}
.obf-panel textarea:focus{border-color:rgba(255,60,90,.4)}
.deobf-panel textarea:focus{border-color:rgba(0,229,255,.4)}
.range-row{display:flex;align-items:center;gap:14px;margin:10px 0 4px}
input[type="range"]{flex:1;height:4px;border-radius:4px;background:var(--border);cursor:pointer;-webkit-appearance:none}
.obf-panel input[type="range"]{accent-color:var(--obf-primary)}
.range-val{font-family:'Share Tech Mono',monospace;font-size:1em;min-width:44px;text-align:right;color:var(--obf-primary)}
.checks-grid{display:flex;flex-wrap:wrap;gap:10px 24px}
.chk-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.88em;color:#bbb;transition:color .2s}
.chk-label:hover{color:#fff}
.chk-label input{transform:scale(1.2)}
.obf-panel .chk-label input{accent-color:var(--obf-primary)}
.warn{background:rgba(255,152,0,.08);border-left:3px solid #ff9800;padding:10px 14px;border-radius:4px;font-size:.82em;color:#ffb74d;margin-top:8px}
.info-box{background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.15);border-radius:8px;padding:16px;margin-bottom:16px;font-size:.85em;line-height:1.8;color:#99d6e0}
.info-box strong{color:var(--deobf-primary)}
.info-box code{font-family:'Share Tech Mono',monospace;background:rgba(0,229,255,.1);padding:1px 5px;border-radius:3px}
.main-btn{width:100%;padding:17px;border:none;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:clamp(14px,2.5vw,18px);letter-spacing:.1em;cursor:pointer;transition:.3s;margin-top:6px}
.main-btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important}
.obf-panel .main-btn{background:linear-gradient(135deg,var(--obf-primary),#b71c1c);color:#fff;box-shadow:0 4px 20px rgba(255,60,90,.35)}
.obf-panel .main-btn:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(255,60,90,.55)}
.deobf-panel .main-btn{background:linear-gradient(135deg,var(--deobf-primary),#006064);color:#000;box-shadow:0 4px 20px rgba(0,229,255,.3)}
.deobf-panel .main-btn:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(0,229,255,.5)}
.progress-wrap{height:4px;background:#0a0f18;border-radius:4px;margin:14px 0;overflow:hidden;display:none}
.progress-fill{height:100%;width:0;border-radius:4px;transition:width .1s linear}
.obf-panel .progress-fill{background:var(--obf-primary);box-shadow:0 0 8px var(--obf-glow)}
.loader{border:3px solid #1e2535;border-top:3px solid var(--deobf-primary);border-radius:50%;width:28px;height:28px;animation:spin 1s linear infinite;margin:10px auto;display:none}
@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
.status-line{text-align:center;font-size:.9em;font-family:'Share Tech Mono',monospace;min-height:1.4em;padding:6px 0;letter-spacing:.06em}
.copy-btn{width:100%;margin-top:10px;padding:11px;border:none;border-radius:6px;font-family:'Share Tech Mono',monospace;font-size:.88em;letter-spacing:.08em;cursor:pointer;transition:.2s}
.obf-panel .copy-btn{background:#222c3a;color:#eee}
.obf-panel .copy-btn:hover{background:var(--obf-primary);color:#fff}
.deobf-panel .copy-btn{background:#0a1e22;color:#eee}
.deobf-panel .copy-btn:hover{background:var(--deobf-primary);color:#000}
.discord-btn{position:fixed;bottom:28px;right:28px;width:54px;height:54px;background:#5865F2;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(88,101,242,.45);transition:.3s;text-decoration:none;z-index:100}
.discord-btn:hover{transform:translateY(-4px) scale(1.08)}
.discord-btn svg{width:28px;height:28px;fill:#fff}
small.hint{display:block;color:var(--muted);font-size:.78em;margin-top:5px}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#0a0f18}::-webkit-scrollbar-thumb{background:#2a3550;border-radius:3px}
</style>
</head>
<body>
<div class="wrapper">
  <header class="site-header">
    <div class="site-title">[ LUA CODE TOOL :: YAJU ]</div>
    <div class="site-sub">OBFUSCATOR &amp; DEOBFUSCATOR</div>
  </header>

  <!-- モード切替 -->
  <div class="mode-selector">
    <button class="mode-btn obf active" id="btnModeObf" onclick="switchMode('obf')">🔒 難読化</button>
    <div class="mode-divider"></div>
    <button class="mode-btn deobf" id="btnModeDeobf" onclick="switchMode('deobf')">🔓 解読 (Deobfuscator)</button>
    <div class="mode-indicator obf" id="modeIndicator"></div>
  </div>

  <!-- ══ 難読化パネル ══ -->
  <div class="tool-panel obf-panel active" id="panelObf">
    <div class="card">
      <div class="card-label">[ 01 ] IMPORT CODE</div>
      <label for="obfFileInput" class="file-btn">📂 ファイルを選択 (.lua / .txt)</label>
      <input type="file" id="obfFileInput" accept=".lua,.txt">
      <div id="obfFileName" class="file-name">ファイル未選択</div>
      <textarea id="obfInput" rows="8" placeholder="ここにLuaコードを貼り付けるか、ファイルを読み込んでください..."></textarea>
    </div>
    <div class="card">
      <div class="card-label">[ 02 ] ENCRYPTION LAYERS</div>
      <div class="range-row">
        <span style="font-size:.82em;color:#888">Base64層数</span>
        <input type="range" id="b64Layers" min="1" max="50" value="5" oninput="updateObfUI()">
        <span class="range-val" id="layerVal">5</span>
      </div>
      <div id="layerWarning" class="warn" style="display:none">⚠️ 30層以上は処理に時間がかかります</div>
      <small class="hint">推奨: 5〜15層 ／ 最大50層</small>
      <div class="card-label" style="margin-top:18px">[ 03 ] JUNK CODE INTENSITY</div>
      <div class="range-row">
        <span style="font-size:.82em;color:#888">ダミーコード</span>
        <input type="range" id="junkIntensity" min="1" max="500" value="200" oninput="updateObfUI()">
        <span class="range-val" id="junkVal">200</span>
      </div>
      <small class="hint">推奨: 150〜300 ／ 最大500</small>
    </div>
    <div class="card">
      <div class="card-label">[ 04 ] ADVANCED OPTIONS</div>
      <div class="checks-grid">
        <label class="chk-label"><input type="checkbox" id="chkXor" checked>XOR難読化</label>
        <label class="chk-label"><input type="checkbox" id="chkShuffle" checked>シャッフル</label>
        <label class="chk-label"><input type="checkbox" id="chkFlat" checked>制御フロー平坦化</label>
        <label class="chk-label" style="color:var(--obf-primary)"><input type="checkbox" id="chkAntiDump" checked>アンチダンパー</label>
        <label class="chk-label" style="color:#ff9800"><input type="checkbox" id="chkDecimalStr" checked>文字列→10進数変換</label>
        <label class="chk-label" style="color:#ff9800"><input type="checkbox" id="chkNumExpr" checked>数値→数式偽装</label>
        <label class="chk-label" style="color:#ff9800"><input type="checkbox" id="chkJunkFunc" checked>ゴミ関数注入</label>
        <label class="chk-label" style="color:var(--deobf-primary)"><input type="checkbox" id="chkLite">軽量化モード</label>
      </div>
      <div id="liteModeInfo" style="display:none;margin-top:10px;font-size:.82em;color:#80deea;padding:8px 12px;background:rgba(0,229,255,.07);border-left:3px solid var(--deobf-primary);border-radius:4px">軽量化モード: ファイルサイズを自動的に小さくします</div>
    </div>
    <button class="main-btn" id="btnObfuscate">⚡ 難読化を実行</button>
    <div class="progress-wrap" id="obfProgress"><div class="progress-fill" id="obfProgressFill"></div></div>
    <div class="status-line" id="obfStatus" style="color:#4db6ac">READY</div>
    <div class="card">
      <div class="card-label">[ 05 ] OUTPUT</div>
      <textarea id="obfOutput" rows="8" readonly placeholder="難読化されたコードがここに表示されます..."></textarea>
      <button class="copy-btn" id="btnObfCopy">📋 クリップボードにコピー</button>
    </div>
  </div>

  <!-- ══ 解読パネル ══ -->
  <div class="tool-panel deobf-panel" id="panelDeobf">
    <div class="info-box">
      <strong>Dynamic Deobfuscator</strong> — サーバー側でLuaコードを実際に実行し、<code>loadstring()</code>をフックして元コードをキャプチャします。<br>
      ✨ WeAreDevs / YAJU / その他の難読化に対応 &nbsp;｜&nbsp; 🚀 動的実行方式
    </div>
    <div class="card">
      <div class="card-label">[ 01 ] IMPORT OBFUSCATED CODE</div>
      <label for="deobfFileInput" class="file-btn">📂 難読化済みファイルを選択 (.lua / .txt)</label>
      <input type="file" id="deobfFileInput" accept=".lua,.txt">
      <div id="deobfFileName" class="file-name">ファイル未選択</div>
      <textarea id="deobfInput" rows="8" placeholder="難読化されたLuaコードを貼り付けてください..."></textarea>
    </div>
    <button class="main-btn" id="btnDeobfuscate">🔬 解読を実行</button>
    <div class="loader" id="deobfLoader"></div>
    <div class="status-line" id="deobfStatus" style="color:var(--deobf-primary)">READY</div>
    <div class="card">
      <div class="card-label">[ 02 ] DEOBFUSCATED OUTPUT</div>
      <textarea id="deobfOutput" rows="10" readonly placeholder="解読されたコードがここに表示されます..."></textarea>
      <button class="copy-btn" id="btnDeobfCopy">📋 クリップボードにコピー</button>
    </div>
  </div>
</div>

<a href="https://discord.gg/qHmudNCUJ9" target="_blank" class="discord-btn" title="Discordサーバーに参加">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 127.14 96.36"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
</a>

<script>
/* ── モード切替 ── */
function switchMode(mode){
  const isObf = mode==='obf';
  document.getElementById('btnModeObf').classList.toggle('active',isObf);
  document.getElementById('btnModeDeobf').classList.toggle('active',!isObf);
  document.getElementById('panelObf').classList.toggle('active',isObf);
  document.getElementById('panelDeobf').classList.toggle('active',!isObf);
  document.getElementById('modeIndicator').className='mode-indicator '+mode;
}
const byId=t=>document.getElementById(t);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ════════════════════════════
   難読化ロジック
════════════════════════════ */
function updateObfUI(){
  const l=parseInt(byId('b64Layers').value);
  byId('layerVal').innerText=l;
  byId('layerWarning').style.display=l>=30?'block':'none';
  byId('junkVal').innerText=byId('junkIntensity').value;
}
function setObfStatus(msg,type){
  const el=byId('obfStatus');el.innerText=msg;
  el.style.color=type==='error'?'#ff3c5a':type==='process'?'#bb86fc':'#4db6ac';
}
function updateObfProgress(pct){
  byId('obfProgress').style.display='block';
  byId('obfProgressFill').style.width=pct+'%';
}
function randomString(n){
  const c="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
  let s="";for(let i=0;i<n;i++)s+=c[Math.floor(Math.random()*c.length)];return s;
}
function generateVarName(lite){
  if(lite){const t="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";return t[Math.floor(Math.random()*t.length)];}
  // ホモグリフ: I・l・O・0・1・_ を混在させて見た目で完全に区別不能にする
  const starts=["I","l","O","Il","lI","OI","IO","lO","Ol","IlO","lIO"];
  let e=starts[Math.floor(Math.random()*starts.length)];
  const chars=["I","l","O","_","1","0","Il","lI","OI","IO"];
  const len=12+Math.floor(10*Math.random());
  for(let a=0;a<len;a++)e+=chars[Math.floor(Math.random()*chars.length)];
  return e;
}
function strToChar(str){let c=[];for(let i=0;i<str.length;i++)c.push(str.charCodeAt(i));return \`string.char(\${c.join(',')})\`;}
function bytesToBase64(t){return btoa(Array.from(t,t=>String.fromCodePoint(t)).join(""));}

// ── 新強化機能 ────────────────────────────────────────────────────

// 文字列を string.char(10進数...) に完全変換
function strToDecimalChar(str){
  const codes=[];
  for(let i=0;i<str.length;i++)codes.push(str.charCodeAt(i));
  return \`string.char(\${codes.join(',')})\`;
}

// 数値を数式に偽装 例: 42 → (6*7) or (math.floor(85/2)) etc.
function numToExpr(n){
  const r=Math.random();
  if(r<0.25&&n>1){
    // 積に分解
    for(let a=2;a<=Math.min(20,n);a++){
      if(n%a===0)return \`(\${a}*\${n/a})\`;
    }
  }
  if(r<0.5){
    // 加算
    const offset=Math.floor(Math.random()*50)+1;
    return \`(\${n+offset}-\${offset})\`;
  }
  if(r<0.75){
    // math.floor
    return \`(math.floor(\${(n*10).toFixed(0)}/10))\`;
  }
  // XOR
  const x=Math.floor(Math.random()*255)+1;
  return \`(bit32 and bit32.bxor(\${n^x},\${x}) or \${n})\`;
}

// 文字列を複数チャンクに分割して .. 連結で組み立て
function strToConcat(str, lite){
  if(str.length<=8||lite)return \`"\${str}"\`;
  const parts=[];
  let i=0;
  while(i<str.length){
    const len=3+Math.floor(Math.random()*8);
    parts.push(\`"\${str.slice(i,i+len)}"\`);
    i+=len;
  }
  return parts.join('..');
}

// ゴミ関数（呼ばれないが構文的に正しい複雑な関数）を生成
function generateJunkFunction(lite){
  const fn=generateVarName(lite);
  const a=generateVarName(lite),b=generateVarName(lite),c=generateVarName(lite);
  const patterns=[
    \`local function \${fn}(\${a},\${b})local \${c}=0;for i=1,\${numToExpr(Math.floor(Math.random()*10)+1)} do \${c}=\${c}+\${a}*i end;return \${c}+\${b} end\`,
    \`local function \${fn}(\${a})local \${b}={};for i=1,#\${a} do \${b}[i]=string.byte(\${a},i)+\${numToExpr(Math.floor(Math.random()*10)+1)} end;return table.concat(\${b},",") end\`,
    \`local function \${fn}(\${a},\${b},\${c})if \${a}>\${b} then return \${a}-\${c} elseif \${b}>\${c} then return \${b}*2 else return \${c} end end\`,
    \`local \${fn};do local \${a}=\${numToExpr(Math.floor(Math.random()*100)+1)};local \${b}=\${numToExpr(Math.floor(Math.random()*100)+1)};\${fn}=function()return \${a}+\${b} end end\`,
  ];
  return patterns[Math.floor(Math.random()*patterns.length)]+(lite?';':';\n');
}

// 数値リテラルを数式で偽装しながらダミー変数を生成
function generateNumericJunk(lite){
  const v=generateVarName(lite);
  const n=Math.floor(Math.random()*1000)+1;
  return \`local \${v}=\${numToExpr(n)};\${lite?'':'\\n'}\`;
}
function generateMassiveJunkCode(count,lite){
  let e="";
  const a=[
    // 既存パターン
    ()=>\`local \${generateVarName(lite)}=\${Math.floor(1e4*Math.random())};\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}="\${randomString(lite?10:20)}";\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}=function()return \${Math.random()}end;\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}={\${Array.from({length:lite?3:5},()=>Math.random()).join(",")}};\${lite?'':'\\n'}\`,
    ()=>\`if \${Math.random()>.5}then local \${generateVarName(lite)}=nil end;\${lite?'':'\\n'}\`,
    ()=>\`for \${generateVarName(lite)}=1,\${Math.floor(10*Math.random())}do end;\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}=string.char(\${Math.floor(128*Math.random())});\${lite?'':'\\n'}\`,
    ()=>\`while false do local \${generateVarName(lite)}=true;break;end;\${lite?'':'\\n'}\`,
    // ── 新強化パターン ──
    // 数値を数式で偽装
    ()=>generateNumericJunk(lite),
    ()=>generateNumericJunk(lite),
    // ゴミ関数（構文的に正しいが絶対呼ばれない）
    ()=>generateJunkFunction(lite),
    ()=>generateJunkFunction(lite),
    // string.char(10進数) で文字列を偽装
    ()=>\`local \${generateVarName(lite)}=\${strToDecimalChar(randomString(lite?4:8))};\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}=\${strToDecimalChar(randomString(lite?4:8))};\${lite?'':'\\n'}\`,
    // 数値を数式で偽装した配列
    ()=>\`local \${generateVarName(lite)}={\${Array.from({length:lite?3:5},()=>numToExpr(Math.floor(Math.random()*100)+1)).join(",")}};\${lite?'':'\\n'}\`,
    // 複数チャンク連結でゴミ文字列
    ()=>\`local \${generateVarName(lite)}=\${strToConcat(randomString(lite?12:24),lite)};\${lite?'':'\\n'}\`,
    // pcallで常にfalseになるゴミ処理
    ()=>{\`local \${generateVarName(lite)},\${generateVarName(lite)}=pcall(function()return \${numToExpr(Math.floor(Math.random()*100))} end);\${lite?'':'\\n'}\`},
    // bit32偽装計算
    ()=>\`local \${generateVarName(lite)}=bit32 and bit32.bxor(\${numToExpr(Math.floor(Math.random()*255))},\${numToExpr(Math.floor(Math.random()*255))})or \${Math.floor(Math.random()*255)};\${lite?'':'\\n'}\`,
    // string.rep でゴミ文字列
    ()=>\`local \${generateVarName(lite)}=string.rep(\${strToDecimalChar(randomString(2))},\${Math.floor(Math.random()*5)+2});\${lite?'':'\\n'}\`,
    // math系ゴミ計算
    ()=>\`local \${generateVarName(lite)}=math.abs(math.floor(\${(Math.random()*1000-500).toFixed(4)}));\${lite?'':'\\n'}\`,
    ()=>\`local \${generateVarName(lite)}=math.max(\${numToExpr(Math.floor(Math.random()*50))},\${numToExpr(Math.floor(Math.random()*50))});\${lite?'':'\\n'}\`,
    // type()チェック偽装
    ()=>\`local \${generateVarName(lite)}=type(\${strToDecimalChar(randomString(3))});\${lite?'':'\\n'}\`,
  ];
  for(let r=0;r<count;r++)e+=a[Math.floor(Math.random()*a.length)]();
  return e;
}
function injectJunkIntoCode(code,intensity,lite){
  const lines=code.split("\\n");let r=[];
  const junkLines=[
    ()=>\`local \${generateVarName(lite)}=\${numToExpr(Math.floor(Math.random()*1000)+1)};\`,
    ()=>\`local \${generateVarName(lite)}=\${strToDecimalChar(randomString(lite?3:6))};\`,
    ()=>\`local \${generateVarName(lite)}=math.max(\${numToExpr(Math.floor(Math.random()*50))},\${numToExpr(Math.floor(Math.random()*50))});\`,
    ()=>generateJunkFunction(lite).replace(/\\n/g,''),
  ];
  for(let i=0;i<lines.length;i++){
    r.push(lines[i]);
    if(Math.random()>.7&&intensity>50){
      const n=Math.floor(3*Math.random())+1;
      for(let j=0;j<n;j++)r.push(junkLines[Math.floor(Math.random()*junkLines.length)]());
    }
  }
  return r.join(lite?'':'\\n');
}
function minifyCode(code){
  code=code.replace(/--\\[\\[[\\s\\S]*?\\]\\]/g,'');
  code=code.replace(/--[^\\n]*/g,'');
  code=code.replace(/\\n\\s*\\n/g,'\\n');
  code=code.replace(/\\s*;\\s*/g,';');
  code=code.replace(/\\s*,\\s*/g,',');
  code=code.replace(/\\s*=\\s*/g,'=');
  code=code.replace(/\\s+/g,' ');
  return code.trim();
}
async function processObfuscation(inputCode,opts){
  const TARGET_SIZE=1.5*1024*1024;
  let a=inputCode;const lite=opts.useLite;
  let adjLayers=opts.layers,adjJunk=opts.junk;
  if(lite){
    const inputSize=new Blob([inputCode]).size;
    const estSize=inputSize*Math.pow(1.37,opts.layers);
    if(estSize>TARGET_SIZE){
      setObfStatus("軽量化: サイズ調整中...","process");
      const maxSafe=Math.max(3,Math.floor(Math.log(TARGET_SIZE/inputSize)/Math.log(1.37)));
      adjLayers=Math.min(opts.layers,maxSafe);
      adjJunk=Math.min(opts.junk,Math.floor(50+(TARGET_SIZE-inputSize*Math.pow(1.37,adjLayers))/500));
      await sleep(50);
    }
  }
  const XOR_DEPTH=36;let xorDecoder="",vXorVar="";
  if(opts.useXor){
    setObfStatus("36層 Chaos XOR暗号化中...","process");await sleep(20);
    let masterSeed=Math.floor(Math.random()*99999999)+100000;
    let cur=masterSeed;
    const nxt=()=>{cur=(cur*1664525+1013904223)%4294967296;return cur;};
    let ops=[];
    for(let i=0;i<XOR_DEPTH;i++){let r=nxt();ops.push({type:Math.floor((r%100)/34),keyBase:Math.floor((r/256)%255)+1,prime:[2,3,5,7,11,13,17,19,23,29,31][Math.floor((r%1000)/100)]||3});}
    let bytes=new Uint8Array(a.length);
    for(let i=0;i<a.length;i++)bytes[i]=a.charCodeAt(i);
    for(let pass=0;pass<XOR_DEPTH;pass++){
      const op=ops[pass],k=op.keyBase,p=op.prime;
      for(let i=0;i<bytes.length;i++){let dk=(k*(i+p))%256;if(op.type===0)bytes[i]=bytes[i]^dk;else if(op.type===1)bytes[i]=(bytes[i]+dk)%256;else bytes[i]=(bytes[i]-dk+256)%256;}
      if(pass%5===0)updateObfProgress(pass/XOR_DEPTH*30);
    }
    let enc="";const cs=32768;
    for(let i=0;i<bytes.length;i+=cs)enc+=String.fromCharCode.apply(null,bytes.subarray(i,i+cs));
    a=enc;vXorVar=generateVarName(lite);
    xorDecoder=\`\\nlocal function \${vXorVar}(str)\\nlocal b={}\\nfor i=1,#str do b[i]=string.byte(str,i) end\\nlocal s=\${masterSeed}\\nlocal function n() s=(s*1664525+1013904223)%4294967296 return s end\\nlocal ops={}\\nlocal pr={2,3,5,7,11,13,17,19,23,29,31}\\nfor i=1,\${XOR_DEPTH} do\\nlocal r=n()\\nlocal t=math.floor((r%100)/34)\\nlocal k=math.floor((r/256)%255)+1\\nlocal p=pr[math.floor((r%1000)/100)+1] or 3\\ntable.insert(ops,{t,k,p})\\nend\\nfor pass=\${XOR_DEPTH},1,-1 do\\nlocal op=ops[pass]\\nlocal t,k,p=op[1],op[2],op[3]\\nfor i=1,#b do\\nlocal dk=(k*(i+p))%256\\nif t==0 then b[i]=bit32.bxor(b[i],dk)\\nelseif t==1 then b[i]=(b[i]-dk+256)%256\\nelseif t==2 then b[i]=(b[i]+dk)%256 end\\nend\\nend\\nlocal r={}\\nfor i=1,#b do r[i]=string.char(b[i]) end\\nreturn table.concat(r)\\nend\\n\`;
  }
  for(let i=0;i<adjLayers;i++){
    updateObfProgress(30+(i/adjLayers)*60);if(i%5===0)await sleep(10);
    try{a=btoa(a);}catch(err){const b=new Uint8Array(a.length);for(let j=0;j<a.length;j++)b[j]=a.charCodeAt(j);a=bytesToBase64(b);}
  }
  const vLib=generateVarName(lite),vStr=generateVarName(lite),vTbl=generateVarName(lite),vVM=generateVarName(lite),vSt=generateVarName(lite);
  const dv1=generateVarName(lite),dv2=generateVarName(lite),dv3=generateVarName(lite);
  const b64Decoder=lite
    ?\`local \${dv1}='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='local \${dv2}={}for \${dv3}=1,#\${dv1} do \${dv2}[string.byte(\${dv1},\${dv3},\${dv3})]=\${dv3}-1 end local function \${vLib}(s)local r,p,n={},1,#s for i=1,n,4 do local a,b,c,d=\${dv2}[string.byte(s,i,i)],\${dv2}[string.byte(s,i+1,i+1)],\${dv2}[string.byte(s,i+2,i+2)],\${dv2}[string.byte(s,i+3,i+3)]if not a or not b then break end r[p]=string.char((a*4+math.floor(b/16))%256)p=p+1 if not c then break end r[p]=string.char(((b%16)*16+math.floor(c/4))%256)p=p+1 if not d then break end r[p]=string.char(((c%4)*64+d)%256)p=p+1 end return table.concat(r)end\`
    :\`local \${dv1}='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='\\nlocal \${dv2}={}\\nfor \${dv3}=1,#\${dv1} do \${dv2}[string.byte(\${dv1},\${dv3},\${dv3})]=\${dv3}-1 end\\nlocal function \${vLib}(s)local r,p,n={},1,#s\\nfor i=1,n,4 do local a,b,c,d=\${dv2}[string.byte(s,i,i)],\${dv2}[string.byte(s,i+1,i+1)],\${dv2}[string.byte(s,i+2,i+2)],\${dv2}[string.byte(s,i+3,i+3)]\\nif not a or not b then break end\\nr[p]=string.char((a*4+math.floor(b/16))%256)p=p+1\\nif not c then break end\\nr[p]=string.char(((b%16)*16+math.floor(c/4))%256)p=p+1\\nif not d then break end\\nr[p]=string.char(((c%4)*64+d)%256)p=p+1 end\\nreturn table.concat(r)end\`;
  let out=lite?'':'-- [[ Dynamic 36-Layer Chaos Obfuscation by YAJU ]] --\\n';
  if(opts.useAntiDump){
    const a1=generateVarName(lite),a2=generateVarName(lite),a3=generateVarName(lite);
    out+=lite
      ?\`local function \${a1}()local \${a2}=getfenv()local \${a3}=\${a2}[\${strToChar("getgenv")}]if \${a3} then \${a3}()[\${strToChar("saveinstance")}]=nil \${a3}()[\${strToChar("save_instance")}]=nil \${a3}()[\${strToChar("dumpstring")}]=nil end if debug then if debug.sethook then pcall(function()debug.sethook(function()while true do end end,"c")end)end if debug.getinfo then debug.getinfo=nil end end end pcall(\${a1})\`
      :\`local function \${a1}()local \${a2}=getfenv()local \${a3}=\${a2}[\${strToChar("getgenv")}]if \${a3} then \${a3}()[\${strToChar("saveinstance")}]=nil \${a3}()[\${strToChar("save_instance")}]=nil \${a3}()[\${strToChar("dumpstring")}]=nil end if debug then if debug.sethook then pcall(function()debug.sethook(function()while true do end end,"c")end)end if debug.getinfo then debug.getinfo=nil end end end pcall(\${a1})\\n\`;
  }
  if(adjJunk>0)out+=generateMassiveJunkCode(Math.floor(adjJunk/(lite?20:5)),lite);
  // ゴミ関数の追加注入
  if(opts.useJunkFunc&&!lite){
    const jfCount=Math.floor(adjJunk/30)+3;
    for(let i=0;i<jfCount;i++)out+=generateJunkFunction(lite);
  }
  out+=b64Decoder+(lite?'':'\\n');
  if(opts.useXor&&xorDecoder)out+=lite?minifyCode(xorDecoder):xorDecoder+"\\n";
  if(opts.useShuffle){
    const chunks=[];for(let i=0;i<a.length;i+=500)chunks.push(a.substring(i,i+500));
    let arr=chunks.map((v,i)=>({v,i}));
    for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
    // チャンクをそのまま文字列で入れる（Base64なので安全）
    let tbl="{";arr.forEach(x=>{tbl+=\`[\${numToExpr(x.i+1)}]="\${x.v}",\`;});tbl+="}";
    const vIdx=generateVarName(lite);
    out+=lite
      ?\`local \${vTbl}=\${tbl}local \${vStr}=""for \${vIdx}=1,\${numToExpr(arr.length)} do \${vStr}=\${vStr}..\${vTbl}[\${vIdx}]end\`
      :\`local \${vTbl}=\${tbl}\nlocal \${vStr}=""\nfor \${vIdx}=1,\${numToExpr(arr.length)} do \${vStr}=\${vStr}..\${vTbl}[\${vIdx}]end\n\`;
  }else{
    out+=lite?\`local \${vStr}="\${a}"\`:\`local \${vStr}="\${a}"\n\`;
  }
  if(opts.useFlat){
    let steps=[];
    for(let i=0;i<adjLayers;i++)steps.push(\`\${vStr}=\${vLib}(\${vStr})\`);
    if(opts.useXor&&vXorVar)steps.push(\`\${vStr}=\${vXorVar}(\${vStr})\`);
    steps.push(\`local f=loadstring(\${vStr})if f then f()end return\`);
    let vm="{";for(let i=0;i<steps.length;i++)vm+=\`[\${i}]=function()\${steps[i]} return \${i===steps.length-1?-1:i+1}end,\`;vm+="}";
    out+=lite?\`local \${vSt}=0 local \${vVM}=\${vm}while \${vSt}~=-1 do \${vSt}=\${vVM}[\${vSt}]()end\`:\`local \${vSt}=0 local \${vVM}=\${vm}\\nwhile \${vSt}~=-1 do \${vSt}=\${vVM}[\${vSt}]()end\`;
  }else{
    for(let i=0;i<adjLayers;i++)out+=lite?\`\${vStr}=\${vLib}(\${vStr})\`:\`\${vStr}=\${vLib}(\${vStr})\\n\`;
    if(opts.useXor&&vXorVar)out+=lite?\`\${vStr}=\${vXorVar}(\${vStr})\`:\`\${vStr}=\${vXorVar}(\${vStr})\\n\`;
    out+=\`loadstring(\${vStr})()\`;
  }
  if(adjJunk>100)out=injectJunkIntoCode(out,adjJunk,lite);
  if(lite)out=minifyCode(out);
  return out;
}
async function startObfuscation(){
  const code=byId('obfInput').value;
  if(!code.trim()){setObfStatus("エラー: コードが空です","error");return;}
  const btn=byId('btnObfuscate');btn.disabled=true;
  try{
    const opts={layers:parseInt(byId('b64Layers').value),junk:parseInt(byId('junkIntensity').value),useXor:byId('chkXor').checked,useShuffle:byId('chkShuffle').checked,useFlat:byId('chkFlat').checked,useAntiDump:byId('chkAntiDump').checked,useLite:byId('chkLite').checked,useDecimalStr:byId('chkDecimalStr').checked,useNumExpr:byId('chkNumExpr').checked,useJunkFunc:byId('chkJunkFunc').checked};
    setObfStatus("処理中...","process");updateObfProgress(0);
    const result=await processObfuscation(code,opts);
    byId('obfOutput').value=result;
    const sz=new Blob([result]).size;
    const szStr=sz>=1048576?\`\${(sz/1048576).toFixed(2)} MB\`:sz>=1024?\`\${(sz/1024).toFixed(2)} KB\`:\`\${sz} bytes\`;
    setObfStatus(\`✓ 完了 (\${szStr})\`,"success");updateObfProgress(100);
  }catch(e){setObfStatus("エラー: "+e.message,"error");}
  finally{btn.disabled=false;setTimeout(()=>{byId('obfProgress').style.display='none'},2000);}
}

/* ════════════════════════════
   解読ロジック (APIへ送信)
════════════════════════════ */
function setDeobfStatus(msg,type){
  const el=byId('deobfStatus');el.innerText=msg;
  el.style.color=type==='error'?'#ff3c5a':type==='process'?'#bb86fc':'#00e5ff';
}
async function startDeobfuscation(){
  const code=byId('deobfInput').value;
  if(!code.trim()){setDeobfStatus("エラー: コードが空です","error");return;}
  const btn=byId('btnDeobfuscate');btn.disabled=true;
  byId('deobfOutput').value='';byId('deobfLoader').style.display='block';
  setDeobfStatus("サーバーでLuaコードを実行中...","process");
  try{
    const res=await fetch('/api/deobfuscate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const data=await res.json();
    if(data.success){byId('deobfOutput').value=data.result;setDeobfStatus("✓ 解読完了！","success");}
    else{byId('deobfOutput').value='エラー:\\n'+data.error;setDeobfStatus("❌ "+data.error,"error");}
  }catch(e){setDeobfStatus("❌ サーバーエラー: "+e.message,"error");}
  finally{btn.disabled=false;byId('deobfLoader').style.display='none';}
}

/* ── イベント登録 ── */
function handleFile(inputId,displayId,textareaId){
  const file=document.getElementById(inputId).files[0];if(!file)return;
  document.getElementById(displayId).innerText=\`選択中: \${file.name} (\${(file.size/1024).toFixed(1)} KB)\`;
  const r=new FileReader();r.onload=e=>{document.getElementById(textareaId).value=e.target.result;};r.readAsText(file);
}
byId('obfFileInput').addEventListener('change',()=>handleFile('obfFileInput','obfFileName','obfInput'));
byId('deobfFileInput').addEventListener('change',()=>handleFile('deobfFileInput','deobfFileName','deobfInput'));
byId('b64Layers').addEventListener('input',updateObfUI);
byId('junkIntensity').addEventListener('input',updateObfUI);
byId('chkLite').addEventListener('change',function(){byId('liteModeInfo').style.display=this.checked?'block':'none';});
byId('btnObfuscate').addEventListener('click',startObfuscation);
byId('btnDeobfuscate').addEventListener('click',startDeobfuscation);
byId('btnObfCopy').addEventListener('click',()=>{byId('obfOutput').select();document.execCommand('copy');setObfStatus('クリップボードにコピーしました！','success');});
byId('btnDeobfCopy').addEventListener('click',()=>{byId('deobfOutput').select();document.execCommand('copy');setDeobfStatus('クリップボードにコピーしました！','success');});
</script>
</body>
</html>`);
});

// ── 解読API ────────────────────────────────────────────────────────
app.post('/api/deobfuscate', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.json({ success: false, error: 'コードが提供されていません' });
  }
  const result = await tryDynamicExecution(code);
  res.json(result);
});

// ── 動的実行 (loadstringフック) ────────────────────────────────────
async function tryDynamicExecution(code) {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const tempFile = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

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

// ── 古い一時ファイルのクリーンアップ ──────────────────────────────
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
