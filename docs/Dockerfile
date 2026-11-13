# ==============================================================================
# deploy-opc 生产环境标准 Dockerfile
# 基于 node:24-bookworm-slim 与 golang:1.26 多阶段工具提取
# ==============================================================================

# 第一阶段：从 tools 镜像提取底层运维与安全工具（避免在国内生产服务器上执行 apt-get 超时）
FROM golang:1.26-bookworm AS tools

# 第二阶段：生产运行镜像
FROM node:24-bookworm-slim

# 复制必要的基础依赖工具
COPY --from=tools /usr/bin/openssl /usr/bin/openssl
COPY --from=tools /usr/bin/curl /usr/bin/curl
COPY --from=tools /usr/bin/git /usr/bin/git
COPY --from=tools /etc/ssl /etc/ssl
COPY --from=tools /usr/share/ca-certificates /usr/share/ca-certificates

# 设置工作目录
WORKDIR /usr/src/app

# 拷贝包含编译产物 built、前端资源 dist-frontend 及 node_modules 的完整代码目录
COPY . /usr/src/app

# 注入生产环境变量
ENV NODE_ENV=production PORT=3000

# 暴露容器内部监听端口
EXPOSE 3000

# 启动服务
CMD ["node", "./built/server.js"]
