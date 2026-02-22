FROM node:18
RUN apt-get update && apt-get install -y lua5.4 lua5.1 git
RUN lua5.1 -v
RUN git clone https://github.com/prometheus-lua/Prometheus.git /app/prometheus
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p temp
EXPOSE 3000
CMD ["node", "server.js"]
