# deploy-opc 生产环境标准构建部署与运维操作手册 (SOP)

> **适用场景**：OPC-2.0 企业生产环境 (Production)  
> **核心原则**：线上环境直接拉取 Git `release` 分支代码，使用 Dockerfile 容器化编译，以 `release` 分支的 Commit 短哈希（7位）作为镜像版本号进行统一交付与部署。

---

## 1. 统一命名与版本规范

为了实现生产环境全生命周期的可追溯性（1:1 锚定代码提交），全面推行以下命名规范：

| 交付维度 | 命名规范 | 示例与说明 |
| :--- | :--- | :--- |
| **镜像名称与版本** | **`deploy-opc:<short-commit>`**<br>`deploy-opc:latest` | 使用 `release` 分支最新 **7位 Commit Hash** 作为版本号，如 **`deploy-opc:5b4f35f`** |
| **Swarm 服务名** | **`deploy-opc`** | Docker Swarm 中负责应用生命周期管控的核心常驻服务 |
| **引导容器名** | **`deploy-opc-bootstrap`** | 首次部署初始化集群时运行的一次性引导容器 |
| **数据库专属库** | **`deploy-opc`** | PostgreSQL 中存储已部署应用、发布版本、基础设施资源的专属数据库 |

---

## 2. 核心架构与运行模型

```
[ 线上正式服务器 (宿主机) ]
  ├── 1. Git 仓库 (本地目录: /opt/opc/deploy-opc)
  │      └── release 分支 -> 提取最新 Commit Hash (例如: 5b4f35f)
  │
  ├── 2. 容器化编译与打包 (docs/Dockerfile)
  │      ├── Stage 1: 工具镜像提取 (openssl, curl, git, CA 证书)
  │      ├── Stage 2: Node.js 24 容器内执行 npm ci & npm run build 编译
  │      └── Stage 3: 输出最终精简镜像 -> deploy-opc:5b4f35f
  │
  ├── 3. Docker Swarm 核心服务 (captain-overlay-network)
  │      ├── deploy-opc 服务 (镜像: deploy-opc:5b4f35f，映射端口 13000)
  │      ├── captain-nginx 动态网关 (监听 80/443)
  │      └── 托管业务容器 (如 supplier, smart-expense 等)
  │
  └── 4. 宿主机持久化目录 (/captain)
         ├── /captain/data/config-override.json (生产参数覆盖配置)
         ├── /captain/data/config-captain.json (系统状态数据库)
         └── /captain/data/dist-frontend (控制台前端静态资源)
```

---

## 3. 核心 Dockerfile 设计（纯容器化编译）

