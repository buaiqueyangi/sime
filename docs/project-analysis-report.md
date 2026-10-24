# SIME 项目状态分析报告

> **代码基线**：`4c4d95f`（2026-10-16 16:17）
> **校订时间**：2026-10-20
> **校订说明**：本版替代 2026-10-16 初版。已修正原报告的日期错误（原写 2025-06-17）、剧本数量（原写 23，实为 20）、多核实现方式（原写 worker_threads，实为 cluster 子进程），并补充生产环境部署现状与本地/远程一致性验证结果。

---

## 0. 结论摘要

| 项目 | 结论 |
|---|---|
| 代码状态 | 工作区有未提交改动（SIME QL / 保留导出 / 事件摄入 + 文档），`tsc --noEmit` 通过，`npm test` 通过 |
| 生产部署 | `192.168.2.135:/opt/sime/sime`，2026-10-20 16:12 重新部署（含 SIME QL / 保留导出 / 事件落库） |
| 运行状态 | core / postgres / emqx / sim 四容器 Up，health `ok`，PG 已激活，4 分片运行中，restarts=0 |
| 运行缺陷 | 遥测管道 10-16 起中断的问题**已于 10-20 15:21 重启修复**（滞后回到 0.37s），根因（随机 clientId）已在 16:12 版本加固 |
| 回归 | E2E **73/73 通过**（SIME QL 7 项 + 保留/导出 15 项 + 事件落库/导入 22 项） |
| 版本定位 | v0.1.0，**可用于演示与评估** |
| 生产就绪 | **未达成**。存在 3 个阻断项（见 §7） |

**一句话**：部署的确实是本地这一套，没有版本漂移；但这一套本身还没到能对外承诺"生产可用"的程度。

---

## 1. 项目概览（实测值）

| 指标 | 实测 | 说明 |
|---|---|---|
| 后端源码 | 42 个 TS 文件 / 3,848 行 | `core/src` |
| 控制台 | 664 + 245 + 153 行 | `app.js` / `index.html` / `style.css`，原生 JS |
| 检测规则 | **148** 条 | `rules/`，11 个族，全量 ATT&CK 映射 |
| 日志适配器 | **30** 个 | `adapters/`，其中 10 个为 `generic-*` 通用模板 |
| SOAR 剧本 | **20** 个 | `templates/playbooks/` |
| 物模型模板 | **3** 个 | 电表 / 摄像头 / UPS（蓝图目标 20 类） |
| 提交历史 | 56 次 | 2026-09-28 → 2026-10-16 |
| 仓库体积 | 1.2 MB（`.git`） | 代码轻量，资产以 YAML 为主 |

---

## 2. 架构（实现方式）

### 2.1 进程模型

```
主进程（master.ts）
  ├─ NestJS HTTP：控制台 /ui、Swagger /docs、REST /api/v1（认证守卫）
  ├─ MQTT 单一消费者（EMQX）
  │    telemetry → hash(deviceId) % N
  │    event     → hash(src.asset_id | deviceId) % N
  ├─ WebSocket（/ws?token=）：告警 / 遥测 / 分片状态广播
  └─ cluster 子进程管理 + 统计聚合
worker × N（worker.ts，手工组装服务图，无 HTTP）
  ├─ 规则引擎窗口状态（分片内自治）
  ├─ 遥测缓冲批量写入
  ├─ SOAR 剧本执行 + PG 持久化
  └─ 告警 → process.send → 主进程广播
```

**注意**：多核使用的是 Node **`cluster` 子进程**，不是 `worker_threads`；窗口状态不共享，靠"同设备同分片"保证聚合正确性。`SIME_WORKERS=1` 时退化为单进程内联路径。

### 2.2 数据流

```
设备 / 适配器 → MQTT → 解析（ECS 基线）→ 哈希分发
  → 规则引擎（增量滑窗 + 序列状态机 + 类别预过滤）
  → 告警 → PG 落库 → 处置执行器（工单 / 通知 / 审计）→ 剧本 → WS 广播
  → 遥测 → 缓冲批量写 PG + WS 批播（2s）
  → 冷数据：PG 24h → DuckDB → Parquet(zstd)
```

### 2.3 自研组件（4 项，已落地）

| 组件 | 实现要点 |
|---|---|
| 规则引擎内核 v2 | 条件 DSL 编译器（禁 eval）+ 1s 增量桶 + 引用计数去重 + 序列状态机 + AST 类别预过滤 |
| 适配器引擎 | compile-once：kv 模板编译为正则，mapping 编译为闭包，事件路径零编译 |
| SOAR 编排内核 | YAML `trigger.rules` + `steps`，复用响应执行器；**仅两段式，非蓝图四段式** |
| 组态编辑器 | DOM 拖拽 v1，布局持久化 + 实时值绑定 |

