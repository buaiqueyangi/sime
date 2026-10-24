# SIME 主机防护 Agent 设计方案

> 状态：设计定稿（Phase 1 待启动）。核心原则：**瘦 Agent、胖平台**——检测与规则全部在平台侧，Agent 只做"采集"与"执行"，与 SIME 现有架构（规则引擎/物模型/告警闭环）零耦合拼接。

## 0. 定位与边界（先说清楚不做什么）

| 层次 | 是否做 | 理由 |
|---|---|---|
| **日志转发**（auditd/WinEvt → SIME） | ✅ Phase 1 | 无终端产品的客户也能接入；已有 30 适配器 + 统一摄入管道 |
| **基线采集**（端口/用户/cron/SUID/FIM） | ✅ Phase 1~2 | 等保合规检测的数据源；规则库 compliance 族 13 条正等这些数据 |
| **响应执行**（隔离/杀进程/删文件） | ✅ Phase 2 | 规则动作 isolate.host 等目前是 simulated，需要执行端 |
| **主动阻断 / 反病毒 / 内核态拦截** | ❌ 不做 | EDR 是另一个产品品类：AV 引擎、内核驱动、误杀责任——小团队不可承受；SIME 的差异化在"平台侧检测+闭环"，不在端点对抗 |

**为什么不做 EDR**：Wazuh 也只做检测不做阻断；商业 EDR（火绒/天擎/深信服）在端点对抗上已足够好——**SIME 的适配器已经能接它们仨的告警**。客户有 EDR → 走适配器；没有 → SIME Agent 补位采集。两条路都通向同一个规则引擎。

## 1. 现状盘点（Agent 未动工前已具备的）

- **消费端就绪**：`POST /ingest/events` 与 MQTT `sime/v1/{deviceId}/event` 两条入口共用统一归一化管道（event-normalizer，ECS 白名单）→ events 表 + 规则引擎
- **规则就绪**：host-security 族 49 条 + windows-security 族 28 条已按 ECS 事件形态编写（引用 `event.security.hids`、`adapter.generic.linux-auth`、Sysmon 事件码等）——Agent 的输出只要对齐这些字段，**规则零改动直接生效**
- **命令通道就绪**：MQTT 主题规范已定义 `sime/v1/{deviceId}/cmd/reply`（蓝图 §5.6），响应执行器（ResponseService）的 20+ 种动作枚举已落库
- **台账就绪**：设备首次上报自动注册（MqttIngest → registerDevice），组态/遥测视图直接可见

**结论：Agent 是"纯增量"，平台侧不需要为它改任何代码。**

## 2. 技术选型（对照自研度决策矩阵）

| 候选 | 评估 | 结论 |
|---|---|---|
| Wazuh Agent | 协议绑定 Wazuh Manager，替换管理端 = 深度协议逆向 | ❌ |
| osquery | 优秀但重（~50MB、C++、SQL 调度模型），二开门槛高 | 备选（企业版可作高级采集器） |
| Fluent Bit（蓝图原定的采集 Agent） | 日志转发强，但无 FIM/基线/执行能力，安全场景不够 | 用于**日志通路**（它擅长的），不承担安全 Agent |
| **Go 单二进制自研（sime-agent）** | 交叉编译 linux/amd64+arm64+windows、零依赖部署、MQTT 客户端与 auditd/winevt 读取生态齐全 | ✅ Phase 1 采用 |

与蓝图的关系修正：蓝图 §4.2 将 Fluent Bit 定为"采集 Agent（OT 协议插件方向）"——该定位保留给**边缘 OT 网关**；主机安全 Agent 按本方案独立自研（安全采集需要 FIM/基线/执行，Fluent Bit 覆盖不了）。

## 3. Agent 架构（Phase 1 蓝图）

