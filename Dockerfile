# 通用容器镜像（适用于 Fly.io / Railway / Koyeb / 任意容器平台）
# 本项目零依赖，镜像极小，构建极快。
FROM node:22-alpine
WORKDIR /app

# 仅复制依赖清单先安装（零依赖时这一步近乎瞬完成）
COPY package.json ./
RUN npm install --omit=dev || true

# 复制源码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
