package main

// 资产清单采集：主机/CPU/内存/磁盘 + 进程 Top + 已装软件，10 分钟一报。
// 主题：sime/v1/{device}/inventory（QoS1）；平台侧落 agent_inventory 表（每设备最新快照）。

import (
	"fmt"
	"log"
	"time"
)

// inventoryInterval：清单全量采集周期（与基线 diff 同节奏，避免抖动）。
const inventoryInterval = 10 * time.Minute

func (a *Agent) inventoryLoop() {
	go func() {
		time.Sleep(3 * time.Second) // 等首连完成
		a.reportInventory()
		t := time.NewTicker(inventoryInterval)
		defer t.Stop()
		for range t.C {
			a.reportInventory()
		}
	}()
}

func (a *Agent) reportInventory() {
	inv, err := collectInventory()
	if err != nil {
		log.Printf("[sime-agent] 资产清单采集失败: %v", err)
		return
	}
	inv["device_id"] = a.DeviceID
	inv["asset_id"] = a.AssetID
	inv["agent_version"] = agentVersion
	inv["collected_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	a.publishJSON(fmt.Sprintf("sime/v1/%s/inventory", a.DeviceID), inv)
}
