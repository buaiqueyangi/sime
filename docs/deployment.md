# SIME 部署与运维手册

> 适用版本：v0.1.0（基线 `4c4d95f`）
> 最后校订：2026-10-20（基于 `192.168.2.135` 现网实测）
> 本文是部署的唯一操作依据；`docs/getting-started.md` 只保留"5 分钟跑起来"的最短路径。

---

## 1. 部署形态

| 形态 | 入口 | 适用场景 | 状态 |
|---|---|---|---|
| L1 单机 compose | `bash deploy/install.sh` | 评估、小企业、演示 | 已验证 |
| L3 生产 compose | 同 L1 + TLS/持久化/备份 | 中型企业 | 部分验证（缺 TLS/备份） |
| L3 Helm | `deploy/helm/sime` | K8s 环境 | 未在现网验证 |
| 裸机 systemd | `deploy/systemd/sime-core.service` | 不用 Docker 的 Linux | 未在现网验证 |
| L4 一体机 ISO | — | 政企渠道 | **未实现** |

现网（`192.168.2.135`）为 **L1/L3 compose 形态**，4 容器：core / postgres / emqx / sim。

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Linux x86_64 / arm64（现网 Debian 12） |
| Docker | ≥ 24（现网 29.8.1） |
| Docker Compose | v2 插件（现网 v5.5.1） |
| 内存 | ≥ 4 GB（现网 8 GB，core 常驻约 290 MiB） |
| 磁盘 | ≥ 20 GB（8M 遥测行约占 1.1 GB） |
| 端口 | 至少 1 个 HTTP 端口 + 1883（MQTT）+ 5432（PG，建议不对外） |
| 时间同步 | 必须启用 chrony/NTP；时间漂移会破坏滑窗聚合 |

> **不要用 alpine 基底**：`duckdb` 的 npm 包在 alpine 上会拉 glibc 绑定，启动报 `ERR_DLOPEN_FAILED`。必须用 `node:20-slim` / `node:22-slim`（glibc）。

---

## 3. 端口规划（重要）

| 端口 | 用途 | 是否对外 | 说明 |
|---|---|---|---|
| 3000 | 容器内 HTTP | 容器内 | `SIME_PORT` |
| `${SIME_HTTP_PORT}` | 宿主机映射 | 是 | 现网 **13000**（3000 已被 `new-api` 占用） |
| 1883 | MQTT | 是 | EMQX，**当前无认证** |
| 8883 | MQTT over TLS | 否 | EMQX listener 已开，未配置证书/认证 |
| 18083 | EMQX Dashboard | 是 | **默认口令风险，生产应关闭或改口令** |
| 5432 | PostgreSQL | 是 | **生产不应暴露**，现网已暴露 |

**坑位提醒**：`docker-compose.yml` 里写的是 `${SIME_HTTP_PORT:-3000}:3000`。如果宿主机 3000 被占用，必须在 `.env` 里设 `SIME_HTTP_PORT=13000`，否则 `docker compose up` 直接端口冲突失败。现网访问 `/api/v1/health` 必须用 `13000`；打 3000 会命中 `new-api` 并返回 `Invalid URL`。

---

## 4. 环境变量全表

代码中实际读取的变量（`core/src` 全量扫描），核心 27 个；维护/导出相关的一整组变量见 [operations.md](operations.md)。

