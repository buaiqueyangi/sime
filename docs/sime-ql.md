# SIME QL —— 统一查询语言

> 蓝图落点：§4.2「自研（PPL 兼容超集）」、§5.6「`POST /api/v1/query` 为唯一查询入口」。
> 代码：`core/src/query/{query-parser,query-compiler,query.service,query.controller}.ts`

SIME QL 是平台唯一的检索面。在它之前，告警、遥测、审计各有一个专用端点，字段口径不同、过滤能力不等，控制台要记三套参数。现在收敛成一门管道式语言：**一个端点、一种语法、一套字段目录**。

## 1. 快速开始

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:13000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"sime123456"}' | jq -r .token)

# 目录：有哪些数据源、哪些字段、能写什么
curl -s http://127.0.0.1:13000/api/v1/query/sources -H "authorization: Bearer $TOKEN" | jq

# 执行
curl -s -X POST http://127.0.0.1:13000/api/v1/query \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"q":"alerts | where severity in (\"critical\",\"high\") and ts > now() - 24h | stats count() as n by rule_id | sort n desc | limit 5"}' | jq
```

```jsonc
{
  "ok": true,
  "source": "alerts",
  "sql": "select rule_id as \"rule_id\", count(*) as \"n\" from (...) alerts where ((severity = ANY($1)) AND (ts > (now() - ($2::bigint * interval '1 millisecond')))) group by rule_id order by \"n\" desc limit 5",
  "params": [["critical", "high"], 86400000],
  "columns": ["rule_id", "n"],
  "rows": [{ "rule_id": "rule.host.ssh-bruteforce", "n": 3126 }],
  "rowCount": 1,
  "dbMs": 11,
  "totalMs": 13,
  "limit": 5,
  "notes": []
}
```

## 2. 语法

```
<source> [| where <expr>] [| stats <agg>[, ...] [by <field>[, ...]]]
         [| sort <field> [asc|desc][, ...]] [| limit <n>] [| fields <f1>[, <f2>...]]
```

- 第一段必须是**数据源**，之后每段以 `|` 分隔；段顺序无关，同类命令重复出现会报错。
- `where` 出现多次按 `AND` 合并。
- 关键字大小写不敏感；字段名忽略大小写、下划线与点（`ruleName` = `rule_name` = `ruleName`）。
- `limit` 与 `head` 等价，`fields` 与 `table` 等价。
- 行注释：`--` 到行尾。

### 2.1 表达式

| 类别 | 写法 |
|---|---|
| 比较 | `= != <> > >= < <=` |
| 集合 | `field in ("a","b")` / `field not in (1,2,3)` |
| 模糊 | `field like "%brute%"`（大小写不敏感 `ILIKE`） |
| 逻辑 | `and` / `or` / `not`，支持括号 |
| 字符串 | `"双引号"` 或 `'单引号'`，`\` 转义，`''` 双写转义 |
| 数字 | `42`、`3.14` |
| 时间 | `now()`、`now() - 24h`、`now() - 30m`、`now() - 7d` |

时间单位：`s` / `m` / `h` / `d`。

### 2.2 聚合

`count()`、`count(field)`、`count_distinct(field)`、`sum`、`avg`、`min`、`max`，支持 `as` 别名与 `by` 分组：

```
alerts | where ts > now() - 7d | stats count() as total, count_distinct(rule_id) as rules by severity | sort total desc
```

不写 `sort` 时，若含 `count` 类聚合则默认按它降序（Top N 直觉）；否则不排序。

## 3. 数据源与字段

| 源 | 别名 | 说明 | 字段 |
|---|---|---|---|
| `alerts` | `alert` | 告警，左连 `rules` 取规则名 | `id ts rule_id rule_name rule_category severity domain state group_key hits summary` |
| `events` | `event` | 原始事件（ECS 基线），**当前恒为空**（见 §6） | `id ts domain category name source threat_id asset_id src_ip src_asset_id dst_ip dst_asset_id outcome action severity` |
| `telemetry` | `metrics` | 遥测明细（大表） | `asset_id point ts value` |
| `point_latest` | `latest` | 测点最新值 | `asset_id point ts value` |
| `tickets` | `ticket` | 工单 | `id alert_id title state assignee ts closed_at` |
| `notifications` | `notification` | 通知投递 | `id alert_id channel status ts` |
| `audit` | `response_audit` | 响应审计 | `id alert_id action target status ts` |
| `playbook_runs` | `playbooks` `runs` | 剧本执行记录 | `id playbook_id alert_id rule_id actions ts` |
| `assets` | `asset` | 资产台账 | `id name type domain thing_model ts` |
| `devices` | `device` | 设备台账，左连 `assets` 取资产名 | `id asset_id asset_name vendor model online ts` |
| `measure_points` | `points_meta` | 测点定义 | `id device_id point_id unit` |

字段目录的权威来源是 `GET /api/v1/query/sources`（从代码生成，不会漂移）。

## 4. 护栏

| 护栏 | 实现 |
|---|---|
| 只读 | `BEGIN TRANSACTION READ ONLY`，PG 层面拒绝任何写操作 |
| 无注入面 | 语句由固定模板拼装；字面量全部 `$n` 参数化；标识符只取白名单 |
| 强制 LIMIT | 默认 100，硬上限 1000，超出自动截断并在 `notes` 里说明 |
| 超时 | `SET LOCAL statement_timeout`，默认 15s（`SIME_QL_TIMEOUT_MS` 可调，上限 120s） |
| 长度 | 查询文本上限 4000 字符 |
| 鉴权 | 挂在 `/api/v1` 全局守卫下，未登录 401 |

编译器额外做两件事：以 `select` 开头再校验一次（纵深防御）；对 `events`/`telemetry` 这类大表，若 `where` 里没有 `ts` 条件会返回性能提示。

## 5. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/query/sources` | 数据源 + 字段 + 语法目录 + 示例 |
| `POST` | `/api/v1/query/validate` | 只编译不执行，返回 `sql`/`columns`，供编辑器即时校验 |
| `POST` | `/api/v1/query` | 执行查询（`{ q, limit?, timeout_ms? }`） |

