# 通用容器镜像（适用于 Hugging Face Spaces / Fly.io / Railway / Koyeb / 任意容器平台）
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

# Hugging Face Spaces 会把 PORT 环境变量设为 7860 并注入容器；
# 我们的 server.js 读 process.env.PORT，因此自动监听 7860。其余平台同理。
ENV HOST=0.0.0.0
EXPOSE 7860
CMD ["node", "server.js"]
