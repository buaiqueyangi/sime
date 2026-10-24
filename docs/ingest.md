# 事件摄入与检索（events）

> 面向：实施/运维/二次开发。读完能回答三个问题——事件从哪进来、落在哪、怎么查。
> 相关文档：[SIME QL](sime-ql.md)（任意表达式查询）、[运维手册](operations.md)（保留与导出）。

events 是 SIME 的**原始事件底座**：IT 安全事件与 OT 设备事件同库同结构，用 `domain` 区分。
所有研判（规则引擎）、检索（`/events`、SIME QL `events` 源）、导出、保留清理都围绕这张表。

```
                       ┌──────────────────────────────────────────┐
 MQTT sime/v1/+/event ─┤                                          │
 POST /ingest/events  ─┤→ normalizeEvent → EventStore(批量) → PG   │
 POST /ingest/import  ─┤        │                    events 表     │
 POST /pipeline/simulate┤       └→ RuleEngine.feed → alerts         │
                       └──────────────────────────────────────────┘
```

---

## 1. 表结构

`storage/pg/init/01-schema.sql`：

| 列 | 类型 | 来源（ECS 路径） | 说明 |
|---|---|---|---|
| `id` | bigserial | — | |
| `ts` | timestamptz | `@timestamp` → `ts` → `timestamp` → `event.created` → `event.start` → 当前时间 | 支撑所有时间范围查询与保留清理 |
| `domain` | text | `sime.domain` → `domain` → 按类别推断 | 只允许 `it` / `ot` / `merged`，非法值回落推断 |
| `category` | text | `event.category`（数组取首个）→ `category` → `unknown` | 规则预过滤与分布统计的主维度 |
| `name` | text | `event.name` → `event.action` → `name` | 截断 128 字符 |
| `source` | text | 入口注入；事件自带仅当字符串且非 IP 形状 | `mqtt` / `import` / `adapter:<id>` / `replay` / `http` |
| `src` / `dst` | jsonb | `src`/`dst` → **ECS `source`/`destination`** → `client`/`server` | 简写键收裸字符串补 `{ip}`；ECS 端点对象直接收，字符串须长得像 IP/host:port 才算端点 |
| `payload` | jsonb | **整条原始事件** | 取证与重新解析用；SIME QL 的 `payload->...` 读它 |
| `threat_id` | text | `sime.threat_id` → `threat.indicator.id` → `threat.id` | 适配器 `threat_map` 归一后的 `sime.tht.*` |

索引：`events_ts_idx(ts desc)`、`events_domain_cat_idx(domain, category, ts desc)`、`events_payload_gin`。

**域推断规则**：类别命中 `ics|ot|scada|plc|modbus|opc|s7|iec|dnp3|profinet|bacnet|telemetry|process` 前缀判 `ot`，其余判 `it`。
推断只影响检索分区，不影响规则判定（规则自带 `domain` 字段）。

**五元组映射（易踩坑）**：ECS 事件里 `source` 是网络端点对象（`source.ip`），而 events 表的 `source` 列是**采集通道名**——两个
"source" 语义不同。归一化规则：`src` 优先取简写键 `src`，再退 ECS `source`/`client`；`dst` 同理退 `destination`/`server`。
字符串形式的 `source` 只有 IP / host:port 形状才当作端点（否则丢失五元组），通道名只认入口注入的 `opts.source`。
真实流量包（标准 ECS）若缺 ECS 端点收口，导入事件的 src/dst 会全为 `null`，检索的 `q` IP 过滤随之失效（现网浏览器导入实测踩到）。

---

## 2. 四条入口

四条路径都经过 `IngestService`，**归一化与落库逻辑完全一致**，区别只在 `source` 与传输方式。

### 2.1 MQTT 设备接入

