FROM node:18
RUN apt-get update && apt-get install -y lua5.4 lua5.1 git
# lua5.1パッケージにluac5.1が含まれている
# luac5.1のパスを確認してシンボリックリンクを作成
RUN find /usr -name "luac*" 2>/dev/null && which luac5.1 || true
RUN luac5.1 -v 2>&1 || (find /usr -name "luac*" -exec ln -sf {} /usr/local/bin/luac5.1 \; && echo "linked luac5.1")
RUN git clone https://github.com/prometheus-lua/Prometheus.git /app/prometheus
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p temp
EXPOSE 3000
CMD ["node", "server.js"]