| 变量 | 默认值 | 必填 | 说明 |
|---|---|---|---|
| `SIME_PORT` | 3000 | 否 | 容器内 HTTP 监听端口 |
| `SIME_HTTP_PORT` | 3000 | 否 | **仅 compose 使用**：宿主机映射端口 |
| `SIME_WORKERS` | 1 | 否 | cluster 分片数；>1 启用多进程 |
| `SIME_SHARD` | — | 否 | 内部使用，由 master fork 时注入，**不要手工设置** |
| `SIME_ASSET_ROOT` | `..` | 是 | 资产根目录（rules/adapters/templates）；容器内 `/app/assets` |
| `SIME_PG_HOST` | 未设置 | 是 | **不设置则退化为纯内存模式**（重启丢数据） |
| `SIME_PG_PORT` | 5432 | 否 | |
| `SIME_PG_USER` | sime | 否 | |
| `SIME_PG_PASSWORD` | sime-change-me | 是 | 生产必须覆盖 |
| `SIME_PG_DB` | sime | 否 | |
| `SIME_PG_DDL_DIR` | `../storage/pg/init` | 否 | DDL 目录（按文件名排序执行，全部幂等） |
| `SIME_MQTT_URL` | 未设置 | 否 | 不设置则关闭 MQTT 接入 |
| `SIME_MQTT_INGEST` | 1 | 否 | 置 `0` 可临时停收 |
| `SIME_MQTT_CLIENT_ID` | `sime-core-<hostname>` | 否 | **固定它**：随机 clientId 会在 broker 侧堆出幽灵会话（见 [ingest.md](ingest.md) §2.1） |
| `SIME_EVENT_BATCH` | 1000 | 否 | 事件落库批量条数（单语句内再按 500 行分块） |
| `SIME_EVENT_FLUSH_MS` | 300 | 否 | 事件刷盘间隔 |
| `SIME_EVENT_QUEUE_MAX` | 100000 | 否 | 写入队列上限，超限丢弃并计入 `dropped` |
| `SIME_IMPORT_MAX_BYTES` | 536870912（512MB） | 否 | 单文件上限（抓包走流式解析，不占内存），超出返回 413 |
| `SIME_IMPORT_MAX_TEXT_BYTES` | 134217728（128MB） | 否 | 文本流量包（JSONL/JSON/适配器）上限，整包读成字符串，单独设闸 |
| `SIME_IMPORT_MAX_EVENTS` | 50000 | 否 | 单次导入事件条数上限，超出计入 `skipped` |
| `SIME_IMPORT_DEADLINE_MS` | 60000 | 否 | 单次导入处理时间上限 |
| `SIME_LAKE_DIR` | `data/lake` | 否 | DuckDB/Parquet 目录，需持久化 |
| `SIME_QL_TIMEOUT_MS` | 15000 | 否 | SIME QL 单条查询的 `statement_timeout`（上限 120000） |
| `SIME_RETENTION_ENABLED` | 1 | 否 | 定时清理开关；置 `0` 关闭（完整保留变量见 [operations.md](operations.md) §2.4） |
| `SIME_EXPORT_MAX_ROWS` | 200000 | 否 | 单次导出行数上限（硬顶 100 万，见 [operations.md](operations.md) §3.3） |
| `SIME_ADMIN_USER` | admin | 否 | |
| `SIME_ADMIN_PASSWORD` | sime123456 | **是** | 生产必须覆盖，否则等于无鉴权。**注意空串**：compose 写 `${VAR:-}` 且宿主未定义时会注入空串，0.1.0 之前的版本会让口令变成空串、全员登不进来（已用 `common/env.ts` 修掉） |
| `SIME_AUTH_SECRET` | 每次启动随机 | **是** | 不设置则重启后全部 token 失效 |
| `SIME_LLM_BASEURL` | 空 | 否 | OpenAI 兼容端点 |
| `SIME_LLM_APIKEY` | 空 | 否 | |
| `SIME_LLM_MODEL` | qwen2.5:7b | 否 | |
| `SIME_LLM_STUB` | 1 | 否 | 1=离线桩；接真实模型置 0 |
| `SIME_NOTIFY_WEBHOOK_URL` | 空 | 否 | 通用 webhook |
| `SIME_NOTIFY_WECOM_WEBHOOK` | 空 | 否 | 企业微信群机器人 |
| `SIME_NOTIFY_DINGTALK_WEBHOOK` | 空 | 否 | 钉钉群机器人 |

> `deploy/systemd/sime-core.service` 中的 `SIME_PG_DDL` **不是有效变量**（代码读的是 `SIME_PG_DDL_DIR`）。当前靠默认相对路径碰巧能跑，但属于死配置，已在本次修订中更正。

---

## 5. 标准部署步骤

### 5.1 compose（推荐）

