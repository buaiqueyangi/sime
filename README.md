# SIME — Open Source Smart Integrated Management Environment

**SIME（智慧集成管理平台）**：开源的"物联运维 + 安全运营"一体化平台。任何企业一条命令拉起，
从几百个测点到百亿级事件用同一套架构。

- 采集监控（Modbus / OPC-UA / MQTT / syslog / 日志）
- 实时告警 + 六要素规则库（MITRE ATT&CK 全映射）
- 日志源适配库（厂商 syslog 开箱可解析，声明式 YAML）
- 设备资产 / 工单 / 能耗分析 / 组态大屏
- SOC 安全运营（态势感知 / 溯源 / SOAR 剧本 / UEBA / LLM 研判）

## 快速开始

```bash
docker compose up -d        # L1 形态：postgres + core
# 打开 http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/health
```

无 Docker 时可本地运行 core：

```bash
cd core && npm install && npm run build && npm start
```

## 开箱验收标准（M0/M0.5）

- [x] 一条命令拉起平台（compose）
- [x] `GET /api/v1/health` 返回规则库 / 适配库 / 物模型加载统计 + 规则引擎状态
- [x] 规则库、适配库、物模型全部声明式 YAML + JSON Schema 校验（CI 强制）
- [x] 适配器样例驱动回归：每个适配器必须解析自己的 sample（CI 强制）
- [x] **规则引擎内核 v0**：条件 DSL 编译器 + 滑动窗口聚合 + 序列检测 + 冷却去重，回放打出告警
- [x] demo 数据生成器：模拟园区 500 测点 + 5 类攻击场景回放 → 55 条事件命中 6 条规则

## 仓库结构

| 目录 | 说明 |
|---|---|
| `core/` | 平台服务（NestJS 模块化单体）：物模型 / 规则引擎内核 / 告警 / 适配库执行引擎 / IAM |
| `storage/` | 存储访问层（pg profile 起步，可插拔 opensearch / iotdb / sime-ts） |
| `agent/` | 采集 Agent（Fluent Bit 大改：OT 协议插件，M1） |
| `algo/` | Python 算法服务（UEBA / 预测 / LLM Agent，M2） |
| `rules/` | 开源检测规则库（六要素 YAML，目标 3000+） |
| `adapters/` | 日志源适配库（解析 → 字段映射 → 威胁归一，目标 100+） |
| `templates/` | 物模型 / 组态 / 大屏 / 剧本模板 |
| `demo/` | demo 数据生成器 |
| `deploy/` | 部署物（compose / Helm / 一体机脚本） |

## License

Apache-2.0。社区版核心全功能；企业版（SSO / 多租户 / HA / 等保增强 / 信创）另行授权。
安全修复永不留在企业版。详见 `docs/`。

## 文档

- [快速上手](docs/getting-started.md)
- [总体设计与实施蓝图](../SIME开源平台总体设计与实施蓝图.md)（内部文档，含组件自研度决策矩阵与里程碑）
