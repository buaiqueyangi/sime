# SIME Agent 家族：多类型 Agent 统一接入架构

> 定位：**一套接入协议，六类 Agent，零协议增量**。所有 Agent 共用同一注册/认证/上报/命令通道
> （复用平台已实现的 MQTT 主题规范 + 统一摄入管道），差异只在采集面。主机 Agent 详见
> [host-agent-design.md](host-agent-design.md)，本文覆盖全家族。

## 1. 统一接入契约（所有 Agent 类型共用）

```
注册      首次上报自动注册（无需预建台账）；一机一密（P2 起强制）
上行-事件  MQTT QoS1 → sime/v1/{deviceId}/event        ECS 基线 JSON
上行-心跳  MQTT QoS1 → sime/v1/{deviceId}/telemetry    携带 agent 元数据：
          { "agent": { "type": "host", "version": "0.1.0", "capabilities": ["fim","auditd"] },
            "points": { "agent_queue": 0, "agent_cpu": 0.3 }, "ts": "..." }
下行-命令  订阅 sime/v1/{deviceId}/cmd → 执行 → cmd/reply 回执（P2）
批量导入  HTTP POST /ingest/import（文件/pcap，离线数据回灌）
对齐保证  事件字段对齐现有适配器映射形态 → 规则库零改动直接消费
```

**心跳即注册**：agent 元数据（type/version/capabilities）随遥测上报，平台 devices 表
记录 agent_type/agent_version，`GET /api/v1/agents` 输出全量 Agent 台账（在线 = 120s 内有心跳）。

## 2. 六类 Agent 矩阵

| 类型 | 代号 | 形态 | 采集面 | 消费的规则族（现有） |
|---|---|---|---|---|
| **主机防护** | `host` | Go 单二进制（~10MB, linux/win/arm64） | auditd/WinEvt/Sysmon、基线（端口/用户/cron/SUID）、FIM | host-security 49 + windows 28 |
| **边缘 OT 网关** | `edge` | Fluent Bit 大改（蓝图 §4.2 原定位） | Modbus/OPC-UA/BACnet/IEC-104 链路审计、断点续传、**边缘本地联动**（PLC 急停类动作下沉） | ot 21 |
| **日志转发** | `log` | Fluent Bit / rsyslog 模板化交付 | syslog(5424)/文件 tail，多厂商格式原样上送 | 由 30 个适配器在平台侧解析 |
| **网络探针** | `net` | Zeek 系 / eBPF 轻量探针 | 流元数据（五元组/字节数/时长）、DNS 查询、PCAP 切片 | network-security 7 + edge-security 5 |
| **云原生采集** | `cloud` | K8s DaemonSet | API audit 日志、Docker events、kubelet 指标 | container 10 |
| **合规扫描** | `scan` | 周期任务型（非常驻） | 资产测绘（nmap 式）、弱口令核查、基线核查项打分 | compliance 13 |

另有**第七类：无 Agent 被动接入**——第三方安全设备（天擎/青藤/火绒/深信服/WAF/防火墙）
syslog 直推，平台适配器解析。这类不需要部署任何东西，在台账中标记 `type: external`。

## 3. 平台侧台账模型

`devices` 表扩展（07-agent.sql）：

```
agent_type     text      -- host/edge/log/net/cloud/scan/external/sim
agent_version  text      -- Agent 自报版本（自升级管理依据）
capabilities   jsonb     -- ["fim","auditd","cmd-exec",...]
```

- 在线判定：`last_seen_at` 120s 内有心跳（遥测视图/组态瓦片直接复用）
- Agent 失联 → 心跳消失 → `rule.cp.log-source-offline` 自动告警（规则已在库）
- 清单 API：`GET /api/v1/agents` → 按类型分组统计 + 明细（控制台「Agent 管理」视图）

## 4. 响应能力分级（cmd 通道，P2）

| Agent 类型 | 可执行动作 | 说明 |
|---|---|---|
| host | isolate.host / account.lock / process.kill / file.quarantine | 规则动作模拟→真实执行的落点 |
| edge | plc.deny / plc.halt | **边缘本地执行**（云端下发、网关就地阻断，工控场景不能等云端回环） |
| net | firewall.block（联动边界）| 探针只上报，封禁走联动接口 |
| cloud | 驱逐 Pod / 吊销 SA Token | 通过 K8s API 执行 |
| log/scan/external | 无执行能力（纯上报） | capabilities 里不含 cmd-exec，平台不会向其下发 |

## 5. 接入优先级（实施顺序）

1. **host**（先行）：无终端产品的客户最刚需，77 条规则待真实数据激活
2. **log**（零开发）：Fluent Bit/rsyslog 配置模板即交付，走通用适配器
3. **net**：pcap 导入管道已就绪（`POST /ingest/import`），探针是它的实时化
4. **edge**：OT 客户专属，依赖工控协议插件开发（蓝图既定方向）
5. **cloud**：K8s audit 适配器已就绪，DaemonSet 化是打包工作
6. **scan**：合规报告自动化，价值高但独立性强，可后置

## 6. 与主机 Agent 设计的关系

[host-agent-design.md](host-agent-design.md) 是本家族 `host` 类型的详细设计（采集面/安全设计/P1-P3）。
本文的统一契约（心跳元数据/台账/在线判定）是它的接入层，两者配合阅读。