```bash
git clone <repo> && cd sime

# 1) 必填环境变量（不要用默认口令）
cat > .env <<'EOF'
SIME_PG_PASSWORD=<强随机口令>
SIME_ADMIN_PASSWORD=<强口令>
SIME_AUTH_SECRET=<32 字节随机 hex>
SIME_HTTP_PORT=13000
SIME_WORKERS=4
EOF

# 2) 构建启动（sim 为可选演示模拟器）
docker compose up -d --build
docker compose --profile sim up -d        # 需要活数据时再加

# 3) 等待健康
curl -fsS http://127.0.0.1:13000/api/v1/health
```

`deploy/install.sh` 会自动生成 `.env` 里的 `SIME_PG_PASSWORD`，但**不会**生成 `SIME_ADMIN_PASSWORD` / `SIME_AUTH_SECRET`，生产务必手工补上。

### 5.2 Helm

```bash
helm upgrade --install sime deploy/helm/sime -n sime --create-namespace \
  --set image.repository=<registry>/sime-core \
  --set image.tag=<tag> \
  --set env.SIME_PG_PASSWORD=<pwd>
```

注意：Chart 默认 `replicaCount: 1`。SIME 的窗口状态在进程内，**不能简单横向扩副本**；扩容应使用 `SIME_WORKERS`（单 Pod 内多分片），或在接入层做一致性哈希。

### 5.3 systemd（裸机）

```bash
useradd -r -s /sbin/nologin sime
cp -r . /opt/sime && chown -R sime:sime /opt/sime
cp deploy/systemd/sime-core.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now sime-core
```

前提：本机已装 PostgreSQL 16、Node 20；`/opt/sime/core` 下需有构建产物（`npm ci && npm run build`）。

---

## 6. 首次部署验证清单

```bash
# 1) 健康：status=ok、pgProfile=active、rules=148
curl -s http://127.0.0.1:13000/api/v1/health | jq '{status,pgProfile,assets,cluster}'

# 2) 控制台可打开（HTTP 200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/ui/

# 3) 登录能拿 token
curl -s -X POST http://127.0.0.1:13000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<你的口令>"}' | jq -r .token

# 4) MQTT 两个订阅都在（关键！）
docker exec sime-emqx-1 emqx ctl subscriptions list
#    期望两行：sime/v1/+/telemetry 与 sime/v1/+/event

# 5) 遥测真的在落库（关键！）
docker exec sime-postgres-1 psql -U sime -d sime -t -c \
  "select now()-max(ts) as lag, count(*) from telemetry;"
#    期望 lag 在秒级；若为天级说明遥测管道已断

# 6) SIME QL 可用（数据源目录 + 一条真实聚合）
curl -s http://127.0.0.1:13000/api/v1/query/sources -H "authorization: Bearer $TOKEN" | jq '.sources|length'
curl -s -X POST http://127.0.0.1:13000/api/v1/query \
  -H "authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"q":"alerts | stats count() as n by severity | sort n desc"}' | jq '{source,rowCount,rows}'
#    期望 sources=11、rows 有数据；502 说明 pgProfile 没起来

# 7) 事件落库链路通（关键！）
curl -s http://127.0.0.1:13000/api/v1/ingest/stats -H "authorization: Bearer $TOKEN" | jq '.store'
curl -s 'http://127.0.0.1:13000/api/v1/events?limit=1' -H "authorization: Bearer $TOKEN" | jq '{rows:(.rows|length),window}'
#    期望 received/inserted 在涨、rows=1；received 涨但 inserted 不涨 = PG 写不动（看 dropped/failed）
```

第 4、5、7 项是现网踩过的坑（见 §9.1），必须验。

---

## 7. 升级与回滚

### 7.1 升级（现网方式）

现网 `/opt/sime/sime` **不是 git 仓库**，不能用 `git pull`。推荐 rsync：

```bash
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude .env --exclude 'core/data' \
  ./ root@192.168.2.135:/opt/sime/sime/

ssh root@192.168.2.135 'cd /opt/sime/sime && docker compose up -d --build'
```

必须保留远端 `.env`（`SIME_HTTP_PORT=13000`、`SIME_WORKERS=4`）。

### 7.2 回滚

因为没有 git，回滚只能靠**升级前备份**：

