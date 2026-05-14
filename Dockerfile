FROM 172.24.173.77:30500/node:24.13.0-alpine

WORKDIR /home/www/memory-ai

# 安装根服务依赖
COPY package.json package-lock.json* ./
RUN npm install

# 安装 tornado 依赖
COPY tornado/package.json tornado/package-lock.json* ./tornado/
RUN cd tornado && npm install

# 复制全部源码
COPY . .

EXPOSE 8880 3011

ENV TZ=Asia/Shanghai

CMD ["node", "start-all.mjs"]
