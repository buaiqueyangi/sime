# Linux 生产调优清单（SIME）

> 目标：同配置下吞吐与延迟优于市面同类设备/一体机。每项都对应一个可验证的机制，不做玄学调优。
> 适用：L1/L3 Docker 形态与裸机 systemd 形态。改动后用 `npm run bench` 与 `sime-bench` 报告留档。

## 1. 内核参数（/etc/sysctl.d/99-sime.conf）

```conf
# 连接队列：告警推送与设备并发接入的背板
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
# 端口 range：大量南向/北向短连接
net.ipv4.ip_local_port_range = 1024 65535
# 时序/日志负载以顺序 IO 为主，换页无收益
vm.swappiness = 1
# 文件句柄：日志文件、连接、Kafka 客户端
fs.file-max = 2097152
net.ipv4.tcp_slow_start_after_idle = 0
```

生效：`sysctl --system`。验证：`cat /proc/sys/net/core/somaxconn`。

## 2. 服务级资源上限

- systemd 形态：单元内已置 `LimitNOFILE=65535`（见 deploy/systemd/sime-core.service）；
- Docker 形态：compose 服务下加 `ulimits: { nofile: { soft: 65535, hard: 65535 } }`；
- 验证：`cat /proc/$(pgrep -f 'node dist/main')/limits | grep open`。

## 3. Node 运行时

| 参数 | 建议值 | 机制说明 |
|---|---|---|
| `--max-old-space-size` | 8C16G 档 8192 | 引擎状态（桶/引用计数表）驻留堆内，避免频繁 Full GC |
| `NODE_ENV=production` | 必设 | 关闭开发分支与调试信息 |
| 优雅退出 | 已内置 enableShutdownHooks | SIGTERM 停止收流 → 刷缓冲 → 关连接，滚动重启零丢事件 |
| 容器 init | compose `init: true` | PID 1 信号转发，防僵尸进程 |

## 4. PostgreSQL（storage/pg profile）

```
shared_buffers = 4GB          # 16G 内存档
effective_cache_size = 10GB
wal_compression = on
synchronous_commit = on       # 告警/工单不丢；遥测不落 PG（走时序库）
```

遥测大数据量永远不进 PG——走 IoTDB/时序 profile（§6.1 部署梯度），这是"同配置更强"的结构性原因之一。

## 5. 时间同步（SIEM 硬要求）

`chrony` 指向内网 NTP；NTP 漂移会导致窗口聚合与告警时序错乱。验证：`chronyc tracking`。

## 6. 磁盘

- 热存储（检索层）与冷存储（对象存储）分盘；
- 数据盘 `noatime` 挂载；
- 文件系统 xfs/ext4 均可，检索层预留 30% 空间（压缩与 merge 需要）。

## 7. 验证闭环

```bash
cd core && npm run bench        # 机制基准（EPS / maps/s）
npm test                        # 性能地板 + 正确性
docker compose up -d && docker stats   # 实测资源占用
```

每次调优前后各跑一次基准留档，禁止凭感觉宣称提升。