```bash
mosquitto_pub -h <broker> -t sime/v1/dev-plc-0001/event -m '{
  "@timestamp":"2026-10-20T10:00:00Z",
  "event":{"category":"ics-command","action":"write","outcome":"success"},
  "src":{"ip":"10.233.9.66"},
  "dst":{"ip":"10.233.9.2","asset":{"id":"dev-plc-0001"}}
}'
```

- 主进程订阅 `sime/v1/+/telemetry` 与 `sime/v1/+/event`；`SIME_WORKERS>1` 时按设备哈希分片，同设备必落同 worker。
- `clientId` 固定为 `SIME_MQTT_CLIENT_ID` 或 `sime-core-<hostname>`：随机 clientId 会在 broker 侧堆出幽灵会话，排障时无法判断谁是活的。
- 订阅结果会校验 `granted.qos`，被 ACL 拒绝（qos=128）时**打 error 日志**而不是静默无消息。

### 2.2 HTTP 直推

```bash
# 单条
curl -X POST http://host:13000/api/v1/ingest/events \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"event":{"@timestamp":"2026-10-20T10:00:00Z","event":{"category":"web","outcome":"failure"},
       "src":{"ip":"203.0.113.15"},"dst":{"ip":"10.2.85.119"}},"source":"collector-01"}'

# 批量（数组或 {events:[...]}）
curl -X POST 'http://host:13000/api/v1/ingest/events?source=collector-01' ...
```

可选参数（query 或 body 同名键）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `source` | `http` | 写入 `events.source` |
| `domain` | 推断 | 强制域（`it`/`ot`/`merged`） |
| `persist` | true | `false` = 不落库，只研判（在线试算规则） |
| `feed` | true | `false` = 只落库，不触发告警（历史补录） |

### 2.3 文件导入（流量包）

```bash
curl -X POST http://host:13000/api/v1/ingest/import \
  -H "Authorization: Bearer $T" \
  -F file=@security-events.jsonl \
  -F source=fw-lab \
  -F feed=true
```

也接受裸流（省掉 multipart 编码）：

```bash
curl -X POST http://host:13000/api/v1/ingest/import \
  -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/x-ndjson' \
  -H 'X-Sime-Filename: events.jsonl' \
  --data-binary @security-events.jsonl
```

支持的格式（自动识别，看首个非空白字符）：

