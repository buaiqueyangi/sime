# 运维能力：保留策略与导出

> 对应 P0 缺口：日志只增不减、数据导不出来。
> 代码：`core/src/maintenance/{retention,export}.service.ts` + 对应 controller。

## 1. 为什么需要这两件事

平台跑起来之后最先出问题的不是功能，是磁盘和取证：

| 现象 | 后果 |
|---|---|
| `telemetry` 只增不减（实测 807 万行 / 1.08 GB，日增约 30 万行） | 迟早写满磁盘，PG 进入只读保护，整个平台停摆 |
| 没有自动清理 | 只能人工 `delete`，一次性删几百万行会长时间持锁、撑大 WAL |
| 没有导出 | 出了安全事件，数据拿不出来给第三方分析；合规审计也无法交付 |

## 2. 保留策略

### 2.1 默认策略

| 表 | 保留 | 理由 |
|---|---|---|
| `telemetry` | 30 天 | 时序明细，量最大 |
| `events` | 90 天 | 原始事件，取证主力 |
| `alerts` | 180 天 | 告警需要跨季度回溯 |
| `notifications` | 90 天 | 投递记录，价值随时间衰减 |
| `response_audit` | 365 天 | 合规留存 |
| `playbook_runs` | 90 天 | 执行记录 |
| `maintenance_runs` | 30 天 | 维护自身的日志 |
| `point_latest` / `tickets` / `assets` / `devices` | **不清理** | 覆盖写表 / 业务单据 / 台账 |

### 2.2 工作方式

```
每 60 分钟（可配）
  → 主进程排程（worker 不排程）
  → pg_try_advisory_lock('sime:retention')   ← 拿不到就直接跳过
  → 逐表：cutoff = now() - days
      干跑：select count(*) where ts < cutoff
      实跑：with victims as (select ctid from T where ts < cutoff limit 20000)
            delete from T x using victims v where x.ctid = v.ctid
            循环，直到删不满一批 / 达到批次上限 / 超出时间预算
  → 每张表写一条 maintenance_runs
```

四个设计点，都是踩过坑的人才会加的：

1. **分批删**。一次 `delete from telemetry where ts < x` 在 800 万行的表上会持锁几十秒并产生巨量 WAL。分批 2 万行，每批一个短事务，autovacuum 能跟上。
2. **advisory lock**。`SIME_WORKERS=4` 时每个进程都有定时器，必须保证同一时刻只有一个在删。锁是会话级的，所以复用同一条连接取锁、删完再放。
3. **只让主进程排程**。worker 里检测到 `SIME_SHARD` 就不排程，减少无谓争抢。
4. **先能干跑**。`dry_run` 只统计，上线前先看"会删多少"。

### 2.3 操作

```bash
TOKEN=...   # 见 getting-started.md

# 看策略 + 各表体量 + 最近 20 次运行
curl -s http://127.0.0.1:13000/api/v1/retention -H "authorization: Bearer $TOKEN" | jq

# 干跑：只统计将被删除的行数
curl -s -X POST http://127.0.0.1:13000/api/v1/retention/run \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"dry_run":true}' | jq '.tables[] | {table, matched}'

# 真的删（可只指定某几张表）
curl -s -X POST http://127.0.0.1:13000/api/v1/retention/run \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tables":["telemetry"]}' | jq '.tables[] | {table, deleted, batches, status}'
```

返回里的 `status`：

| 值 | 含义 |
|---|---|
| `ok` | 删干净了（某一批没删满即停止） |
| `partial` | 达到批次/时间上限，下次运行继续 |
| `skipped` | 超出本次运行总时间预算，未执行 |
| `error` | 该表失败，`detail` 里有原因 |

`locked: true` 表示另一个实例正在跑，本次直接跳过 —— 正常情况，不是错误。

### 2.4 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIME_RETENTION_ENABLED` | 1 | 置 `0` 完全关闭定时清理 |
| `SIME_RETENTION_INTERVAL_MIN` | 60 | 运行间隔（最小 5） |
| `SIME_RETENTION_BATCH` | 20000 | 单批删除行数 |
| `SIME_RETENTION_MAX_BATCHES` | 200 | 单表单次最多删几批（×batch = 单次上限） |
| `SIME_RETENTION_DEADLINE_MS` | 300000 | 单次运行总时间预算 |
| `SIME_RETENTION_DRY` | 0 | 置 `1` 让定时任务只统计不删（灰度用） |
| `SIME_RETENTION_<TABLE>_DAYS` | 见 §2.1 | 逐表覆盖，如 `SIME_RETENTION_TELEMETRY_DAYS=7` |

