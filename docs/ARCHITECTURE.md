# SIME 架构说明（贡献者指南）

> 面向贡献者的架构与机制文档。业务方案与里程碑见仓库外蓝图，本文只讲"代码怎么组织的、为什么这么组织"。

## 1. 进程模型（M3 多核分片）

```
主进程（master.ts → bootstrapMaster）
  ├─ NestJS HTTP：控制台 /ui、Swagger /docs、REST /api/v1（认证守卫）
  ├─ MQTT 接入（MqttIngest）：单一 EMQX 消费者
  │    解析 → 哈希分发：hash(key) % N → worker（同设备必落同分片）
  ├─ WebSocket 服务（/ws?token=）：告警/遥测/状态广播
  └─ worker 统计聚合（10s 上报 → /health cluster 视图）

worker × N（worker.ts → WorkerMain，手工组装服务图，无 HTTP）
  ├─ 规则引擎窗口状态（每分片独立 → 聚合正确性由"同设备同分片"保证）
  ├─ 遥测缓冲批量写入（300ms 刷盘，多行 upsert）
  ├─ SOAR 剧本执行 + PG 持久化
  └─ 告警/统计 → process.send → 主进程
```

`SIME_WORKERS=1`（默认）：全部内联单进程，行为与单机版一致，零分片开销。

## 2. 数据流

```
设备/适配器 → MQTT(sime/v1/{device}/{telemetry|event})
  → MqttIngest 解析（ECS 基线）→ 哈希分发
    → worker：遥测记录（量程越限 + UEBA 3σ 检查 → 引擎）
             事件（规则引擎增量聚合 → 告警）
    → 告警：PG 持久化 → 处置执行器（工单/通知/审计）→ 剧本触发 → WS 广播
    → 遥测：PG 批量落库 + WS 批播
  → 冷数据：PG 24h → DuckDB → Parquet（数据湖视图，受限只读 SQL）
```

## 3. 关键机制（为什么快/为什么对）

| 机制 | 位置 | 复杂度 |
|---|---|---|
| 增量滑窗聚合（1s 桶 + 总量回减） | rule-engine/rule-engine.ts | 求值 O(1) |
| 引用计数增量去重 | 同上 | O(1) |
| 序列状态机 | 同上 | O(1) |
| AST 类别预过滤（合取链推导，保证不漏报） | 同上 | 无关事件跳过 |
| 点路径分词缓存 | condition-evaluator.ts | 零分配 |
| 适配器 compile-once | adapter-engine/adapter-engine.ts | 事件路径零编译 |
| 告警 PG 缓冲回灌（启动竞态） | rule-engine.service.ts | 不丢告警 |
| 遥测批量刷盘 + 失败回灌 | telemetry.service.ts | 50k 洪峰 45s 消化 |
| 规则降级编译（坏规则跳过不崩平台） | rule-engine.service.ts | 平台存活 |

## 4. 扩展点（声明式资产，YAML + JSON Schema）

| 资产 | 触发方式 |
|---|---|
| 检测规则 `rules/` | 六要素模板：条件 DSL（自研编译器，禁 eval）+ ATT&CK 映射 + 处置动作 + 研判说明 |
| 日志源适配器 `adapters/` | 三层：parse（regex/json/kv）→ mapping（ECS）→ threat_map（威胁归一）；样例驱动回归 |
| SOAR 剧本 `templates/playbooks/` | trigger.rules 匹配新告警 → steps 处置动作（复用响应执行器） |
| 物模型 `templates/thing-model/` | 量程/冷热策略/安全属性声明，驱动越限检测与存储策略 |

提交 PR = 贡献资产；CI 强制 Schema 校验、适配器样例回归、冒烟与性能地板（5k EPS）。

## 5. 部署形态

| 形态 | 入口 | 场景 |
|---|---|---|
| L1 | docker compose up | 评估/小企业 |
| L3 | compose 生产栈 + `deploy/helm/sime` | 中型企业/K8s |
| L4 | 离线一体机 ISO（信创架构） | 政企渠道 |

Linux 调优清单：`deploy/linux-tuning.md`。性能口径：`docs/performance.md`（sime-bench 可复现）。

## 6. 代码地图

```
core/src/
├── main.ts / master.ts / worker.ts   # 进程模型（见 §1）
├── rule-engine/                      # 条件编译器 + 求值器 + 引擎内核（自研核心）
├── adapter-engine/                   # 适配器执行引擎（compile-once）
├── ingest/mqtt-ingest.service.ts     # MQTT 接入 + 哈希分发
├── telemetry/                        # 遥测双档存储 + 越限/UEBA 检查
├── response/                         # 处置执行器（工单/通知/审计）
├── soar/playbook.service.ts          # 剧本引擎
├── lake/                             # DuckDB 湖仓
├── auth/ common/pg-profile.service.ts# 认证 / 可插拔存储
├── modules/                          # REST 控制器（Swagger 契约）
└── scripts/                          # e2e / bench / validate / replay / device-sim
```
