# deploy-opc 生产环境标准部署与运维操作手册 (SOP)

> **版本**：v1.16.0  
> **更新时间**：2026-11-13  
> **适用环境**：OPC-2.0 企业生产环境 (Production)

---

## 1. 统一命名与架构规范

为避免生产环境中混用开源默认命名造成认知混乱与管理成本，生产环境全面推行 **`deploy-opc` 统一命名规范**：

| 交付维度 | 统一命名 | 作用与定位 |
| :--- | :--- | :--- |
| **制品名称** | **`deploy-opc.tar.gz`** | 包含后端编译产物 `built/`、前端静态资源 `dist-frontend/` 及生产依赖的完整发布压缩包 |
| **镜像名称** | **`deploy-opc:1.16.0`**<br>`deploy-opc:latest` | 生产标准 Docker 镜像，基于 Node.js 24 + 底层安全工具多阶段构建 |
| **引导容器名** | **`deploy-opc-bootstrap`** | 首次安装时运行的一次性初始化引导容器 |
| **Swarm 服务名**| **`deploy-opc`** | Docker Swarm 中负责应用调度、版本管理的核心管理常驻服务 |
| **数据库专属库**| **`deploy-opc`** | PostgreSQL 中存储已部署应用、构建版本、基础设施资源的专属数据库 |

---

## 2. 核心架构与通信链路

```
                             [ 客户端 / 浏览器 / 运维人员 ]
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   │                                             │
      HTTP/HTTPS 业务应用流量 (80/443)              管理后台与 REST API (13000)
                   │                                             │
                   ▼                                             ▼
       [ captain-nginx 网关 ]                        [ deploy-opc 核心调度引擎 ]
                   │                                             │
                   │ (内部 Overlay 网络路由)                       │ (Docker Socket /var/run/docker.sock)
                   ▼                                             ▼
     [ 托管应用：supplier / smart-expense ] ◄────────── [ 容器伸缩 / 滚动更新 / 日志审计 ]
                                                                 ▲
                                                                 │ HTTP API (13000)
                                                    [ platform-opc 业务管控网关 ]
                                                                 │
                                                                 ▼
                                                    [ PostgreSQL: deploy-opc 库 ]
```

---

## 3. 编译机制与输出制品

### 3.1 编译执行命令
在本地开发机或 CI 流水线中执行：
```bash
cd deploy-opc
npm run build
```

### 3.2 编译底层逻辑
- **循环依赖校验**：通过 `madge` 扫描源码确保无循环引用。
- **TypeScript 转译**：调用 `tsc` 读取 `tsconfig.json`，将 `src/` 转译为 CommonJS 规范的纯 JavaScript 并输出到 `./built/` 目录。
- **输出产物清单**：
  - `./built/server.js`：服务启动引导入口。
  - `./built/app.js`：Express 路由定义与静态资源托管逻辑。
  - `./built/docker/`：底层 Swarm 节点调度与容器生命周期管控。
  - `./built/user/`：鉴权、配置持久化、版本管理及负载均衡。

### 3.3 一键打包生成统一制品
使用项目内置的打包脚本：
```bash
chmod +x docs/package.sh
./docs/package.sh
```
执行完毕后，将在 `/tmp/` 生成标准交付制品：**`/tmp/deploy-opc.tar.gz`**。

---

## 4. 全量配置解析（配置文件与环境变量）

### 4.1 宿主机覆盖配置：`/captain/data/config-override.json`
该文件放置在宿主机数据目录中，服务启动时具有**最高优先级**：

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

| 参数名 | 生产推荐值 | 详细含义与说明 |
| :--- | :--- | :--- |
| **`captainServiceName`** | `"deploy-opc"` | **服务统一命名**：将 Swarm 服务名固定为 `deploy-opc` |
| **`publishedNameOnDockerHub`** | `"deploy-opc"` | **镜像统一命名**：默认使用的镜像标识 |
| **`adminPortNumber3000`** | `13000` | 管理控制台与调度 API 在宿主机映射的端口（避开 3000） |
| **`nginxPortNumber80`** | `80` | 动态反向代理对外开放的 HTTP 业务端口 |
| **`nginxPortNumber443`** | `443` | 动态反向代理对外开放的 HTTPS 业务端口 |
| **`skipVerifyingDomains`** | `"true"` / `"false"`| 纯内网或无公网 DNS 时设为 `"true"`；公网真实域名解析设为 `"false"` |
| **`useExistingSwarm`** | `"true"` | 复用已手动初始化的 Docker Swarm，严禁自动重复初始化 |
| **`defaultDockerBuildVersion`** | `"2"` | 强制使用 BuildKit 现代化构建引擎 |

---

### 4.2 容器环境变量说明

#### (1) 引导容器 (`deploy-opc-bootstrap`) 阶段：
- **`ACCEPTED_TERMS=true`**：必须显式同意许可协议。
- **`MAIN_NODE_IP_ADDRESS=<内网IP>`**：主管理节点在内网通信的 IP 地址。
- **`BY_PASS_PROXY_CHECK=true`**：绕过引导时的外网端口自检（针对 VPC 内网环境）。

#### (2) 常驻集群服务 (`deploy-opc`) 阶段：
- **`IS_CAPTAIN_INSTANCE=1`**：由引导程序自动注入，指示容器作为 Swarm 服务主控运行。
- **`NODE_ENV=production`**：生产运行模式。
- **`PORT=3000`**：容器内部 Express 监听端口。

---

## 5. 正式环境实操落地步骤 (SOP)

