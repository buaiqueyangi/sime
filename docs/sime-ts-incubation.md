# SIME-TS 孵化设计（M3 存储内核 · 蓝图 §6.3）

> 状态：**孵化期**（设计契约 + 路由骨架）。Rust 内核（Arrow/DataFusion 基座）按蓝图
> 12 个月节奏推进；孵化不达 benchmark 目标即回退双底座方案（止损线见蓝图 §10）。

## 目标

单一存储内核同时补齐两处短板：
- ClickHouse 类列存：全文检索弱；
- OpenSearch 类索引：高基数聚合贵。
SIME-TS = 列存 + 倒排一库两能，替代"OpenSearch 管检索 + IoTDB 管时序"的双底座。

## 孵化路线

| 阶段 | 交付 | 验收 |
|---|---|---|
| 契约期（当前） | 存储访问层 profile 契约 + SIME QL AST 路由骨架 | 上层应用零改动切换 |
| 原型期 | Rust crate（napi-rs 绑定）：Arrow RecordBatch 读 + DataFusion 扫描 + 倒排原型 | sime-bench 子集对比 OpenSearch |
| 并行期 | SIME QL → Planner → 双后端灰度 | 10 亿事件查询 P99 不劣于基线 |
| 成熟期 | 默认 profile 切换 sime-ts | 公开 benchmark 报告 |

## profile 契约（storage 访问层，全部后端必须实现）

```
写入：ingest(events: EventBatch) — 批量、可缓冲、失败回灌
检索：query(plan: QueryPlan) — 计划由 SIME QL 编译器产出（与后端无关）
维护：ensureSchema / snapshot / prune(retention)
```

现状：pg / opensearch / iotdb / sime-ts 四个 profile 槽位，业务层只依赖契约。
**架构不变式：任何底座（包括 sime-ts 自己）都必须可以被替换。**

## 技术选型依据

- Apache Arrow：列存内存格式事实标准，零拷贝跨语言；
- DataFusion：Rust 查询引擎框架（SQL规划/执行可复用），自研只做存储与索引层；
- 倒排索引：自研 FST/分词（全文检索短板补齐的关键，ClickHouse 类列存缺失的能力）；
- napi-rs：Node ↔ Rust 绑定（平台是 Node 单体，绑定为 native profile）。