生产标准 Dockerfile（位于 [docs/Dockerfile](file:///Users/sheep.yang/Documents/OPC-2.0/deploy-opc/docs/Dockerfile)）采用三阶段构建，**宿主机无需预装 Node.js 或 npm**，所有源码编译全部在独立容器沙箱中完成：

```dockerfile
# 第一阶段：提取底层系统工具与根证书
FROM golang:1.26-bookworm AS tools

# 第二阶段：构建阶段，在 Node.js 容器内安全编译
FROM node:24-bookworm-slim AS builder
WORKDIR /usr/src/app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY template/ ./template/
COPY public/ ./public/
COPY release/ ./release/
COPY scripts/ ./scripts/
RUN npm run build

# 第三阶段：生产运行镜像，最小化安全封装
FROM node:24-bookworm-slim
COPY --from=tools /usr/bin/openssl /usr/bin/openssl
COPY --from=tools /usr/bin/curl /usr/bin/curl
COPY --from=tools /usr/bin/git /usr/bin/git
COPY --from=tools /etc/ssl /etc/ssl
COPY --from=tools /usr/share/ca-certificates /usr/share/ca-certificates

WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/built ./built
COPY --from=builder /usr/src/app/template ./template
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/release ./release
COPY --from=builder /usr/src/app/scripts ./scripts
COPY . /usr/src/app

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "./built/server.js"]
```

---

## 4. 全量配置参数解析

### 4.1 宿主机覆盖配置文件：`/captain/data/config-override.json`
在宿主机准备好此文件，服务启动时将自动生效：
```json
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
```

| 参数名 | 生产取值 | 说明 |
| :--- | :--- | :--- |
| **`captainServiceName`** | `"deploy-opc"` | **服务统一命名**：将 Swarm 服务名固定为 `deploy-opc` |
| **`publishedNameOnDockerHub`** | `"deploy-opc"` | **镜像统一命名**：默认使用的镜像标识 |
| **`adminPortNumber3000`** | `13000` | 管理控制台与调度 API 在宿主机映射的端口（避免与默认 3000 冲突） |
| **`nginxPortNumber80`** | `80` | 对外业务 HTTP 端口（如果宿主机 80 被占用可设为 `8080`） |
| **`nginxPortNumber443`** | `443` | 对外业务 HTTPS 端口 |
| **`skipVerifyingDomains`** | `"true"` / `"false"` | 内网/无外网 DNS 解析时设为 `"true"`；公网真实泛域名可设为 `"false"` |
| **`useExistingSwarm`** | `"true"` | 强制复用人工初始化好的 Swarm 集群，防止网段冲突 |
| **`defaultDockerBuildVersion`** | `"2"` | 启用 BuildKit 高性能镜像构建引擎 |

---

## 5. 正式环境实操落地步骤 (SOP)

---

### 步骤 1：在线拉取代码与检出 `release` 分支
在正式服务器（推荐安装目录如 `/opt/opc/deploy-opc`）拉取最新代码：
```bash
# 1. 首次克隆仓库（若已克隆直接进入目录即可）
sudo mkdir -p /opt/opc
cd /opt/opc
sudo git clone https://github.com/Roger0808/deploy-opc.git
cd deploy-opc

# 2. 检出并同步最新 release 分支
sudo git fetch origin release
sudo git checkout release
sudo git pull origin release
```

---

### 步骤 2：提取 Commit Hash 并确认镜像版本号
```bash
# 提取 release 分支最新的 7 位 short commit hash
COMMIT_SHA=$(git rev-parse --short=7 HEAD)
IMAGE_TAG="deploy-opc:${COMMIT_SHA}"

echo "=========================================================="
echo "当前 release 分支 Commit: $COMMIT_SHA"
echo "目标生产镜像版本: $IMAGE_TAG"
echo "=========================================================="
```

---

### 步骤 3：服务器系统与 Docker Swarm 初始化
```bash
# 1. 确认已安装 Docker 25+
docker --version

# 2. 获取宿主机内网通信网卡 IP
PROD_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I | awk '{print $1}')"

# 3. 初始化 Docker Swarm（必须自定义 Overlay 地址池，彻底规避 10.x 企业内网冲突）
if [ "$(sudo docker info --format '{{.Swarm.LocalNodeState}}')" != "active" ]; then
    sudo docker swarm init \
      --advertise-addr "$PROD_IP" \
      --default-addr-pool 10.12.0.0/16 \
      --default-addr-pool-mask-length 24
fi
```

---

### 步骤 4：宿主机持久化目录与配置注入
```bash
# 1. 创建基础数据目录
sudo mkdir -p /captain/data /captain/generated /captain/temp

# 2. 注入生产配置文件
sudo tee /captain/data/config-override.json << 'EOF'
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
```

---

### 步骤 5：同步前端控制台静态资源
若前端包位于测试机或预发机器，执行一次性同步至宿主机：
```bash
# 从测试服务器同步控制台静态文件
sudo scp -r ecs-user@10.101.102.116:/captain/data/dist-frontend /captain/data/
# 同时同步一份到当前源码目录
sudo cp -r /captain/data/dist-frontend ./dist-frontend
```

---

### 步骤 6：基于 Dockerfile 编译并打包最终镜像
直接使用 `docs/Dockerfile` 执行编译（所有构建在 Docker 内部执行）：
```bash
sudo docker build \
  -f docs/Dockerfile \
  -t "deploy-opc:${COMMIT_SHA}" \
  -t "deploy-opc:latest" \
  .
```

---

### 步骤 7：拉起服务（首次安装 vs 滚动更新）

#### 选项 A：首次全新安装（运行一次性引导容器）
```bash
sudo docker run -d \
  --name deploy-opc-bootstrap \
  -p 80:80 -p 443:443 -p 13000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /captain:/captain \
  -e ACCEPTED_TERMS=true \
  -e MAIN_NODE_IP_ADDRESS="$PROD_IP" \
  -e BY_PASS_PROXY_CHECK=true \
  "deploy-opc:${COMMIT_SHA}"

# 观察引导完成提示 "Captain is initialized and ready"
sudo docker logs -f deploy-opc-bootstrap

# 移除临时引导容器
sudo docker rm -f deploy-opc-bootstrap
```

#### 选项 B：已有集群更新发布（零停机滚动更新）
若服务器上已存在 `deploy-opc` 服务，直接执行平滑升级：
```bash
sudo docker service update --force --image "deploy-opc:${COMMIT_SHA}" deploy-opc
```

---

### 步骤 8：检查服务状态与验证
```bash
# 1. 查看 Swarm 服务列表与运行镜像版本
sudo docker service ls
sudo docker service ps deploy-opc

# 2. 健康检查验证
curl -I http://127.0.0.1:13000/
# 预期返回: HTTP/1.1 200 OK
```

---

### 步骤 9：安全加固与平台网关 (`platform-opc`) 联动
1. **修改控制台初始密码**：
   - 访问 `http://<PROD_IP>:13000`；
   - 默认密码为 **`captain42`**；
   - 登录后在 **Settings** -> **Change Password** 修改为强密码（如 `<PROD_STRONG_PASS>`）。
2. **在 PostgreSQL 中创建专属库**：
   ```sql
   CREATE DATABASE "deploy-opc" OWNER opc_platform;
   GRANT ALL PRIVILEGES ON DATABASE "deploy-opc" TO opc_platform;
   ```
3. **在 `platform-opc` 配置环境变量**：
   ```yaml
   APP_DEPLOY_CAPROVER_URL: "http://<PROD_IP>:13000"
   APP_DEPLOY_CAPROVER_PASSWORD: "<PROD_STRONG_PASS>"
   APP_DEPLOY_INTRANET_ROOT_DOMAIN: "apps.yourcompany.com"
   ```

---

## 6. 一键自动化流水线（后续日常运维）

为了让日常升级更简便，已在项目内提供了一键式自动化部署脚本 [docs/deploy.sh](file:///Users/sheep.yang/Documents/OPC-2.0/deploy-opc/docs/deploy.sh)。

后续当 `release` 分支有代码更新时，在正式服务器上只需执行：
```bash
cd /opt/opc/deploy-opc
sudo bash docs/deploy.sh
```
该脚本将**自动拉取最新 release 代码、自动提取 7 位 Commit Hash、自动调用 Dockerfile 容器化编译并平滑滚动更新集群服务**。
