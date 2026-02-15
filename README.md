# Lua Deobfuscator Server

Lua難読化コードを動的実行で解読するAPIサーバー

## デプロイ方法（Railway）

1. このリポジトリをGitHubにプッシュ
2. Railway.appでアカウント作成
3. "New Project" → "Deploy from GitHub repo"
4. このリポジトリを選択
5. 自動デプロイ開始

## API使用方法

POST `/api/deobfuscate`

リクエスト:
{
  "code": "難読化されたLuaコード"
}

レスポンス:
{
  "success": true,
  "result": "解読されたコード"
}
