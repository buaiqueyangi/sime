//go:build !linux

package main

// 非 Linux 平台的资产清单降级：基础信息 + 进程数（完整 /proc 实现见 inventory_linux.go）。
// Windows 深度采集（注册表软件清单、工具快照进程）后续按 winevt_windows.go 模式补齐。

import (
	"os"
	"runtime"
	"time"
)

func collectInventory() (map[string]interface{}, error) {
	hostname, _ := os.Hostname()
	return map[string]interface{}{
		"host": map[string]interface{}{
			"hostname": hostname,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
		},
		"cpu":       map[string]interface{}{"cores": runtime.NumCPU()},
		"processes": map[string]interface{}{"count": 0, "top": []interface{}{}},
		"software":  []interface{}{},
		"note":      "generic collector: full inventory available on linux",
		"sampled_at": time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}
