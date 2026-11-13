# ==============================================================================
# deploy-opc 生产环境标准多阶段 Dockerfile
# 特性：纯 Docker 容器内完成依赖安装与 TypeScript 编译，宿主机无需安装 Node.js/npm
# ==============================================================================

# 第一阶段：从 tools 镜像提取底层运维与安全工具（避免在生产环境执行 apt-get 下载依赖）
FROM golang:1.26-bookworm AS tools

# 第二阶段：构建阶段，在独立的 Node.js 容器中完成编译构建
FROM node:24-bookworm-slim AS builder

WORKDIR /usr/src/app

# 1. 先复制依赖清单，充分利用 Docker 层缓存
COPY package*.json tsconfig.json ./

# 2. 安装全部依赖（含 devDependencies 以支持 tsc 和 madge 编译）
RUN npm ci

# 3. 复制源代码并执行 TypeScript 编译
COPY src/ ./src/
COPY template/ ./template/
COPY public/ ./public/
COPY release/ ./release/
COPY scripts/ ./scripts/

RUN npm run build

# 第三阶段：生产运行镜像，最小化体积
FROM node:24-bookworm-slim

# 复制必要的基础依赖工具与根证书
COPY --from=tools /usr/bin/openssl /usr/bin/openssl
COPY --from=tools /usr/bin/curl /usr/bin/curl
COPY --from=tools /usr/bin/git /usr/bin/git
COPY --from=tools /etc/ssl /etc/ssl
COPY --from=tools /usr/share/ca-certificates /usr/share/ca-certificates

WORKDIR /usr/src/app

# 拷贝依赖与编译产物
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/built ./built
COPY --from=builder /usr/src/app/template ./template
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/release ./release
COPY --from=builder /usr/src/app/scripts ./scripts

# 拷贝根目录必要配置文件（如果构建上下文包含 dist-frontend 会一并打入）
COPY . /usr/src/app

# 注入生产环境变量
ENV NODE_ENV=production PORT=3000

# 暴露容器内部监听端口
EXPOSE 3000

# 启动服务
CMD ["node", "./built/server.js"]