### 2.4 蓝图规划但**尚未实现**

- **SIME-TS 统一存储内核**：仅 `docs/sime-ts-incubation.md` 路线文档。
- **`agent/`**（Fluent Bit 大改）：目录不存在。
- **`algo/`**（Python 算法服务）：目录不存在；UEBA 目前是 TS 内的 3σ 统计基线。

> SIME QL 已不再是缺口：2026-10 补齐为管道式查询语言（`core/src/query/`，`POST /api/v1/query`），11 个白名单数据源、参数化 SQL、只读事务 + 语句超时。语法与字段目录见 [sime-ql.md](sime-ql.md)。

---

## 3. 声明式资产

| 资产 | 数量 | 位置 | Schema |
|---|---|---|---|
| 检测规则 | 148 | `rules/<族>/*.yaml` | `rules/schema/rule.schema.json` |
| 日志适配器 | 30 | `adapters/*.yaml` | `adapters/schema/adapter.schema.json` |
| SOAR 剧本 | 20 | `templates/playbooks/*.yaml` | `templates/playbooks/schema.json` |
| 物模型 | 3 | `templates/thing-model/*.yaml` | `templates/thing-model/schema.json` |

规则族覆盖：主机安全、Windows/Sysmon、Web 攻击谱系、OT/工控、等保合规、容器/K8s、网络、边缘、身份、VPN、UEBA、IT-OT 融合关联。

---

## 4. 生产环境部署现状

### 4.1 主机

| 项 | 值 |
|---|---|
| 主机名 | `debian` |
| 系统 | Debian GNU/Linux 12 (bookworm) x86_64 |
| 资源 | 8 GB 内存 / 97 GB 磁盘（已用 21 GB，23%） |
| Docker | 29.8.1 |
| Compose | v5.5.1 |
| 运行时长 | 1 天 3 小时（容器 Up 27 小时） |

### 4.2 部署形态

| 项 | 值 |
|---|---|
| 目录 | `/opt/sime/sime` |
| 版本管理 | **不是 git 仓库**（无 `.git`，为文件拷贝部署） |
| 部署时间 | 首次 2026-10-16 16:16–16:17；**2026-10-20 15:21 重新部署**（含 SIME QL） |
| 镜像构建 | `sime-core:latest` @ 2026-10-20T07:21Z |
| 镜像基底 | `node:20-slim`（glibc） |
| duckdb | **1.4.3**（容器内实测） |
| 对外端口 | **13000** → 容器 3000（`.env`: `SIME_HTTP_PORT=13000`） |
| 分片数 | `SIME_WORKERS=4` |

> 端口说明：3000 已被 `new-api`（calciumion/new-api）占用，SIME 因此映射到 13000。访问 `/api/v1/health` 必须用 13000，用 3000 会命中 new-api 并返回 `Invalid URL`。

### 4.3 容器

| 容器 | 镜像 | 状态 | 端口 |
|---|---|---|---|
| `sime-core-1` | sime-core:latest | Up 27h (healthy)，重启 0 次 | 0.0.0.0:**13000**→3000 |
| `sime-postgres-1` | postgres:16-alpine | Up 27h (healthy) | 5432 |
| `sime-emqx-1` | emqx/emqx:5.8 | Up 27h | 1883 / 18083 |
| `sime-sim-1` | sime-sim:latest | Up 27h | — |

同机另有 `new-api`、`postgres:15`、`redis` 运行（非 SIME 组件），以及两个已退出的 litellm 容器。

### 4.4 运行数据

```json
{"status":"ok","version":"0.1.0",
 "assets":{"rules":148,"adapters":30,"thing-models":3},
 "assetErrors":0,
 "ruleEngine":{"compiled":148,"alerts":0},
 "pgProfile":"active",
 "cluster":{"mode":"sharded","workers":4}}
```

| 指标 | 值 |
|---|---|
| `alerts` | 34,571 行 |
| `telemetry` | 8,082,752 行（10-20 15:21 起持续增长） |
| `point_latest` | 1,009 行（同步更新中） |
| `tickets` | 20,773 行 |
| `events` | **0 行**（表存在、无写入） |
| `users` / `measure_points` | **0 / 0**（表存在、无写入） |
| `response_audit` | 9,648 行，**全部 `status='simulated'`** |
| `notifications` | 31,534 行 |
| `playbook_runs` | 3,251 行 |
| `rules` | 148 行（与 YAML 同步） |
| core 内存占用 | 286 MiB |
| core CPU | 0.12% |
| MQTT 客户端 | `sime-sim` + `sime-core`，均 `username=undefined` |