```
┌────────────────────── sime-agent（Go 静态二进制，~10MB） ──────────────────────┐
│                                                                                │
│  采集面（各平台原生 API，无驱动）                                                  │
│  ├─ Linux: auditd(af_unix) / auth.log tail / systemd journal                   │
│  │         定时基线: listening ports / users&groups / cron&systemd units /      │
│  │                SUID 文件扫描 / authorized_keys / /etc/hosts 哈希              │
│  ├─ Windows: WinEvt API(4624/4625/4688/7045/1102…) / Sysmon(若已装则优先)       │
│  │         定时基线: 服务列表 / 计划任务 / Run&RunOnce / 本地用户                  │
│  │                                                                                │
│  本地处理（轻量，不做检测）                                                        │
│  ├─ ECS 归一：本地输出与平台 event-normalizer 同一形态（共用 JSON Schema）          │
│  ├─ 断点续传：本地队列（BoltDB/文件环形缓冲），网络断开不丢事件                      │
│  └─ 资源约束：CPU<1% 内存<50MB，采集速率自适应                                      │
│                                                                                │
│  通信面（复用平台现有通道，零新协议）                                               │
│  ├─ 上行: MQTT QoS1 → sime/v1/{deviceId}/event（一机一密，TLS）                  │
│  ├─ 心跳: sime/v1/{deviceId}/telemetry（agent 版本/队列深度/基线哈希）             │
│  └─ 下行: 订阅 sime/v1/{deviceId}/cmd（Phase 2 响应执行）→ cmd/reply 回执         │
└────────────────────────────────────────────────────────────────────────────────┘
        │                                    ▲
        ▼                                    │
  [平台侧零改动] 统一摄入管道 → events 表 → 规则引擎(49+28 条主机规则直接生效)
                                         → 告警闭环 → SOAR → cmd 下发（P2）
```

**关键设计：字段对齐优先。** Agent 输出严格对齐现有规则引用的字段（`event.category/outcome`、`process.command_line`、`file.path`、`user.name`、`src.asset_id`…）——即 Linux 侧对齐 `adapter.generic.linux-auth` 的映射形态，Windows 侧对齐 Sysmon 适配器的事件码映射。**对齐即兼容：77 条主机/Windows 规则开箱命中。**

## 4. 分期计划

| 阶段 | 周期 | 交付 | 验收 |
|---|---|---|---|
| **P1 采集** | 2~4 周 | Linux 采集全量 + WinEvt 采集 + MQTT 上报 + 断点续传 + systemd 服务/Windows 服务安装器 | 部署 3 台测试机；暴力破解/SSH 公钥写入/cron 变更等 ≥10 条规则真实触发并告警 |
| **P2 执行** | +2 周 | cmd 通道执行器：isolate.host（iptables/nft 出入站封锁）、account.lock、process.kill、file.quarantine（隔离区+哈希留存）；全部动作回执落 response_audit | SOAR 剧本从 simulated → executed；响应动作在测试机真实生效 |
| **P3 加固** | +2 周 | 基线漂移对比（每日快照 diff → 专属规则）、Agent 自升级、防篡改（watchdog）、信创 OS 适配（麒麟/统信 arm64） | 等保合规族 13 条规则数据源全部就位 |
| 企业版（远期） | — | osquery 高级查询接入、EDR 联动（已有适配器）、主机资产指纹 | — |

## 5. 安全设计（Agent 本身不能成为攻击面）

1. **一机一密**：注册时平台签发 deviceId+secret（注册接口复用设备自动登记，首连激活）；
2. **通道**：MQTT over TLS（EMQX 原生支持 8883），证书 pinning；
3. **最小权限**：Linux 读 auditd 只需 audit 组；Windows 用事件日志读取权限而非 SYSTEM（仅响应执行需提权，P2 单独评估）；
4. **命令鉴权**：cmd 消息平台侧 HMAC 签名，Agent 验签执行，防伪造指令；
5. **自身完整性**：二进制签名 + 升级包校验（Agent 被杀/被停 → 心跳消失 → 平台侧 `log-source-offline` 规则正好兜底告警，规则库已有）。

## 6. 与现有平台的对齐点（ checklist）

- [x] 上报通道：`POST /ingest/events` / MQTT `sime/v1/+/event`（已实现）
- [x] 自动注册：MqttIngest registerDevice（已实现）
- [x] 规则消费：host-security 49 条 + windows 28 条（已实现，待真实数据验证）
- [x] Agent 离线检测：`rule.cp.log-source-offline`（已实现）
- [x] 响应动作枚举与审计表：ResponseService + response_audit（已实现，simulated）
- [ ] cmd 下发通道：MQTT 发布端（P2，平台侧约半天工作量）
- [ ] Agent 注册/密钥签发接口（P1）
- [ ] 心跳消费 → 设备在线状态（遥测视图已有 lastSeen，补 agent 维度即可）

## 7. 竞品参照（定位校准）

| 产品 | Agent 形态 | SIME 差异 |
|---|---|---|
| Wazuh | 全功能 HIDS Agent（含本地规则引擎） | SIME 把检测留在平台：规则 YAML 统一管理、与网络/OT/工控告警同引擎关联——跨域关联是 Wazuh 做不到的 |
| osquery | 查询型采集 | SIME Agent 事件驱动为主、查询为辅，实时性更好 |
| 商业 EDR | 端点对抗 | 不竞争；通过适配器消费其告警，SIME 做跨源关联与闭环 |
