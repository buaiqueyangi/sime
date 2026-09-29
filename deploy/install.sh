#!/usr/bin/env bash
# SIME Linux 一键安装（L1/L3 形态）。目标环境：Linux x86_64 / arm64 + Docker。
set -euo pipefail

echo "== SIME 安装器 =="
command -v docker >/dev/null || { echo "缺少 docker，请先安装 Docker Engine"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose 插件"; exit 1; }

# 1) 生成环境密钥（已存在则保留）
if [ ! -f .env ]; then
  PASS=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > .env <<EOF
SIME_PG_PASSWORD=${PASS}
EOF
  echo "已生成 .env（含随机数据库口令）"
fi

# 2) 内核参数自检（失败仅提示，不阻断）
SOMAXCONN=$(cat /proc/sys/net/core/somaxconn 2>/dev/null || echo 0)
if [ "${SOMAXCONN}" -lt 1024 ]; then
  echo "提示：net.core.somaxconn=${SOMAXCONN} 偏小，建议按 deploy/linux-tuning.md 调优"
fi

# 3) 构建并启动
docker compose up -d --build

# 4) 等待健康
echo -n "等待 core 就绪 "
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then
    echo " OK"
    curl -s http://127.0.0.1:3000/api/v1/health
    echo
    echo "== 安装完成：http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000/api/v1/health  文档 /docs =="
    exit 0
  fi
  echo -n "."; sleep 2
done
echo "超时：请执行 docker compose logs core 排查"
exit 1