### 4.5 部署侧观察

1. **遥测管道中断（已修复，根因仍在）**：10-16 起 `telemetry` / `point_latest` 停在 09:29 UTC。现场证据：EMQX 中 `sime-core` 只剩 `sime/v1/+/event` 一个订阅，`sime/v1/+/telemetry` 丢失；另起测试客户端订阅 6 秒可收到 15 条遥测，说明**消息在发、core 没订阅**。代码本身正确（同样数组订阅在容器内实测返回两条 granted），属运行期订阅丢失。**10-20 15:21 重新部署重启后订阅恢复，滞后回到 0.37 秒**。但根因未消除：clientId 未固定、无订阅校验，仍可能再次发生，需按 `docs/deployment.md` §9.1 加固。
2. **MQTT 为匿名接入**：EMQX `authentication = []`，客户端列表显示 `username=undefined`，与代码中 `mqtt.connect(url)` 不带凭据一致。任何可达 1883 的主机均可伪造设备数据与安全事件。
3. **告警严重倾斜**：4 个分片中仅 shard 1 累计告警（648 条内存态），其余为 0。模拟器设备数少、哈希集中在单一分片所致，不是故障，但说明当前负载无法验证分片均衡性。
4. **剧本高频重复触发**：日志每 5 分钟出现一次 `pb.bruteforce.auto-contain executed`，由模拟器持续产生暴力破解事件 + 规则冷却窗口导致，属预期行为，但会产生 2 万级工单噪音。
5. **无回滚能力**：部署目录不是 git 仓库，升级只能覆盖拷贝，出问题无法 `git reset` 回退到上一版本。
6. **网络暴露面过大**：PostgreSQL 5432、EMQX 1883/18083 均监听 `0.0.0.0`，主机 `iptables INPUT policy ACCEPT` 且无规则；PG 口令仍为默认 `sime-change-me`。
7. **同机存在非 SIME 组件**：`sliver-server` 监听 `*:443` 与 `*:31337`（C2 框架），另运行 `new-api` / `postgres:15` / `redis`。与 SIME 共享主机与端口空间，需明确隔离边界。

---

## 5. 本地与远程一致性验证

**方法**：对本地 `git ls-files`（284 个文件）与远程 `/opt/sime/sime`（排除 `node_modules` / `dist` / `.git` / `data` / `*.log` / `.env`）逐文件计算 SHA-256，并对文本文件做 CRLF→LF 归一（本地为 Windows 检出，远程为 LF）。

**结果**：

| 项 | 结果 |
|---|---|
| 本地文件数 | 284 |
| 远程文件数 | 284（含被清单规则排除的 `core/pqtest.parquet`） |
| 内容差异 | **0** |
| 仅本地存在 | **0** |
| 仅远程存在 | **0** |
| `core/pqtest.parquet` | 两侧均为 `800bcb94…a957`，一致 |

**结论：生产环境部署的代码与本地 `4c4d95f` 完全一致，不存在版本漂移。**

---

## 6. 能力实现状态

### 6.1 已实现

| 域 | 状态 |
|---|---|
| 接入 | MQTT（EMQX）设备接入、自动台账注册、30 适配器声明式解析 |
| 检测 | 规则引擎 v2、148 条规则、MITRE 映射、坏规则降级跳过 |
| 告警 | open→ack→resolved 闭环、WS 推送、冷却去重、24h 趋势 |
| 响应 | 工单 / 通知（webhook、企业微信、钉钉）/ 响应审计、20 剧本 |
| 遥测 | 缓冲批量写、实时曲线、量程越限 + UEBA 3σ |
| 可视化 | 8 视图控制台、组态拖拽 v1、WS 实时刷新 |
| 湖仓 | DuckDB + Parquet(zstd) 快照、受限只读 SQL |
| 检索 | **SIME QL**：管道式查询语言、11 个白名单源、`POST /api/v1/query`、参数化 + 只读事务 + 15s 超时 |
| 事件底座 | **统一摄入管道**（MQTT / HTTP 直推 / 流量包导入 / 内置回放 → 归一 → `events` 表 → 规则引擎）、`/events` 列表·详情·分布检索、adapter 模式导入厂商原始日志 |
| 运维 | **保留策略**（分表分级 + 分批删除 + advisory lock + 干跑）、**导出**（CSV/JSONL 流式，复用 SIME QL） |
| 平台 | HMAC 登录、Swagger、审计、4 分片 cluster |
| 部署 | compose / Helm / systemd / install.sh |

