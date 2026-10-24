// sime-agent — SIME 主机防护 Agent P1（docs/host-agent-design.md）
//
// 瘦采集：auth.log 事件流 + 定时基线（用户/端口/cron/SUID），本地不做检测。
// 输出对齐 adapter.generic.linux-auth 的 ECS 映射形态 → 平台侧 77 条主机规则零改动生效。
// 通道复用平台统一契约（docs/agent-family.md）：
//   上行事件  sime/v1/{deviceId}/event      QoS1
//   心跳遥测  sime/v1/{deviceId}/telemetry  QoS1（携带 agent 元数据，台账自动注册）
package main

import (
	"flag"
	"log"
	"os"
	"time"
)

func main() {
	broker := flag.String("broker", "tcp://127.0.0.1:1883", "MQTT broker 地址")
	device := flag.String("device", "", "设备 ID（默认 主机名）")
	asset := flag.String("asset", "", "资产 ID（默认同设备 ID）")
	interval := flag.Duration("heartbeat", 30*time.Second, "心跳间隔")
	stateDir := flag.String("state", "/var/lib/sime-agent", "基线状态目录")
	protect := flag.String("protect-cidr", "", "永不被封锁的 CIDR 列表（逗号分隔，防管理面锁死）")
	flag.Parse()
	parseProtectCIDRs(*protect)

	dev := *device
	if dev == "" {
		h, err := os.Hostname()
		if err != nil || h == "" {
			dev = "sime-host"
		} else {
			dev = "srv-" + h
		}
	}
	as := *asset
	if as == "" {
		as = dev
	}

	a := &Agent{
		DeviceID:  dev,
		AssetID:   as,
		Broker:    *broker,
		Heartbeat: *interval,
		StateDir:  *stateDir,
	}

	if err := a.Run(); err != nil {
		log.Fatalf("[sime-agent] 退出: %v", err)
	}
}