```bash
# 升级前
tar czf /root/sime-src-$(date +%F-%H%M).tar.gz -C /opt/sime sime \
  --exclude=node_modules --exclude=.git

# 回滚
tar xzf /root/sime-src-<ts>.tar.gz -C /opt/sime
cd /opt/sime/sime && docker compose up -d --build
```

**建议**：在服务器上 `git init` 并把当前目录作为初始提交，之后升级就能用 `git checkout` 回滚。

---

## 8. 备份与恢复

现网**没有任何备份任务**（`crontab -l` 为空，无相关 systemd timer）。上线前必须补。

| 对象 | 位置 | 体积（现网） | 建议 |
|---|---|---|---|
| 升级备份 | `/opt/sime/backup-*.tar.gz` | ~592 KB / 份 | ✅ 已有清理：`prune-backups.sh`（保留 7 天内全部 + 之外的最近 14 份），`/etc/cron.d/sime-backup-prune` 每周日 03:17 执行 |
| PostgreSQL | volume `sime_pgdata` | 1.2 GB | 每日 `pg_dump` + 保留 7 天（**仍未落地**，上线前必须补） |
| 数据湖 | volume `sime_lakedata` | 9.9 MB | 随 PG 一起备 |
| 配置 | `/opt/sime/sime/.env` | — | 纳入密钥管理，不入库 |

升级备份清理（已安装，手工执行也行）：

```bash
/opt/sime/prune-backups.sh 14   # 参数 = 7 天之外再保留的份数，缺省 14
tail /var/log/sime-prune.log    # 每周日 03:17 的 cron 输出
```

```bash
# 每日备份示例（加入 crontab）
docker exec sime-postgres-1 pg_dump -U sime -Fc sime \
  > /backup/sime-$(date +%F).dump
find /backup -name 'sime-*.dump' -mtime +7 -delete
```

恢复：

```bash
docker exec -i sime-postgres-1 pg_restore -U sime -d sime --clean --if-exists \
  < /backup/sime-2026-10-20.dump
```

---

## 9. 故障排查

### 9.1 遥测不落库、页面曲线不动（现网真实故障）

**现象**：`alerts` 持续新增，但 `telemetry` 与 `point_latest` 的 `max(ts)` 停在某一天；`/api/v1/telemetry/latest` 返回旧时间戳。

**已确认根因**：core 的 MQTT 会话只保留了 `sime/v1/+/event` 一个订阅，`sime/v1/+/telemetry` 丢失 → 遥测消息根本没投递给 core。代码本身正确（新建客户端用同样的数组订阅可拿到两条 granted），属于**运行期订阅丢失**。

**快速确认**：

```bash
docker exec sime-emqx-1 emqx ctl subscriptions list | grep sime-core
# 只有 .../event 一行 → 命中此故障

docker exec sime-core-1 node -e '
const mqtt=require("mqtt");const c=mqtt.connect("mqtt://emqx:1883",{clientId:"probe-"+Date.now()});
let n=0;c.on("connect",()=>c.subscribe("sime/v1/+/telemetry"));
c.on("message",()=>n++);setTimeout(()=>{console.log("telemetry in 5s:",n);c.end();process.exit(0)},5000);'
```

**恢复**：`docker compose restart core`（重启后 connect 回调会重新订阅两条）。**注意**：内存态窗口与告警缓存会清零，PG 数据不受影响。

**根治（2026-10-20 16:12 已实施）**：clientId 固定为 `SIME_MQTT_CLIENT_ID` 或 `sime-core-<hostname>`；订阅回调检查 `granted.qos`，被 ACL 拒绝（qos=128）时打 error；重连/离线事件都有日志。剩下的巡检（定时比对 `client.subscriptions`）仍未做。

### 9.1b 升级后谁都登不进来（现网真实故障）

**现象**：`/ui/` 能打开，但任何口令都提示"用户名或密码错误"；`E2E` 第 1 组就挂，后面全是 401。

**根因**：`docker-compose.yml` 里写了 `SIME_ADMIN_PASSWORD: ${SIME_ADMIN_PASSWORD:-}`，宿主 `.env` 没定义该变量 → **空串**被注入容器；而 `process.env.SIME_ADMIN_PASSWORD ?? 'sime123456'` 里的 `??` 只拦 `null/undefined`，拦不住空串 → 管理员口令变成 `""`。

