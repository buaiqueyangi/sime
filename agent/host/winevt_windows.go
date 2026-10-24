//go:build windows

package main

// Windows 事件流（P1）：轮询 Get-WinEvent（Security 日志，4624/4625/4688/7045/1102），
// 解析为 ECS —— 与 Linux authlog 同一形态，平台侧 28 条 windows-security 规则直接消费。
// 轮询而非订阅（P1 简化）：5s 一次 PowerShell，进程开销可接受；P3 换 WinEvt 原生 API。

import (
	"encoding/json"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const winPollInterval = 5 * time.Second
const winEventIDs = "4624,4625,4688,7045,1102"

// PowerShell 输出（-MaxEvents N | ConvertTo-Json）：单条=对象，多条=数组。
type winEvt struct {
	ID         int    `json:"Id"`
	TimeCreated winT  `json:"TimeCreated"`
	Properties []struct {
		Value interface{} `json:"Value"`
	} `json:"Properties"`
}
type winT struct {
	DateTime string `json:"DateTime"`
}

func (a *Agent) tailAuthLog() { // Windows 侧同名入口：事件流
	var lastID int
	for {
		out, err := exec.Command("powershell", "-NoProfile", "-Command",
			`Get-WinEvent -FilterHashtable @{LogName='Security';Id=[`+winEventIDs+`]} -MaxEvents 10 | Select-Object Id,TimeCreated,@{n='Properties';e={($_.Properties | Select-Object -ExpandProperty Value) -join [char]7}} | ConvertTo-Json`).Output()
		if err != nil {
			time.Sleep(winPollInterval)
			continue
		}
		var evts []map[string]interface{}
		raw := strings.TrimSpace(string(out))
		if raw == "" {
			time.Sleep(winPollInterval)
			continue
		}
		var single map[string]interface{}
		if json.Unmarshal([]byte(raw), &single) == nil && single != nil {
			evts = append(evts, single)
		} else {
			_ = json.Unmarshal([]byte(raw), &evts)
		}
		for _, e := range evts {
			if ev := parseWinEvent(e, a.AssetID); ev != nil {
				a.publishEvent(ev)
			}
		}
		_ = lastID
		time.Sleep(winPollInterval)
	}
}

// parseWinEvent：Security 事件 → ECS（字段对齐 Sysmon 适配器映射）。
func parseWinEvent(e map[string]interface{}, assetID string) map[string]interface{} {
	idF, _ := e["Id"].(float64)
	id := int(idF)
	// Properties 是 BEL 分隔字符串（位序随事件码不同）
	propStr, _ := e["Properties"].(string)
	props := strings.Split(propStr, "\x07")

	get := func(i int) string {
		if i < len(props) {
			return props[i]
		}
		return ""
	}

	var ev map[string]interface{}
	switch id {
	case 4624, 4625: // 登录成功/失败：P5=目标用户 P19=源IP
		outcome := "success"
		name := "logon"
		if id == 4625 {
			outcome = "failure"
			name = "logon_failure"
		}
		ev = map[string]interface{}{
			"event": map[string]interface{}{"category": "authentication", "outcome": outcome, "code": strconv.Itoa(id), "name": name},
			"user":  map[string]interface{}{"name": get(5)},
			"src":   map[string]interface{}{"ip": get(19), "asset_id": assetID},
			"dst":   map[string]interface{}{"asset_id": assetID},
		}
	case 4688: // 进程创建：P5=新进程名 P4=父进程 P1=命令行
		ev = map[string]interface{}{
			"event":   map[string]interface{}{"category": "endpoint", "outcome": "success", "code": "4688", "name": "process_create"},
			"process": map[string]interface{}{"name": get(5), "command_line": get(1), "parent_name": get(4)},
			"src":     map[string]interface{}{"asset_id": assetID},
			"dst":     map[string]interface{}{"asset_id": assetID},
		}
	case 7045: // 新服务安装：P0=服务名 P1=命令行
		ev = map[string]interface{}{
			"event": map[string]interface{}{"category": "endpoint", "outcome": "success", "code": "7045", "name": "service_create"},
			"process": map[string]interface{}{"name": get(0), "command_line": get(1)},
			"src":   map[string]interface{}{"asset_id": assetID},
			"dst":   map[string]interface{}{"asset_id": assetID},
		}
	case 1102: // 审计日志清除
		ev = map[string]interface{}{
			"event": map[string]interface{}{"category": "endpoint", "outcome": "success", "code": "1102", "name": "audit_log_clear"},
			"src":   map[string]interface{}{"asset_id": assetID},
			"dst":   map[string]interface{}{"asset_id": assetID},
		}
	default:
		return nil
	}
	if tc, ok := e["TimeCreated"].(map[string]interface{}); ok {
		if dt, ok := tc["DateTime"].(string); ok {
			ev["@timestamp"] = dt
		}
	}
	return ev
}

var _ = log.Printf // 保持 import