> 同一门语言也用于**导出**：`GET/POST /api/v1/export` 的 `q` 参数就是 SIME QL，语法与字段白名单完全一致，仅把 LIMIT 上限从 1000 抬到 `SIME_EXPORT_MAX_ROWS`（默认 20 万）并流式输出。见 [operations.md](operations.md) §3。

错误分三类，都带 `kind`：

- `syntax` → 400，附 `pos` 字符偏移（控制台可高亮）；
- `compile` → 400（字段不在白名单、`sort` 字段不在输出列等）；
- `timeout` / `unavailable` / `engine` → 400 / 502。

## 6. 已知边界

- **`events` 源恒为空**：`events` 表有 schema、`GET /api/v1/query` 也能查，但事件摄入只走内存管道（`pipeline.controller.ts`），没有落库链路。补齐写入后才会有数据 —— 这是 P1 项，不是查询层缺陷。
- **`telemetry` 曾有 4 天断档**：2026-10-16 09:29 UTC 至 10-20 15:21，EMQX 中 `sime-core` 的 `sime/v1/+/telemetry` 订阅在运行期丢失。10-20 重启后已恢复（滞后 0.37s）。查询层与该故障无关；根因（clientId 未固定 + 无订阅校验）仍待加固，见 `deployment.md` §9.1。
- **未做**：`ZQL`/子查询、JOIN 语法、`eval` 计算列、导出。当前只覆盖检索与聚合。

## 7. 扩展一个数据源

在 `query-compiler.ts` 的 `SOURCE_LIST` 里加一条即可，`/query/sources` 会自动带上：

```ts
{
  name: 'users',
  aliases: ['user'],
  label: '用户',
  from: '(select id, name, role from users) users',
  fields: { id: 'id', name: 'name', role: 'role' },
  defaultFields: ['id', 'name', 'role'],
}
```

约束：`from` 必须是固定字符串（可带子查询做列打平/别名），`fields` 的值必须是 SQL 表达式常量。**不要**把用户输入拼进 `from` 或 `fields`。
