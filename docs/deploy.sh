#!/usr/bin/env bash
# ==============================================================================
# deploy-opc 正式环境一键部署/安装引导脚本 (正式服务器执行)
# 镜像名: deploy-opc:1.16.0 / deploy-opc:latest
# 服务名: deploy-opc
# ==============================================================================

set -euo pipefail

IMAGE_NAME="deploy-opc:1.16.0"
IMAGE_LATEST="deploy-opc:latest"
BOOTSTRAP_CONTAINER="deploy-opc-bootstrap"
BUILD_DIR="/data/build/deploy-opc"
PACKAGE_FILE="${1:-/tmp/deploy-opc.tar.gz}"

echo "=========================================================="
echo "           deploy-opc 生产环境标准安装部署程序            "
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
    echo "错误: 请使用 sudo 权限运行此脚本！" >&2
    exit 1
fi

if [ ! -f "$PACKAGE_FILE" ]; then
    echo "错误: 未找到部署制品 $PACKAGE_FILE" >&2
    echo "用法: sudo bash $0 [/path/to/deploy-opc.tar.gz]" >&2
    exit 1
fi

# 1. 自动探测主机内网 IP
MAIN_NODE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I | awk '{print $1}')"
echo ">>> 探测到主机内网 IP: $MAIN_NODE_IP"

# 2. 检查 Docker Swarm 状态
SWARM_STATE="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo 'inactive')"
if [ "$SWARM_STATE" != "active" ]; then
    echo ">>> 检测到 Docker Swarm 未初始化，正在初始化..."
    docker swarm init \
        --advertise-addr "$MAIN_NODE_IP" \
        --default-addr-pool 10.12.0.0/16 \
        --default-addr-pool-mask-length 24
    echo ">>> Docker Swarm 初始化完成！"
else
    echo ">>> Docker Swarm 已处于 active 状态，复用当前集群。"
fi

# 3. 准备 /captain 目录与重载配置文件
echo ">>> 准备宿主机 /captain 目录与配置覆盖文件..."
mkdir -p /captain/data /captain/generated /captain/temp

if [ ! -f /captain/data/config-override.json ]; then
    cat > /captain/data/config-override.json << 'EOF'
{
  "captainServiceName": "deploy-opc",
  "publishedNameOnDockerHub": "deploy-opc",
  "adminPortNumber3000": 13000,
  "nginxPortNumber80": 80,
  "nginxPortNumber443": 443,
  "skipVerifyingDomains": "true",
  "useExistingSwarm": "true",
  "defaultDockerBuildVersion": "2"
}
EOF
    echo ">>> 已创建默认 /captain/data/config-override.json"
fi

# 4. 解包并构建镜像
echo ">>> 解压制品包到构建目录: $BUILD_DIR ..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
tar -xzf "$PACKAGE_FILE" -C "$BUILD_DIR"

# 同步前端静态资源
if [ -d /captain/data/dist-frontend ]; then
    echo ">>> 同步宿主机前端静态资源到构建目录..."
    cp -r /captain/data/dist-frontend "$BUILD_DIR/dist-frontend"
fi

cd "$BUILD_DIR"
sed -i "/^\/node_modules/d; /^\/built/d" .dockerignore 2>/dev/null || true

echo ">>> 构建生产镜像: $IMAGE_NAME ..."
docker build -f Dockerfile.caprover -t "$IMAGE_NAME" -t "$IMAGE_LATEST" .

# 5. 判定是否为全新安装还是服务更新
if docker service inspect deploy-opc >/dev/null 2>&1; then
    echo ">>> 检测到 deploy-opc Swarm 服务已存在，执行平滑滚动更新..."
    docker service update --force --image "$IMAGE_NAME" deploy-opc
    echo ">>> 服务更新已触发！"
elif docker service inspect captain-captain >/dev/null 2>&1; then
    echo ">>> 检测到旧版 captain-captain 服务，平滑更新镜像..."
    docker service update --force --image "$IMAGE_NAME" captain-captain
    echo ">>> 服务更新已触发！"
else
    echo ">>> 全新安装: 启动引导容器拉起 Swarm 服务..."
    docker rm -f "$BOOTSTRAP_CONTAINER" 2>/dev/null || true
    docker run -d \
        --name "$BOOTSTRAP_CONTAINER" \
        -p 80:80 -p 443:443 -p 13000:3000 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v /captain:/captain \
        -e ACCEPTED_TERMS=true \
        -e MAIN_NODE_IP_ADDRESS="$MAIN_NODE_IP" \
        -e BY_PASS_PROXY_CHECK=true \
        "$IMAGE_NAME"

    echo ">>> 正在等待引导容器初始化完成..."
    docker logs -f "$BOOTSTRAP_CONTAINER" || true
    docker rm -f "$BOOTSTRAP_CONTAINER" 2>/dev/null || true
fi

# 6. 健康检查与状态输出
echo ">>> 正在等待服务收敛与端口就绪..."
sleep 5
docker service ls

echo ">>> 验证健康探针..."
if curl -s -I http://127.0.0.1:13000/ | grep -q "200 OK"; then
    echo "=========================================================="
    echo "  [SUCCESS] deploy-opc 生产服务已成功启动并就绪！          "
    echo "  - 控制台/API 地址: http://$MAIN_NODE_IP:13000           "
    echo "  - 初始登录密码: captain42 (请立即登录修改!)              "
    echo "=========================================================="
else
    echo "提示: 服务正在拉起中，请稍后执行 curl -I http://127.0.0.1:13000 验证。"
fi
