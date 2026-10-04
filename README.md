# SIME — Open Source Smart Integrated Management Environment

**SIME（智慧集成管理平台）**：开源的"物联运维 + 安全运营"一体化平台。任何企业一条命令拉起，
从几百个测点到百亿级事件用同一套架构。Apache-2.0，社区版核心全功能。

[![ci](https://github.com/buaiqueyangi/sime/actions/workflows/ci.yml/badge.svg)](https://github.com/buaiqueyangi/sime/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## 能力全景（v0.1.0 已实现）

| 域 | 能力 |
|---|---|
| **接入** | MQTT（EMQX）设备接入与自动台账注册；日志源适配库 **30 个**厂商/通用模板（解析→ECS 字段映射→威胁归一，声明式 YAML + 样例回归）；南向物模型契约 |
| **检测** | 自研规则引擎内核 v2：条件 DSL 编译器 + 增量滑窗聚合 + 序列状态机 + 类别预过滤（单进程实测 **192k~224k EPS**）；规则库 **148 条**（十一大族含容器/等保/UEBA，全量 MITRE ATT&CK 映射） |
| **告警** | 生命周期闭环（open→ack→resolved）、WebSocket 毫秒级推送、24h 趋势、冷却去重 |
| **响应** | 处置执行器（工单/通知/响应审计落库）+ SOAR 剧本引擎 v0（20 个剧本，YAML 声明） |
| **遥测** | 缓冲批量写入（50k 洪峰 45s 全量消化）、实时曲线（ECharts）、物模型量程越限 + UEBA 3σ 统计异常双检测 |
| **组态** | 拖拽编辑器 v1 + 运行时（布局持久化、实时值绑定、点击下钻曲线） |
| **湖仓** | 内嵌 DuckDB：PG 最近 24h → Parquet(zstd) 快照 + 受限只读 SQL 分析（免 Spark 集群） |
| **平台** | 登录鉴权（HMAC token）、RBAC 基座、审计、Swagger 契约、控制台 v2（8 视图 NOC 风格） |

性能口径与机制说明见 [docs/performance.md](docs/performance.md)。

## 快速开始

```bash
# 一条命令（Docker）：core + PostgreSQL + EMQX
bash deploy/install.sh
# 打开控制台（默认账号 admin / sime123456，用 SIME_ADMIN_PASSWORD 修改）
#   http://<主机IP>:3000/ui
```

无 Docker 本地运行：

```bash
cd core && npm install && npm run build && npm start
```

演示数据：`python3 demo/generate.py` 生成模拟园区 + 攻击场景，`npm run replay` 回放打出告警；
或 `docker compose --profile sim up -d` 启动常驻设备模拟器（页面即有活数据）。

## 控制台导览（/ui）

概览（状态卡 + 告警趋势）│ 实时告警（级别筛选 + 确认/解决闭环）│ 设备遥测（实时曲线）│
组态总览（拖拽编辑布局）│ 检测规则库 │ 适配与物模型 │ 处置闭环（SOAR 剧本 + 工单/通知/审计）│ 数据湖（快照 + SQL）

## MQTT 接入规范

```
sime/v1/{deviceId}/telemetry   payload: {"asset_id":"...","points":{"active_power":1.2},"ts":"..."}
sime/v1/{deviceId}/event       payload: ECS 基线事件（进规则引擎）
```

设备首次上报自动登记台账；建议生产环境 QoS1（QoS0 在订阅端背压时会丢失）。

## 贡献与扩展点

所有检测规则（`rules/`）、日志源适配器（`adapters/`）、物模型/组态/剧本模板（`templates/`）
都是声明式 YAML + JSON Schema：提交 PR 即完成贡献，CI 强制 Schema 校验、适配器样例回归、
性能地板（5k EPS）与冒烟测试。

## 仓库结构

| 目录 | 说明 |
|---|---|
| `core/` | 平台服务（NestJS）：规则引擎内核 / 接入 / 遥测 / 告警闭环 / SOAR / 湖仓 / IAM / 控制台 |
| `rules/` `adapters/` `templates/` | 声明式资产（规则 148 / 适配 30 / 物模型与剧本模板） |
| `storage/` | PG DDL（幂等分层） |
| `demo/` | 模拟园区数据生成器 |
| `deploy/` | install.sh / systemd / Helm Chart / Linux 调优 |
| `docs/` | 快速上手 / 性能白皮书 |

## Roadmap

- [x] M0 基建：monorepo / CI / compose / 声明式资产 / 控制台
- [x] M1 主体：MQTT 接入 / 规则引擎 v2 / 遥测管道 / 告警闭环 / 接入压测（QoS0 丢失问题实测并修复）
- [x] M2 主体：SOAR 剧本引擎 + 20 剧本 / 组态编辑器 v1 / Helm / WebSocket / 登录鉴权
- [x] M3 首批：湖仓（DuckDB+Parquet）/ UEBA 统计基线 / 控制台 v2
- [ ] 规则库 300+ / 适配库 30+（内容持续扩充）
- [ ] SIME-TS 统一存储内核（Arrow/DataFusion 孵化）
- [ ] 多核分片（worker_threads）/ LLM 运维助手 / 组态编辑器增强

## License

Apache-2.0。社区版核心全功能；企业版（SSO / 多租户 / HA / 等保增强 / 信创）另行授权。
**安全修复永不留在企业版，社区版无残废模式。**