**修复**：`core/src/common/env.ts` 的 `envStr()` 把空串等价于未设置，auth / LLM / 通知三处读取全部改走它；启动时缺 `SIME_ADMIN_PASSWORD` / `SIME_AUTH_SECRET` 直接告警。

**同类风险**：任何 `process.env.X ?? 默认值` 都可能被 compose 的 `${X:-}` 或 K8s 空 ConfigMap 打成空串。新代码一律用 `envStr/envNum/envBool`。

### 9.2 容器起不来：`ERR_DLOPEN_FAILED`

alpine 镜像 + duckdb glibc 绑定。改用 `node:20-slim`，并锁定 `duckdb@1.4.3`。

### 9.3 容器起来但查询即崩

`duckdb@1.4.4` 在 Linux 执行 SQL 会崩（Napi BigInt）。**必须钉 1.4.3**。

### 9.4 `/api/v1/health` 返回 `Invalid URL`

打到别的服务了。检查 `SIME_HTTP_PORT`，现网必须用 **13000**。

### 9.5 数据重启即丢

`SIME_PG_HOST` 未设置或 PG 连接失败 → 平台静默进入内存模式，`/health` 里 `pgProfile` 会显示 `memory-only`，但 `status` 仍是 `ok`。**监控必须单独盯 `pgProfile` 字段**。

### 9.6 工单爆炸

模拟器持续打暴力破解 + 剧本无节流，现网 27 小时产生 2 万条工单。生产接入真实设备后应关闭 `--profile sim`，并给剧本加频次上限。

---

## 10. 安全加固基线（当前**均未实施**）

| 项 | 现状 | 要求 |
|---|---|---|
| MQTT 认证 | `authentication = []`，匿名 | 启用 EMQX 内置数据库认证 + 一机一密 |
| EMQX Dashboard | 18083 对 `0.0.0.0` 开放 | 关闭公网暴露或改默认口令 |
| PostgreSQL | 5432 对 `0.0.0.0` 开放，口令 `sime-change-me` | 只监听容器网络，强口令 |
| 主机防火墙 | `iptables INPUT policy ACCEPT`，无规则 | 仅放行 13000/22（+1883 按需） |
| 管理员口令 | 未设 `SIME_ADMIN_PASSWORD` | 必须覆盖 |
| Token 密钥 | 未设 `SIME_AUTH_SECRET` | 固定 32 字节随机值 |
| 容器用户 | root（`Config.User` 为空） | 镜像加 `USER node` |
| TLS | 无，全 HTTP | 前置 nginx/反代终止 TLS |

---

## 11. 日常巡检（建议每日）

```bash
# 1) 遥测新鲜度（最重要）
docker exec sime-postgres-1 psql -U sime -d sime -t -c \
  "select now()-max(ts) from telemetry;"

# 2) 订阅完整性
docker exec sime-emqx-1 emqx ctl subscriptions list

# 3) 存储降级
curl -s http://127.0.0.1:13000/api/v1/health | grep -o '"pgProfile":"[^"]*"'

# 4) 磁盘与卷
df -h /; du -sh /var/lib/docker/volumes/sime_pgdata/_data

# 5) 容器重启次数（应恒为 0，增长说明在崩溃循环）
docker inspect -f '{{.Name}} restarts={{.RestartCount}}' $(docker ps -q --filter name=sime)
```

---

## 12. 当前实例快照（2026-10-20 16:50）

| 项 | 值 |
|---|---|
| 主机 | `192.168.2.135`，Debian 12，8 GB / 97 GB |
| 目录 | `/opt/sime/sime`（非 git 仓库） |
| 对外端口 | 13000 |
| 镜像 | `sime-core:latest` @ 2026-10-20T08:49Z（含 SIME QL + 保留/导出 + 事件落库/导入 + 控制台事件检索 + ECS 端点收口修复），`node:20-slim`，duckdb 1.4.3 |
| 配置 | `SIME_HTTP_PORT=13000`、`SIME_WORKERS` 已设、`SIME_AUTH_SECRET` 已固定（32 hex） |
| 容器 | core / postgres / emqx / sim 全 Up，core restarts=0、healthy |
| 数据 | events **638**（24h 窗口：it 617 / ot 21；通道 replay/mqtt/import/adapter/ui-import/e2e）/ alerts 34,781 / telemetry 8,101,926 / tickets 20,951 / notifications 31,753 / response_audit 9,721 / playbook_runs 3,282 |
| 健康 | `status=ok`、`pgProfile=active`、rules 148、adapters 30 |
| E2E | **73/73 通过**（QL 7 项 + 保留/导出 15 项 + 事件落库/导入 22 项） |
| 备份 | `/opt/sime/backup-<时间戳>.tar.gz`（每次升级前自动打） |

