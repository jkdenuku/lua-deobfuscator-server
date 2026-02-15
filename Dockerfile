FROM node:18

RUN apt-get update && apt-get install -y lua5.4
RUN lua -v

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