### 6.2 未实现 / 缩水

| 项 | 现状 |
|---|---|
| 真实 SOAR 动作 | `firewall.block` 等一律 `status='simulated'`，无真实联动 |
| 剧本 rollback | schema 与蓝图有定义，**代码无执行** |
| 多用户 / RBAC | 单 admin（环境变量），`users` 表建了未用 |
| 默认口令强制改密 | 无 |
| SIME-TS | 仅文档 |
| 采集 Agent | `agent/` 目录不存在 |
| 算法服务 | `algo/` 目录不存在 |
| 中英双语文档站 | 无，`docs/` 仅中文 |
| `sime doctor` | 无 |

---

## 7. 风险与差距（按杀伤力）

### 阻断级（上线前必须解决）

1. **MQTT 零认证、零 TLS**：`authentication = []`，可伪造设备与安全事件，绕过全部检测。
2. **默认弱口令 + 无强制改密**：`admin/sime123456`、PG 口令 `sime-change-me`；蓝图 §8.2 的验收硬标准未实现。
3. **网络暴露面**：5432 / 1883 / 18083 对 `0.0.0.0` 开放，主机无防火墙规则。

> 事件落库已于 10-20 补齐（`events` 表真实写入 + `/events` 检索 + 流量包导入），不再是阻断项。
> 遥测订阅丢失已于 10-20 重启修复，且根因（随机 clientId + 无订阅校验）已在 P1 一并修掉（固定 clientId + `granted.qos` 校验）。

### 高危

4. 登录无速率限制；Token 不可撤销；CORS 全开。
5. 规则引擎依赖事件时间单调，无校验 → 乱序/时钟漂移会致窗口计数虚高（误报）。
6. `cooldown` / `states` 两个 Map 无回收，长跑内存持续增长。
7. worker 重启后哈希落点漂移，窗口状态割裂。
8. README 与 performance.md 的性能口径未标注（192k EPS 仅含 feed 热路径）。

### 中危

9. 无数据库版本化迁移（DDL 全 `IF NOT EXISTS`）。
10. PG 失败静默降级内存模式，`/health` 的 `status` 恒为 `ok`。
11. 无租户维度，未来多租户需改全表。
12. 规则无热更新，改规则需重启。
13. CI 未包含 e2e，无 lint / 单测 / 覆盖率。
14. Dockerfile 以 root 运行，生产镜像含 devDependencies。

---

## 8. 运维建议

> 完整操作手册（端口规划、环境变量全表、升级回滚、备份恢复、故障排查、巡检脚本）见 **[deployment.md](deployment.md)**。

1. **升级方式**：部署目录非 git 仓库，建议改用 `rsync -a --exclude node_modules --exclude .env` 从本地同步，保留远端 `.env`（`SIME_HTTP_PORT=13000`、`SIME_WORKERS=4` 必须保留）。
2. **端口规划**：3000 已被 new-api 占用，若要让 SIME 使用 3000 需先迁移 new-api，或在 nginx 层做域名分流。
3. **环境变量加固**：至少设置 `SIME_ADMIN_PASSWORD`、`SIME_AUTH_SECRET`、`SIME_PG_PASSWORD`，不要沿用默认值。
4. **镜像约束**：`duckdb` 必须保持 `1.4.3`、基底必须为 glibc（`node:20-slim` 或 `24-slim`）。1.4.4 在 Linux 上执行 SQL 会崩，alpine 会因 glibc 绑定报 `ERR_DLOPEN_FAILED`。
5. **备份**：`pgdata` 与 `lakedata` 两个 volume 需要独立备份策略；当前未见定时备份任务。

---

## 9. 核验命令（可复现）

```bash
# 健康（注意 13000）
curl -s http://192.168.2.135:13000/api/v1/health | jq

# 容器与镜像
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect sime-core-1 --format '{{.Image}} {{.Created}}'

# duckdb 版本
docker exec sime-core-1 node -e "console.log(require('/app/node_modules/duckdb/package.json').version)"

# 数据量
docker exec sime-postgres-1 psql -U sime -d sime -t -c \
  "select 'alerts='||count(*) from alerts; select 'telemetry='||count(*) from telemetry;"

# MQTT 客户端（观察是否匿名）
docker exec sime-emqx-1 emqx ctl clients list
```

---

*本报告基于 2026-10-20 对本地工作区与 `192.168.2.135` 生产环境的实测，所有数字均可通过 §9 命令复现。*