**2026-10-20 15:21 变更（SIME QL）**：

- 同步源码到 `/opt/sime/sime`（`.env` 保留），`docker compose build core` 重建镜像后 `up -d core`。
- 新增 SIME QL：`/api/v1/query`、`/api/v1/query/validate`、`/api/v1/query/sources`。
- **顺带修复**：重启后 EMQX 订阅 `sime/v1/+/telemetry` 恢复，遥测入库滞后回到 0.37 秒（此前自 10-16 17:29 起中断）。

**2026-10-20 15:31 / 15:37 变更（P0：保留策略 + 导出）**：

- 新增 `storage/pg/init/06-maintenance.sql`（`maintenance_runs` 表），启动时自动建。
- 新增 `/api/v1/retention`（策略+表体量）、`/api/v1/retention/run`（执行/干跑）。
- 新增 `/api/v1/export`（GET/POST，CSV/JSONL 流式）、`/api/v1/export/catalog`。
- 定时清理已排程：`retention scheduled every 60min (batch=20000, dry=false)`，首次延迟 3 分钟。
- 详见 **[operations.md](operations.md)**。

**2026-10-20 16:05 / 16:10 变更（P1：事件落库 + 检索 + 流量包导入）**：

- 新增统一摄入管道 `IngestService`：MQTT 事件、`POST /ingest/events`、`POST /ingest/import`、`POST /pipeline/simulate` 四条入口同一套归一化与落库逻辑，`events` 表从恒 0 行变为真实数据底座。
- 新增 `/api/v1/events`（列表）、`/api/v1/events/stats`（分布）、`/api/v1/events/:id`（详情）、`/api/v1/ingest/events`（直推）、`/api/v1/ingest/import`（multipart / 裸 ndjson，支持 adapter 模式）、`/api/v1/ingest/stats`。
- **顺带修复（重要）**：上一版 compose 给 `SIME_ADMIN_PASSWORD` 传了空串（`${VAR:-}`），而 `process.env.X ?? 默认值` 拦不住空串 → 管理员口令变成空串，**所有人都登不进来**。已引入 `common/env.ts`（`envStr/envNum/envBool`，空串等价于未设置）并加固 auth/LLM/通知三处读取；启动时对缺失的 `SIME_ADMIN_PASSWORD`/`SIME_AUTH_SECRET` 直接告警。
- **顺带修复**：MQTT `clientId` 由随机值改为 `SIME_MQTT_CLIENT_ID` 或 `sime-core-<hostname>`，并对订阅结果做 `granted.qos=128` 校验（被 ACL 拒绝时打 error 而不是静默收不到消息）。
- 详见 **[ingest.md](ingest.md)**。

**2026-10-20 17:30 变更（抓包导入 pcap/pcapng）**：