> 磁盘紧张时最快的止血：`SIME_RETENTION_TELEMETRY_DAYS=7`，然后手工 POST 一次 `/retention/run`。

### 2.5 它不做的事

- **不做分区表改造**。改现有表结构风险高于收益；`telemetry` 涨到亿级后再考虑按月分区（那时清理变成 `drop partition`，零成本）。
- **不跑 VACUUM**。交给 autovacuum；大批删除后想立刻回收空间，手工 `docker exec sime-postgres-1 vacuumdb -U sime -d sime -t telemetry`。
- **不清理 `assets` / `devices` / `tickets`**。台账与单据不该被时间策略误删。

## 3. 导出

导出与查询用**同一门语言**：`q` 就是 SIME QL，字段白名单、语法、报错完全一致 —— 不会出现"查询能筛、导出导不出"的口径分裂。

### 3.1 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/export/catalog` | 格式、上限、可用数据源 |
| `GET` | `/api/v1/export?q=...&format=csv\|jsonl&max_rows=N` | 可直接下载 |
| `POST` | `/api/v1/export` | body `{q, format, max_rows}`，前端 fetch + blob |

```bash
# CSV（Excel 双击不乱码：带 UTF-8 BOM）
curl -s -OJ "http://127.0.0.1:13000/api/v1/export?q=$(python3 -c \
  'import urllib.parse;print(urllib.parse.quote("alerts | where severity in (\"critical\",\"high\") and ts > now() - 7d | fields ts, rule_id, rule_name, severity, group_key, summary"))')&format=csv" \
  -H "authorization: Bearer $TOKEN"

# JSONL（给下游分析/入库）
curl -s -X POST http://127.0.0.1:13000/api/v1/export \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"q":"telemetry | where ts > now() - 24h | fields ts, asset_id, point, value","format":"jsonl"}' \
  -o telemetry.jsonl

# 前端用法
const r = await fetch('/api/v1/export', {method:'POST',
  headers:{'content-type':'application/json', authorization:`Bearer ${token}`},
  body: JSON.stringify({q:'alerts | limit 5000', format:'csv'})});
const url = URL.createObjectURL(await r.blob());
```

### 3.2 两种格式

**CSV**：`\ufeff` BOM + 表头 + `\r\n` 行终止。含 `,` `"` 换行时按 RFC4180 加引号并双写内部引号；`null` 输出空串；`Date` 输出 ISO8601（UTC）；jsonb 列输出紧凑 JSON。

**JSONL**：一行一个对象，`Date` 转 ISO8601，便于 `jq` / 批量入库。

### 3.3 上限与分页

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIME_EXPORT_MAX_ROWS` | 200000 | 单次导出上限（硬顶 100 万） |
| `SIME_EXPORT_PAGE` | 5000 | 每页取多少行 |
| `SIME_EXPORT_DEADLINE_MS` | 300000 | 导出总时间预算，超出即截断 |

- 查询里**不写 `limit`** → 按 `SIME_EXPORT_MAX_ROWS` 导；
- 查询里**写了 `limit`** → 按你的 `limit` 导（上限仍是 maxRows）。
- 分页用 `limit N offset k` 逐页取、逐页写，**内存占用与结果集大小无关**。
- 结果没有稳定顺序时自动补 `order by 1`，避免翻页漏行/重行。

### 3.4 边界

- 导出**遵循同一套字段白名单**：`alerts | where password = "x"` 一样返回 400。
- 头部 `Content-Type` / `Content-Disposition` 在写第一块正文前就发出去了，**状态码无法事后更改** → 如果在流式过程中才出错，服务端会直接断开连接，客户端会看到一个不完整的文件（而不是"看似成功的坏文件"）。
- 每次导出写一条 `maintenance_runs`（`job='export'`），包括行数、耗时、是否截断、查询语句前 120 字符。谁把数据导走了，查得到。

## 4. 可观测性

两张表回答两个问题：

```sql
-- 最近清理了什么（按表看趋势）
select ts, target, affected, dry_run, status, detail
  from maintenance_runs where job = 'retention' order by ts desc limit 20;

-- 谁导出了什么
select ts, target, affected as rows, ms, status, detail
  from maintenance_runs where job = 'export' order by ts desc limit 20;
```

日志侧：

```
[Retention] retention scheduled every 60min (batch=20000, dry=false)
[Retention] retention done: tables=7 scanned=0 deleted=0 dry=false 812ms
[Export]    export source=alerts format=csv rows=34471 pages=7 1820ms truncated=false
```
