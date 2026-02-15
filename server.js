const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// tempディレクトリを作成
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Lua Deobfuscator API is running' });
});

// 解読エンドポイント
app.post('/api/deobfuscate', async (req, res) => {
  const { code, type = 'wearedevs' } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, error: 'コードが提供されていません' });
  }

  // ユニークなファイル名
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const tempFile = path.join(tempDir, `obf_${timestamp}_${randomId}.lua`);

  try {
    // printをフックして出力をキャプチャ
    const wrapper = `
-- 出力をキャプチャする
local captured_output = {}
local original_print = print

_G.print = function(...)
  local args = {...}
  local line = {}
  for i = 1, select('#', ...) do
    table.insert(line, tostring(select(i, ...)))
  end
  local output_line = table.concat(line, "\\t")
  table.insert(captured_output, output_line)
  original_print(...)
end

-- 難読化されたコードを実行
local success, err = pcall(function()
${code}
end)

-- 結果を出力
if #captured_output > 0 then
  print("__CAPTURED_START__")
  for _, line in ipairs(captured_output) do
    print(line)
  end
  print("__CAPTURED_END__")
else
  print("__NO_OUTPUT__")
end

if not success then
  print("__ERROR__: " .. tostring(err))
end
`;

    fs.writeFileSync(tempFile, wrapper, 'utf8');

    // Luaで実行（タイムアウト5秒）
    exec(`lua ${tempFile}`, { timeout: 5000 }, (error, stdout, stderr) => {
      // 一時ファイルを削除
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        console.error('一時ファイル削除エラー:', e);
      }

      if (error) {
        // タイムアウトエラー
        if (error.killed) {
          return res.json({
            success: false,
            error: '実行タイムアウト（5秒以上かかりました）'
          });
        }
        return res.json({
          success: false,
          error: stderr || error.message
        });
      }

      // キャプチャした出力を抽出
      const startMarker = '__CAPTURED_START__';
      const endMarker = '__CAPTURED_END__';
      const noOutputMarker = '__NO_OUTPUT__';
      const errorMarker = '__ERROR__:';

      if (stdout.includes(errorMarker)) {
        const errorMsg = stdout.split(errorMarker)[1].trim();
        return res.json({
          success: false,
          error: '実行エラー: ' + errorMsg
        });
      }

      if (stdout.includes(noOutputMarker)) {
        return res.json({
          success: true,
          result: '(出力なし)',
          message: 'コードは正常に実行されましたが、print文がありませんでした。'
        });
      }

      if (stdout.includes(startMarker) && stdout.includes(endMarker)) {
        const startIdx = stdout.indexOf(startMarker) + startMarker.length;
        const endIdx = stdout.indexOf(endMarker);
        const result = stdout.substring(startIdx, endIdx).trim();
        
        return res.json({
          success: true,
          result: result || '(空の出力)',
          fullOutput: stdout
        });
      }

      // マーカーが見つからない場合は全体を返す
      res.json({
        success: true,
        result: stdout.trim()
      });
    });

  } catch (err) {
    // ファイル作成エラーなど
    res.status(500).json({
      success: false,
      error: 'サーバーエラー: ' + err.message
    });
  }
});

// 定期的にtempディレクトリをクリーンアップ（10分以上古いファイル削除）
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
}, 5 * 60 * 1000); // 5分ごと

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
