# Lua XOR Time-Based Deobfuscator

この難読化解除ツールは、時間ベースのXOR暗号化を使用したLua難読化を解読します。

## 📋 対応している難読化パターン

```lua
local z={4,23,9,28,31,64,79,12,29,7,0,13,13,10}
local k=_5()  -- 時間ベースのキー生成
local o={}
for i=1,#z do
    o[i]=_1(_4(z[i],k))  -- XOR復号化
end
```

## 🚀 使い方

### 方法1: Pythonスクリプト (推奨)

```bash
# ファイルから読み込み
python3 lua_deobfuscator.py your_obfuscated_file.lua

# スクリプトを編集してコードを直接貼り付け
python3 lua_deobfuscator.py
```

### 方法2: サーバー設定 (lua-deobfuscator-server用)

1. `server.json` をあなたのサーバーのルートディレクトリにコピー
2. サーバーを起動
3. 難読化されたLuaファイルをアップロード

```bash
# サーバー起動
node server.js

# APIエンドポイント
POST http://localhost:3000/deobfuscate
Content-Type: application/json

{
  "code": "return(function(...)...end)(...)"
}
```

## 🔧 動作原理

1. **暗号化データの抽出**: `local z={...}` から暗号化されたバイト配列を取得
2. **全キー試行**: 0-255のすべての可能なキーでXOR復号化を試行
3. **スコアリング**: Luaキーワードの出現頻度と印字可能文字の割合でスコア計算
4. **最適結果選択**: 最もスコアの高い結果を返す

## 📊 XOR復号化アルゴリズム

```javascript
function xorDecrypt(byte, key) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    const a = (byte >> i) & 1;
    const b = (key >> i) & 1;
    if (a !== b) result |= (1 << i);
  }
  return result;
}
```

## ⚠️ 注意事項

- 時間ベースのキーは実行時に動的に生成されるため、元のキーを直接知ることはできません
- すべての可能なキー(0-255)を試行してベストマッチを見つける方式を採用
- 暗号化されたペイロードがさらに難読化されている場合は、追加の処理が必要になる場合があります

## 🛠️ トラブルシューティング

### 文字化けする場合

元のコードの `{4,23,9,28,31,64,79,12,29,7,0,13,13,10}` が実際のLuaコードではなく、さらに別の難読化レイヤーのデータである可能性があります。

解決策:
1. 実際に実行して生成される文字列を確認
2. その文字列に対してさらに解読を試みる
3. 多段階の難読化の場合は、段階的に解読する必要があります

### スコアが低い/結果が見つからない

- 暗号化データが正しく抽出されているか確認
- 別の難読化手法と組み合わせて使用されている可能性
- verbose モードで詳細なログを確認

## 📝 例

### 入力 (難読化済み)
```lua
local z={4,23,9,28,31,64,79,12,29,7,0,13,13,10}
local k=_5()
local o={}
for i=1,#z do
    o[i]=_1(_4(z[i],k))
end
return _2(o)
```

### 出力
```
🔑 Key: 97
📈 Score: 150
💻 Decrypted code:
print('test')
```

## 🔗 リンク

- 元のリポジトリ: https://github.com/jkdenuku/lua-deobfuscator-server
- 問題報告: GitHubのIssuesセクション

## 📄 ライセンス

このツールはMITライセンスの下で公開されています。

---

**作成日**: 2025年2月15日  
**対応環境**: Node.js 14+, Python 3.6+
