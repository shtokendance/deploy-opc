#!/usr/bin/env bash
# ==============================================================================
# deploy-opc 生产发布打包脚本 (本地开发机或 CI/CD 流水线执行)
# 输出统一制品：deploy-opc.tar.gz
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp}"
ARTIFACT_NAME="deploy-opc.tar.gz"
OUTPUT_FILE="$OUTPUT_DIR/$ARTIFACT_NAME"

echo "=== 1. 检查当前分支与代码状态 ==="
cd "$REPO_ROOT"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "当前分支: $CURRENT_BRANCH"

echo "=== 2. 执行 TypeScript 源码编译 ==="
npm run build

echo "=== 3. 校验关键产物是否存在 ==="
if [ ! -f "$REPO_ROOT/built/server.js" ]; then
    echo "错误: 未找到 built/server.js 编译产物，构建失败！" >&2
    exit 1
fi

echo "=== 4. 打包统一制品 $ARTIFACT_NAME ==="
rm -f "$OUTPUT_FILE"
COPYFILE_DISABLE=1 tar \
    --exclude='.git' \
    --exclude='coverage' \
    --exclude='.DS_Store' \
    --exclude='docs' \
    -czf "$OUTPUT_FILE" .

echo "=== 5. 打包成功 ==="
ls -lh "$OUTPUT_FILE"
echo "交付制品已生成: $OUTPUT_FILE"
echo "请将其上传至正式服务器，并配合 docs/deploy.sh 执行部署。"
