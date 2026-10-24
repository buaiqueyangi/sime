package main

// auth.log 事件流：tail + 解析 → ECS（对齐 adapter.generic.linux-auth 映射）。
// 平台侧 rule.host.ssh-bruteforce / success-after-failures 等直接消费。

import (
	"bufio"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 兼容两种 rsyslog 时间格式：
//   传统式  Oct 24 18:24:03 host proc: msg
//   RFC3339 2026-10-24T18:24:03.867745+08:00 host proc[pid]: msg（Debian 12 默认）
// 组序：mon(1) day(2) time(3) iso(4) host(5) proc(6) msg(7)
var authRe = regexp.MustCompile(`^(?:(?P<mon>\w{3})\s+(?P<day>\d{1,2})\s+(?P<time>\d{2}:\d{2}:\d{2})|(?P<iso>\d{4}-\d{2}-\d{2}T[0-9:.+\-]+))\s+(?P<host>\S+)\s+(?P<proc>[^\[:]+)(?:\[\d+\])?:\s+(?P<msg>.+)$`)
var authFailedRe = regexp.MustCompile(`Failed (?:password|publickey) for (?:invalid user )?(?P<user>\S+) from (?P<ip>\d{1,3}(?:\d{1,3}\.){2}\d{1,3}|\S+) port (?P<port>\d+)`)
var authAcceptedRe = regexp.MustCompile(`Accepted (?:password|publickey) for (?P<user>\S+) from (?P<ip>\d{1,3}(?:\d{1,3}\.){2}\d{1,3}|\S+) port (?P<port>\d+)`)
var authNewUserRe = regexp.MustCompile(`new user: name=(?P<user>\S+),`)
var authSudoRe = regexp.MustCompile(`(?P<user>\S+)\s*:.*(?:COMMAND=|sudo)`)

const authLogPath = "/var/log/auth.log"

// tailAuthLog：跟随 auth.log——文件缺失时每 10s 重试（rsyslog 后装/重启场景），
// 支持日志轮转（文件变小则从头读），首次启动从末尾开始（不回放历史）。
func (a *Agent) tailAuthLog() {
	var lastSize int64 = -1
	for {
		f, err := os.Open(authLogPath)
		if err != nil {
			time.Sleep(10 * time.Second)
			continue
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			time.Sleep(10 * time.Second)
			continue
		}
		var start int64
		switch {
		case lastSize < 0:
			start = st.Size() // 首次：跳过历史
		case st.Size() < lastSize:
			start = 0 // 轮转：从头读新文件
		default:
			start = lastSize
		}
		if _, err := f.Seek(start, 0); err != nil {
			f.Close()
			time.Sleep(10 * time.Second)
			continue
		}
		if lastSize < 0 {
			log.Printf("[sime-agent] auth.log 已接入（跳过历史 %d 字节）", start)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			if ev := parseAuthLine(sc.Text(), a.AssetID); ev != nil {
				a.publishEvent(ev)
			}
		}
		if st2, err := f.Stat(); err == nil {
			lastSize = st2.Size()
		}
		f.Close()
		time.Sleep(time.Second)
	}
}

// parseAuthLine：单行 → ECS 事件（nil = 与安全无关）。
func parseAuthLine(line, assetID string) map[string]interface{} {
	m := authRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	host, msg := m[5], m[7]

	if g := authFailedRe.FindStringSubmatch(msg); g != nil {
		return authEvent("failure", g[1], g[2], g[3], host, assetID, line)
	}
	if g := authAcceptedRe.FindStringSubmatch(msg); g != nil {
		return authEvent("success", g[1], g[2], g[3], host, assetID, line)
	}
	if g := authNewUserRe.FindStringSubmatch(msg); g != nil {
		return map[string]interface{}{
			"event": map[string]interface{}{"category": "authentication", "name": "user_add", "outcome": "success"},
			"user":  map[string]interface{}{"name": g[1]},
			"host":  map[string]interface{}{"name": host},
			"src":   map[string]interface{}{"asset_id": assetID},
			"dst":   map[string]interface{}{"asset_id": assetID},
			"message": line,
		}
	}
	if strings.Contains(msg, "sudo:") {
		if g := authSudoRe.FindStringSubmatch(msg); g != nil {
			return map[string]interface{}{
				"event": map[string]interface{}{"category": "authentication", "name": "sudo_use", "outcome": "success"},
				"user":  map[string]interface{}{"name": g[1]},
				"host":  map[string]interface{}{"name": host},
				"src":   map[string]interface{}{"asset_id": assetID},
				"dst":   map[string]interface{}{"asset_id": assetID},
				"message": line,
			}
		}
	}
	return nil
}

func authEvent(outcome, user, ip, port, host, assetID, raw string) map[string]interface{} {
	p, _ := strconv.Atoi(port)
	return map[string]interface{}{
		"event": map[string]interface{}{"category": "authentication", "outcome": outcome},
		"user":  map[string]interface{}{"name": user},
		"src":   map[string]interface{}{"ip": ip, "asset_id": assetID},
		"dst":   map[string]interface{}{"port": p, "asset_id": assetID},
		"host":  map[string]interface{}{"name": host},
		"message": raw,
	}
}