| 输入 | 识别为 | 说明 |
|---|---|---|
| 以 `[` 开头 | `json-array` | 整包 JSON 数组 |
| 单行 `{...}` | `json` | 单个事件 |
| 多行 `{...}` | `jsonl` | 一行一个事件（demo/out/*.jsonl、SIME QL 导出产物） |
| 其它 | 400 | CSV 请先用 SIME QL 导出为 JSONL |

**adapter 模式**：每行是厂商原始日志时，用注册表里的适配器先转 ECS 再入库。

```bash
curl -X POST http://host:13000/api/v1/ingest/import \
  -H "Authorization: Bearer $T" \
  -F file=@fortigate.log -F adapter=fortigate-fw
```

`adapter` 模式产出的是打平的点号键（`event.category` / `src.ip`），导入层会展开成嵌套结构——
规则引擎按 `getPath` 取字段，打平的点号键它**看不见**，这一步不能省。
`source` 自动记为 `adapter:<id>`；`GET /api/v1/adapters` 现在会返回每个适配器的 `format` 与 `sample`，可先取样例自检。

### 2.4 抓包导入（pcap / pcapng）

现场给的通常是抓包，不是 JSONL。**二进制抓包以前会被"含 NUL 就拒"挡在门外**，现在自动识别魔数走独立解析链：

```bash
# 按流聚合（默认）：一个 pcap → 每五元组一条 flow 事件
curl -X POST 'http://host:13000/api/v1/ingest/import?mode=flow' \
  -H "Authorization: Bearer $T" -F file=@capture.pcap -F feed=true

# 逐包：每包一条事件（受 maxPackets=20000 约束，超出截断）
curl -X POST 'http://host:13000/api/v1/ingest/import?mode=packet' …
```

`mode` **只认查询参数**：抓包是边收边解析的，等不到 multipart 里的 form 字段（字段可能在文件之后才到）。

| 环节 | 支持范围 |
|---|---|
| 文件格式 | pcap（微秒/纳秒、大小端四种魔数）、pcapng（SHB / IDB / EPB / SPB，`if_tsresol` 精度） |
| 链路层 | Ethernet（含 VLAN/QinQ 多层标签）、RAW IP、Linux SLL / SLL2、NULL / LOOPBACK |
| 网络层 | IPv4（含 IHL、分片标记）、IPv6（跳过 HBH/路由/目的选项/AH/分片扩展头） |
| 传输层 | TCP / UDP 端口；ICMP / ICMPv6 / 其他协议只留协议与五元组 |

产出的事件（ECS，`event.category=network`）：

```json
{"@timestamp":"2026-06-11T01:56:00.000Z",
 "event":{"category":"network","action":"flow_end","start":"…","end":"…","duration":129000000000},
 "network":{"transport":"tcp","protocol":"tcp","packets":41575,"bytes":55789380},
 "source":{"ip":"10.1.180.153","port":443},"destination":{"ip":"10.2.85.100","port":51234},
 "message":"TCP 10.1.180.153:443 → 10.2.85.100:51234 · 41575 包 / 53.2 MB",
 "sime":{"pcap":{"file":"capture.pcap","mode":"flow","format":"pcap"}},"tags":["pcap","network-tcp"]}
```

- **默认按流聚合**：一个 pcap 动辄十万包，逐包入库既淹没有用信号又把 events 表打爆；`packets/bytes/first/last` 才是"流量"该有的粒度。需要逐包细节时用 `mode=packet`。
- **流表上限** 200k：超出的新流只计数（`pcap.overflowFlows`），老流继续累加，不会 OOM。
- **OT 自动分区**：命中 OT 端口（102/502/789/4840/2004/2404/9600/44818/47808 等）的事件标 `sime.domain=ot`，其余 `it`。只影响检索分区，不参与规则判定。
- **内存**：multipart 上传时看到前 4 字节是抓包魔数就转流式解析，**整包不进内存**，只与"未消费残余 + 流表"有关；因此抓包上限（`SIME_IMPORT_MAX_BYTES`，默认 512 MB）与文本上限（`SIME_IMPORT_MAX_TEXT_BYTES`，默认 128 MB）分开设闸。
- **返回值多一段 `pcap` 统计**：`packets / parsed / flows / truncated / fragments / unsupportedLink / overflowFlows / firstMs / lastMs`。截断（`caplen < origlen`）与 IP 分片是抓包常态，计数而不是报错。
- **解析不出事件直接 400**：全是 ARP/LLDP、或链路层不支持（802.11/PPI 未解密）时给出明确原因，提示 `editcap -T ether` 转换，而不是"导入成功 0 条"。

已知边界：不做 TCP 重组与 L7 协议识别（TLS/HTTP 字段解析不在这一层）、不解密隧道、不落 TCP flags/单包重传次数。

### 2.5 内置回放

`POST /api/v1/pipeline/simulate` 的 51 条确定性攻击场景同样走本管道，因此回放后事件列表与
SIME QL `events` 源都能查到这批数据（此前只产出内存告警）。

---

## 3. 检索

控制台的「事件检索」视图基于 §3.1–§3.3 三条端点 + §2.3 导入构建（时间范围 / 域 / 类别 / 来源 / 关键词过滤、分布柱状图、payload 弹层、浏览器直传导入）。

### 3.1 `GET /api/v1/events`

| 参数 | 默认 | 说明 |
|---|---|---|
| `from` / `to` | 最近 24h | ISO 时间或毫秒时间戳 |
| `domain` | — | `it`/`ot`/`merged`，非法值忽略 |
| `category` / `name` / `source` / `threat_id` | — | 精确匹配 |
| `asset_id` | — | 匹配 `src/dst` 下的 `asset_id` 或 `asset.id` |
| `q` | — | 关键词（name/category/source/src.ip/dst.ip 的 ILIKE） |
| `limit` / `offset` | 100 / 0 | limit 上限 1000 |
| `order` | desc | `asc`/`desc` |
| `count` | 否 | `count=1` 时附带 `total`（额外一次 count 查询） |

```json
{
  "rows": [{"id":"12","ts":"2026-10-20T10:00:00.000Z","domain":"it","category":"web",
            "name":null,"source":"import","src":{"ip":"203.0.113.15"},
            "dst":{"ip":"10.2.85.119"},"threat_id":null,"payload":{...}}],
  "limit": 100, "offset": 0,
  "window": {"from":"2026-10-19T10:00:00.000Z","to":"2026-10-20T10:00:00.000Z"},
  "ms": 3
}
```

**默认 24h 窗口是护栏不是限制**：events 是最大的表（保留 90 天），无时间条件的全表扫描在生产上是事故。
查更早的数据显式给 `from`。

### 3.2 `GET /api/v1/events/stats`

`interval` 可选 `1|5|15|30 minute`、`1|5|15|30 hour`、`1 day`（默认 `1 hour`）。
返回 `total` + `byCategory[]` + `byDomain[]` + `byBucket[]`，三次聚合并行执行。

### 3.3 `GET /api/v1/events/:id`

单条详情，含完整 `payload`（取证用）。非数字 id 与非存在 id 均返回 404。

### 3.4 SIME QL

```
events | where category = "authentication" and outcome = "failure" and ts > now() - 1h
       | stats count() as n by src_ip | sort n desc | limit 10
```

字段白名单见 [sime-ql.md](sime-ql.md) §3。`events` 源带 `large: true` 标记，数据源目录里会提示"务必带 ts 条件"。

---

## 4. 写入性能与背压

| 机制 | 取值 | 说明 |
|---|---|---|
| 批量刷盘 | 300ms 或 1000 条 | `SIME_EVENT_FLUSH_MS` / `SIME_EVENT_BATCH` |
| 单语句行数 | 500 | 避免 JSON 参数个数撞 PG 上限 |
| 队列上限 | 100,000 | 超限丢弃并计 `dropped`，绝不无限吃内存 |
| 坏行隔离 | — | 整块失败时逐行重插，只丢真正插不进去的行 |

`GET /api/v1/ingest/stats` 可看 `received / inserted / failed / dropped / queued`。
**`dropped` 持续增长 = PG 写不动**（磁盘满、连接数耗尽、锁等待），不是"事件没来"。

导入路径额外有两条闸门：

| 变量 | 默认 | 超限行为 |
|---|---|---|
| `SIME_IMPORT_MAX_BYTES` | 64MB | 413（multipart 用 busboy 硬截断） |
| `SIME_IMPORT_MAX_EVENTS` | 50,000 | 超出部分计入 `skipped`，`truncated=true` |
| `SIME_IMPORT_DEADLINE_MS` | 60,000 | 超时停止处理，返回已处理部分 |

导入是**同步**接口（返回即已落库）：5 万条场景实测 3~8 秒。更大的历史补录请拆包，
或直接调 `POST /ingest/events` 分批推——单进程里跑 100 万条的 HTTP 请求会把端口占死。

**导入必须先排序再研判**：规则引擎的滑动窗口按 ts 前推，时间回退会把已聚合的桶剪掉，
乱序历史日志会系统性少报。导入路径在内存中按 ts 升序重排（这也是 5 万条上限的由来）。

**历史数据 + 开研判 = 时间水位回退**：即使批内有序，如果整批数据都比"当下"早很多
（默认阈值 1 小时），喂给引擎仍会把水位拉回过去、清空实时规则的滑窗。平台不会擅自关掉
`feed`（有人确实要"按历史重算一遍"），而是在响应里给 `warning` 说明代价：

```json
{"accepted": 55, "alerts": 0,
 "warning": "导入数据最新一条比当前时间早 928 分钟：研判会把规则引擎的时间水位回退，实时规则的滑窗会被清空。历史补录建议用 feed=false（只入库不研判）。"}
```

补录历史请显式带 `-F feed=false`。

---

## 5. 错误语义

导入是**部分成功**语义：坏行不会中断整批。

```json
{
  "file": "mixed.jsonl", "bytes": 120, "format": "jsonl",
  "events": 2, "accepted": 1, "rejected": 1, "skipped": 0, "truncated": false,
  "alerts": 0, "ms": 4,
  "errors": [{"line": 2, "reason": "JSON 解析失败: Unexpected token"}],
  "source": "import", "stored": true, "fed": true
}
```

`errors` 最多 20 条（避免一个全坏的文件刷满响应）。整包失败只有这几种：

| 状态码 | 原因 |
|---|---|
| 400 | 空文件 / 无法识别的内容（如 CSV）/ 未知适配器 / 缺少 `file` 字段 / 落库未启用 |
| 413 | 超过 `SIME_IMPORT_MAX_BYTES` |

---

## 6. 生命周期

- **保留**：`events` 默认 90 天，由保留策略定时清理（`SIME_RETENTION_EVENTS_DAYS` 可覆盖，`0` 表示不清）。
  详见 [operations.md](operations.md) §2。
- **导出**：`GET /api/v1/export?q=events | where ts > now() - 1d&format=csv`，
  导出产物可原样再导入（JSONL 格式闭环）。限制见 [operations.md](operations.md) §3。
- **备份**：`events` 属于大表，随 PG 整体备份；单独导历史用 export 而不是 `pg_dump` 整库。

---

## 7. 边界与已知限制

1. **CSV 不直接支持**：字段类型与嵌套结构无法无损映射。CSV → SIME QL 导入无关，先用 export 转 JSONL。
2. **导入不跨分片**：`SIME_WORKERS>1` 时导入在接收进程内联处理（落库正确，但历史回放与实时流的窗口是两套状态）。
   实时流走 MQTT 有哈希分片，历史补录不与其实时窗口合并——这是有意的：历史数据不该触发"当前正在被攻击"的告警风暴。
3. **`q` 关键词不吃索引**：靠 `ts` 索引缩小范围后再 ILIKE，务必带时间范围。
4. **payload 全量存储**：单条事件建议 < 16KB。超大可先裁剪再入库（保留 `src/dst/event` 即可满足 95% 的查询）。
5. **不落库模式**：`SIME_PG_HOST` 未设置时平台退化为内存态，`add()` 直接计 `dropped`，`/events` 返回 500（明确报错而非空列表）。

---

## 8. 排障

| 现象 | 先查 | 常见原因 |
|---|---|---|
| `/events` 恒为空 | `GET /ingest/stats` 的 `received` | 入口没数据；`persist` 被置 false |
| `received` 涨但 `inserted` 不涨 | 同上，看 `failed`/`dropped` | PG 连接/磁盘；payload 含不可序列化值 |
| MQTT 事件完全不进来 | `docker exec sime-emqx-1 emqx ctl subscriptions list` | 订阅丢失；ACL 拒绝（日志有 `subscribe denied`） |
| 导入 accepted 少 | 响应的 `errors[]` 行号 | 时间戳超范围（> 未来 1 年）；该行不是 JSON 对象 |
| 导入后没有告警 | `feed` 参数、`alerts` 字段 | 规则窗口/冷却；历史数据 ts 太旧本就不该触发 |
| 查询慢 | `ms` 字段；`EXPLAIN` | 没带 `from`；`q` 全文匹配大范围 |

```bash
# 一分钟内的入库速率
docker exec sime-postgres-1 psql -U sime -d sime -c \
  "select date_trunc('minute',ts) m, count(*) from events group by 1 order by 1 desc limit 5;"
```