- 新增 `core/src/ingest/pcap.ts`：纯 JS 流式解析器（pcap 四种魔数 / pcapng SHB·IDB·EPB·SPB、Ethernet+VLAN、RAW IP、SLL/SLL2、IPv4/IPv6+扩展头、TCP/UDP/ICMP），按五元组聚合成 flow → ECS `event.category=network` → 同一摄入管道。
- **此前的真实障碍不是 64MB 上限，而是"二进制直接拒"**：1MB 的 pcap 也进不来。现在导入层先看魔数，抓到包就转流式解析，整包不进内存。
- 上限拆两个闸：`SIME_IMPORT_MAX_BYTES` 默认 512MB（抓包/裸流），`SIME_IMPORT_MAX_TEXT_BYTES` 默认 128MB（文本整包读字符串）。413 文案改为 MB 并提示 `editcap -c` 分批。
- 控制台「事件检索」的导入区新增「抓包：按流聚合 / 逐包」下拉，`accept` 加 `.pcap/.pcapng/.cap`，结果框展示 包数→流数、截断/分片/不支持链路、时间跨度。
- 验证：真实包 54MB（45134 包 → 2 flow，111ms）+ 1.3MB（6680 包 → 3644 flow）；归一化 100% 通过、五元组齐全；合成 Modbus:502 包 → `domain=ot`；997 字节分片喂入与整包结果一致。
- **跟进修复（现网实测暴露）**：① multipart 中文名乱码（busboy 按 latin1 解 UTF-8 文件名）→ `decodeName` 回转；② 历史抓包落在默认时间窗之外、导完"看不到"→ 时间范围加 30d，导入后自动按数据时间切窗（>30d 提示走「安全查询」按 source 检索）；③ E2E「保留干跑」与定时清理撞锁偶发失败 → 遇 `locked` 等待重试。
- 全链路验证：合成"当前时间"端口扫描 pcap（200 包 → 200 flow）经浏览器导入，24h 窗口可见、按 IP 检索命中 200 行、规则引擎 +2 告警；54MB 真包经 multipart 上传 0.12s 完成（流式，不进内存）；E2E 73/73。

**2026-10-20 17:00 / 17:10 变更（控制台「安全查询」+ 备份清理）**：

- 控制台新增「安全查询」视图（侧栏第 4 项）：SIME QL 编辑器（Ctrl+Enter 运行、Tab 缩进）、11 个数据源下拉 + 字段 chips（点击插入）、6 条示例一键填入、运行结果表（>500 行只渲染前 500，导出拿全量）、可展开的编译产物（参数化 SQL + params，可复制到 psql 复现）、语法错误显示 kind + 位置、校验（/query/validate，不执行）、CSV / JSONL 一键导出（走 /export 流式，CSV 带 UTF-8 BOM）。
- 新增备份清理：`/opt/sime/prune-backups.sh`（保留 7 天内全部 + 之外的最近 14 份）+ `/etc/cron.d/sime-backup-prune` 每周日 03:17 执行，日志 `/var/log/sime-prune.log`。
- 验证：无头 Chrome 实测 运行 8ms 出表 / 语法错 kind=syntax / 校验通过 / 导出 CSV 1010B 带 BOM；清理脚本试运行 13→13（当前全部在 7 天内，行为正确）。

**2026-10-20 16:37 / 16:55 变更（P1 收口：控制台「事件检索」视图 + ECS 端点修复）**：

- 控制台新增「事件检索」视图：时间范围（1h/24h/7d）、域（it/ot）、类别/来源下拉（自聚合结果回填）、关键词过滤、事件分布柱状图（桶宽随窗口自适应）、行点击弹层看完整 payload；「导入流量包」按钮从浏览器直传 `POST /ingest/import`（multipart），结果框展示 接收/拒绝/告警/格式/耗时、坏行行号与历史数据 warning，可勾选「导入同时研判」（默认关，避免历史包回拉引擎水位）。
- **顺带修复（归一化）**：ECS 标准端点 `source`/`destination`（及 `client`/`server`）此前不映射到 `src`/`dst`，真实流量包导入后五元组全为 `null`、`q` IP 检索失效。现收口顺序为 `src/dst` → `source`/`destination` → `client`/`server`；字符串形式的 `source` 只有 IP/host:port 形状才当作端点，通道名（如 `firewall-a`）不再被误判。
- 验证方式：无头 Chrome（CDP）真实登录 → 切视图 → 点行看详情 → `DOM.setFileInputFiles` 触发浏览器导入（接收 2 / 拒绝 1、坏行带行号、已落库即可查），全程无 JS 异常。
- 详见 **[ingest.md](ingest.md)**（§1 五元组映射、§3 检索）。

> 同机还运行 `new-api`、`postgres:15`、`redis`，以及监听 `*:443` 与 `*:31337` 的 `sliver-server`（非 SIME 组件）。SIME 与这些服务共享主机与端口空间，生产部署前应做隔离或明确边界。