### 步骤 1：目标服务器环境确认与 Swarm 初始化
登录到正式环境目标宿主机：
```bash
# 1. 确认 Docker 已经安装并正常运行
docker --version

# 2. 获取宿主机内网真实网卡 IP（例如 10.101.102.116）
PROD_IP="$(ip route get 1.1.1.1 | awk '{print $7; exit}')"

# 3. 初始化 Docker Swarm 并严格隔离 Overlay 网段（防止与公司局域网 CIDR 冲突）
sudo docker swarm init \
  --advertise-addr "$PROD_IP" \
  --default-addr-pool 10.12.0.0/16 \
  --default-addr-pool-mask-length 24

# 4. 确认集群状态为 active
sudo docker info --format 'Swarm: {{.Swarm.LocalNodeState}} | Manager: {{.Swarm.ControlAvailable}}'
```

---

### 步骤 2：创建持久化目录与写入生产配置
```bash
# 1. 创建基础数据目录
sudo mkdir -p /captain/data /captain/generated /captain/temp

# 2. 写入统一命名的生产配置文件
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

### 步骤 3：准备前端控制台静态资源
由于前端单页控制台是独立的预编译产物，首次部署需放置到 `/captain/data/dist-frontend`：
```bash
# 如果从测试机同步现有静态包：
scp -r ecs-user@<TEST_IP>:/captain/data/dist-frontend /tmp/
sudo cp -r /tmp/dist-frontend /captain/data/dist-frontend
```

---

### 步骤 4：解压制品并构建统一镜像 `deploy-opc:1.16.0`
将打包好的制品 `/tmp/deploy-opc.tar.gz` 上传至正式服务器，并执行：
```bash
# 1. 准备构建工作目录
sudo rm -rf /data/build/deploy-opc
sudo mkdir -p /data/build/deploy-opc
sudo tar -xzf /tmp/deploy-opc.tar.gz -C /data/build/deploy-opc

# 2. 将前端资源同步至构建上下文
sudo cp -r /captain/data/dist-frontend /data/build/deploy-opc/dist-frontend

# 3. 构建统一生产镜像
cd /data/build/deploy-opc
sudo sed -i "/^\/node_modules/d; /^\/built/d" .dockerignore 2>/dev/null || true

sudo docker build -f Dockerfile.caprover \
  -t deploy-opc:1.16.0 \
  -t deploy-opc:latest .
```

---

### 步骤 5：启动引导程序并生成集群服务
```bash
# 1. 运行一次性安装引导容器
sudo docker run -d \
  --name deploy-opc-bootstrap \
  -p 80:80 -p 443:443 -p 13000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /captain:/captain \
  -e ACCEPTED_TERMS=true \
  -e MAIN_NODE_IP_ADDRESS="$PROD_IP" \
  -e BY_PASS_PROXY_CHECK=true \
  deploy-opc:1.16.0

# 2. 观察初始化日志（直到出现 "Captain is initialized and ready to serve you!"）
sudo docker logs -f deploy-opc-bootstrap

# 3. 清理临时引导容器
sudo docker rm -f deploy-opc-bootstrap
```

---

### 步骤 6：验证 Swarm 服务运行状态
```bash
sudo docker service ls
```
正常应看到：
- **`deploy-opc`**（核心服务，Replicas: `1/1`）
- **`captain-nginx`**（反向代理网关，Replicas: `1/1`）
- **`captain-certbot`**（证书自动化，Replicas: `1/1`）

---

### 步骤 7：生产安全加固与配置
1. **修改管理员密码**：
   - 浏览器打开 `http://<PROD_IP>:13000`；
   - 默认密码为 **`captain42`**；
   - 登录后立即在 **Settings** -> **Change Password** 修改为企业高强密码，并妥善保管。
2. **绑定企业泛域名**：
   - 将企业 DNS 泛解析 `*.apps.yourcompany.com` 指向服务器 IP；
   - 在控制台 **Settings** -> **Root Domain** 输入 `apps.yourcompany.com` 完成连接，并在页面开启 HTTPS。

---

### 步骤 8：配置平台网关联动 (`platform-opc`)
1. **在 PostgreSQL 中创建专属库**：
   ```sql
   CREATE DATABASE "deploy-opc" OWNER opc_platform;
   GRANT ALL PRIVILEGES ON DATABASE "deploy-opc" TO opc_platform;
   ```
2. **在 `platform-opc` 环境变量中注入对接参数**：
   ```yaml
   APP_DEPLOY_CAPROVER_URL: "http://<PROD_IP>:13000"
   APP_DEPLOY_CAPROVER_PASSWORD: "<步骤7中设置的强密码>"
   APP_DEPLOY_INTRANET_ROOT_DOMAIN: "apps.yourcompany.com"
   ```

---

## 6. 日常运维与平滑升级（Day-2 Operations）

### 6.1 后续代码平滑升级（零停机）
当 `deploy-opc` 有代码更新需要上线正式环境时，执行滚动升级即可：
```bash
# 1. 重新构建新版本镜像 (如 1.16.1)
sudo docker build -f Dockerfile.caprover -t deploy-opc:1.16.1 -t deploy-opc:latest /data/build/deploy-opc

# 2. 直接对 Swarm 服务执行平滑滚动更新
sudo docker service update --force --image deploy-opc:1.16.1 deploy-opc

# 3. 观察更新状态
sudo docker service ps deploy-opc
```

### 6.2 数据灾备与恢复
正式环境的全部配置与历史元数据均保存在宿主机的 **`/captain`** 目录下。
- **备份建议**：每日通过定时任务打包备份 `/captain/data` 目录（尤其是 `config-captain.json`）。
- **恢复方式**：在新机器上还原 `/captain/data` 目录后直接执行步骤 5，即可 100% 无损恢复整个集群所有应用。
