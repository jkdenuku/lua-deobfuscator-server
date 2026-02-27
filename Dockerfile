FROM node:18
RUN apt-get update && apt-get install -y lua5.4 lua5.1 git
# lua5.1パッケージにluac5.1が含まれている
# vm_obfuscator.luaが "luac5.1" を探すのでパスを確認してリンク作成
RUN luac5.1 -v 2>&1 || ln -sf /usr/bin/luac5.1 /usr/local/bin/luac5.1 || true
RUN lua5.1 -v
RUN git clone https://github.com/prometheus-lua/Prometheus.git /app/prometheus
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p temp
EXPOSE 3000
CMD ["node", "server.js"]
