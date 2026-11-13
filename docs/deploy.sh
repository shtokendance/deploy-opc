#!/usr/bin/env bash
# ==============================================================================
# deploy-opc 生产环境标准 Git 拉取构建与部署脚本 (正式服务器执行)
# 
# 流程：
# 1. 自动同步 release 分支最新代码
# 2. 提取当前 release 的 short commit hash (7位) 作为镜像版本号
# 3. 使用 Dockerfile 完成容器化编译并打包最终镜像
# 4. 自动识别全新安装(引导容器) 或 现有集群平滑滚动更新
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOTSTRAP_CONTAINER="deploy-opc-bootstrap"

echo "=========================================================="
echo "      deploy-opc 生产环境自动化构建与部署程序             "
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
    echo "错误: 请使用 sudo 权限运行此脚本！" >&2
    exit 1
fi

cd "$REPO_ROOT"

# 1. 校验是否在 Git 仓库中并切换拉取 release 分支
echo ">>> 1. 检查并同步 Git release 分支最新代码..."
if [ ! -d "$REPO_ROOT/.git" ]; then
    echo "错误: $REPO_ROOT 不是一个 Git 仓库！" >&2
    exit 1
fi

# 确保在 release 分支并拉取最新远程代码
git fetch origin release
git checkout release
git pull origin release

# 2. 提取 release 分支 7 位 commit hash 作为镜像版本号
COMMIT_SHA="$(git rev-parse --short=7 HEAD)"
IMAGE_NAME="deploy-opc:${COMMIT_SHA}"
IMAGE_LATEST="deploy-opc:latest"

echo "----------------------------------------------------------"
echo ">>> 当前 release 分支最新 Commit: $COMMIT_SHA"
echo ">>> 目标构建镜像名称与版本: $IMAGE_NAME"
echo "----------------------------------------------------------"

# 3. 自动探测主机内网 IP
MAIN_NODE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I | awk '{print $1}')"
echo ">>> 探测到主机内网 IP: $MAIN_NODE_IP"

# 4. 检查 Docker Swarm 状态
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

# 5. 准备宿主机 /captain 目录与配置覆盖文件
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

# 6. 同步前端控制台静态资源 (若宿主机存在)
if [ -d /captain/data/dist-frontend ] && [ ! -d "$REPO_ROOT/dist-frontend" ]; then
    echo ">>> 从宿主机 /captain/data 同步前端静态资源到构建上下文..."
    cp -r /captain/data/dist-frontend "$REPO_ROOT/dist-frontend"
fi

# 7. 基于 Dockerfile 编译并打包最终镜像
echo ">>> 开始基于 Dockerfile 编译与打包最终镜像 ($IMAGE_NAME)..."
DOCKERFILE_PATH="$REPO_ROOT/docs/Dockerfile"
if [ ! -f "$DOCKERFILE_PATH" ]; then
    DOCKERFILE_PATH="$REPO_ROOT/Dockerfile.caprover"
fi

# 确保构建时包含必要的目录
docker build \
    -f "$DOCKERFILE_PATH" \
    -t "$IMAGE_NAME" \
    -t "$IMAGE_LATEST" \
    "$REPO_ROOT"

echo ">>> 镜像构建完成: $IMAGE_NAME 与 $IMAGE_LATEST"

# 8. 判定全新安装还是已有服务平滑更新
if docker service inspect deploy-opc >/dev/null 2>&1; then
    echo ">>> 检测到 deploy-opc 服务已存在，执行基于版本 $IMAGE_NAME 的平滑滚动更新..."
    docker service update --force --image "$IMAGE_NAME" deploy-opc
    echo ">>> 服务更新已提交！"
elif docker service inspect captain-captain >/dev/null 2>&1; then
    echo ">>> 检测到 captain-captain 服务，执行基于版本 $IMAGE_NAME 的平滑滚动更新..."
    docker service update --force --image "$IMAGE_NAME" captain-captain
    echo ">>> 服务更新已提交！"
else
    echo ">>> 全新安装: 启动一次性引导容器拉起 Swarm 服务..."
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

# 9. 状态检查与收敛确认
echo ">>> 正在等待服务收敛与端口就绪..."
sleep 5
docker service ls

echo ">>> 验证健康探针..."
if curl -s -I http://127.0.0.1:13000/ | grep -q "200 OK"; then
    echo "=========================================================="
    echo "  [SUCCESS] deploy-opc 生产服务已成功部署并运行！          "
    echo "  - 当前运行镜像版本: $IMAGE_NAME                         "
    echo "  - 控制台/API 地址: http://$MAIN_NODE_IP:13000           "
    echo "  - 初始登录密码: captain42 (若首次安装，请登录后立即修改)  "
    echo "=========================================================="
else
    echo "提示: 服务正在拉起中，请稍后执行 curl -I http://127.0.0.1:13000 验证。"
fi
