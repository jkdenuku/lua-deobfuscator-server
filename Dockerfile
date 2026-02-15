FROM node:18

# Luaをインストール
RUN apt-get update && \
    apt-get install -y lua5.4 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Luaが正しくインストールされたか確認
RUN lua -v

# 作業ディレクトリ
WORKDIR /app

# 依存関係をコピー
COPY package*.json ./
RUN npm install

# アプリケーションをコピー
COPY . .

# tempディレクトリを作成
RUN mkdir -p temp

# ポートを公開
EXPOSE 3000

# 起動
CMD ["node", "server.js"]
