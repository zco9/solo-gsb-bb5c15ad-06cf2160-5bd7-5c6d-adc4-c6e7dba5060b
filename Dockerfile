FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY replay.js ./
COPY compare.js ./
COPY archive.js ./
COPY public ./public
# public/replay-core.js 同时被浏览器 <script> 与 Node（compare.js）require 复用，
# 已随 public 目录一并拷入；两侧执行同一份事件折叠内核

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
