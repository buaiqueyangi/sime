package main

// cmd 响应执行通道（P2）：订阅 sime/v1/{deviceId}/cmd，执行平台下发的处置动作并回执。
// 安全约束：
//  1. 动作白名单（未知动作回 unsupported，绝不执行任意命令）；
//  2. --protect-cidr 网段永不被封锁（防管理面锁死）；
//  3. 所有执行结果回执 cmd/reply，平台侧落 response_audit。

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// AgentCmd 平台下发的命令
type AgentCmd struct {
	ID     string                 `json:"id"`
	Action string                 `json:"action"`
	Args   map[string]interface{} `json:"args"`
}

// AgentReply 执行回执
type AgentReply struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Status string `json:"status"` // executed | failed | skipped | unsupported
	Detail string `json:"detail"`
	TS     string `json:"ts"`
}

var protectNets []*net.IPNet

func parseProtectCIDRs(spec string) {
	protectNets = nil
	for _, c := range strings.Split(spec, ",") {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			protectNets = append(protectNets, n)
		} else {
			log.Printf("[sime-agent] 无效 protect-cidr: %q", c)
		}
	}
}

func ipProtected(ip string) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	for _, n := range protectNets {
		if n.Contains(p) {
			return true
		}
	}
	return false
}

// subscribeCmd：在 OnConnect 时订阅（重连后 paho 自动重订阅 handler 已注册）。
func (a *Agent) subscribeCmd(c mqtt.Client) {
	topic := fmt.Sprintf("sime/v1/%s/cmd", a.DeviceID)
	tok := c.Subscribe(topic, 1, func(_ mqtt.Client, m mqtt.Message) {
		var cmd AgentCmd
		if err := json.Unmarshal(m.Payload(), &cmd); err != nil {
			log.Printf("[sime-agent] 坏命令帧: %v", err)
			return
		}
		reply := a.execCommand(cmd)
		a.publishReply(reply)
	})
	tok.WaitTimeout(3 * time.Second)
	if tok.Error() == nil {
		log.Printf("[sime-agent] cmd 通道就绪 %s（protect-cidr=%d 段）", topic, len(protectNets))
	} else {
		log.Printf("[sime-agent] cmd 订阅失败: %v", tok.Error())
	}
}

func (a *Agent) publishReply(r AgentReply) {
	r.TS = time.Now().UTC().Format(time.RFC3339Nano)
	data, _ := json.Marshal(r)
	a.client.Publish(fmt.Sprintf("sime/v1/%s/cmd/reply", a.DeviceID), 1, false, data)
}

// execCommand：白名单分发。
func (a *Agent) execCommand(cmd AgentCmd) AgentReply {
	base := AgentReply{ID: cmd.ID, Action: cmd.Action}
	arg := func(k string) string {
		if v, ok := cmd.Args[k]; ok {
			return fmt.Sprint(v)
		}
		return ""
	}
	switch cmd.Action {
	case "account.lock":
		return a.cmdAccountLock(base, arg("user"), true)
	case "account.unlock":
		return a.cmdAccountLock(base, arg("user"), false)
	case "firewall.block":
		return a.cmdFirewallBlock(base, arg("ip"), arg("ttl"))
	case "firewall.unblock":
		return a.cmdFirewallUnblock(base, arg("ip"))
	case "process.kill":
		return a.cmdProcessKill(base, arg("name"))
	case "file.quarantine":
		return a.cmdFileQuarantine(base, arg("path"))
	case "isolate.host":
		return a.cmdIsolate(base)
	case "isolate.remove":
		return a.cmdIsolateRemove(base)
	case "ping":
		return AgentReply{ID: cmd.ID, Action: cmd.Action, Status: "executed", Detail: "pong"}
	default:
		return AgentReply{ID: cmd.ID, Action: cmd.Action, Status: "unsupported", Detail: "动作不在白名单"}
	}
}

func runCmd(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (a *Agent) cmdAccountLock(base AgentReply, user string, lock bool) AgentReply {
	if user == "" || strings.ContainsAny(user, " \t/;$&|><`") {
		base.Status, base.Detail = "failed", "非法用户名参数"
		return base
	}
	// 账号必须真实存在（防误报锁定幻觉）
	if out, err := runCmd("getent", "passwd", user); err != nil || out == "" {
		base.Status, base.Detail = "failed", fmt.Sprintf("用户不存在: %s", user)
		return base
	}
	sub := "-L"
	detail := "已锁定"
	if !lock {
		sub, detail = "-U", "已解锁"
	}
	if _, err := runCmd("usermod", sub, user); err != nil {
		base.Status, base.Detail = "failed", fmt.Sprintf("usermod %s: %v", sub, err)
		return base
	}
	base.Status, base.Detail = "executed", fmt.Sprintf("%s %s", user, detail)
	return base
}

func (a *Agent) cmdFirewallBlock(base AgentReply, ip, ttl string) AgentReply {
	if net.ParseIP(ip) == nil {
		base.Status, base.Detail = "failed", "非法 IP"
		return base
	}
	if ipProtected(ip) {
		base.Status = "skipped"
		base.Detail = fmt.Sprintf("%s 命中保护网段，拒绝封锁（防管理面锁死）", ip)
		log.Printf("[sime-agent] [protect] %s", base.Detail)
		return base
	}
	if _, err := runCmd("iptables", "-I", "INPUT", "-s", ip, "-j", "DROP"); err != nil {
		base.Status, base.Detail = "failed", "iptables: "+err.Error()
		return base
	}
	// TTL 到期自动解封
	if d, err := time.ParseDuration(ttl); err == nil && d > 0 {
		go func() {
			time.Sleep(d)
			_, _ = runCmd("iptables", "-D", "INPUT", "-s", ip, "-j", "DROP")
			log.Printf("[sime-agent] TTL 到期自动解封 %s", ip)
		}()
	}
	base.Status, base.Detail = "executed", fmt.Sprintf("已封锁 %s（ttl=%s）", ip, ttl)
	return base
}

func (a *Agent) cmdFirewallUnblock(base AgentReply, ip string) AgentReply {
	if _, err := runCmd("iptables", "-D", "INPUT", "-s", ip, "-j", "DROP"); err != nil {
		base.Status, base.Detail = "failed", err.Error()
		return base
	}
	base.Status, base.Detail = "executed", "已解封 "+ip
	return base
}

func (a *Agent) cmdProcessKill(base AgentReply, name string) AgentReply {
	if name == "" || strings.ContainsAny(name, " /;$&|><`") {
		base.Status, base.Detail = "failed", "非法进程名"
		return base
	}
	if _, err := runCmd("pkill", "-TERM", name); err != nil {
		base.Status, base.Detail = "failed", "pkill: "+err.Error()
		return base
	}
	base.Status, base.Detail = "executed", "已发送 TERM → "+name
	return base
}

func (a *Agent) cmdFileQuarantine(base AgentReply, path string) AgentReply {
	if path == "" || !strings.HasPrefix(path, "/") {
		base.Status, base.Detail = "failed", "非法路径"
		return base
	}
	qdir := a.StateDir + "/quarantine"
	if err := os.MkdirAll(qdir, 0700); err != nil {
		base.Status, base.Detail = "failed", err.Error()
		return base
	}
	dst := qdir + "/" + fmt.Sprint(time.Now().Unix()) + "-" + strings.ReplaceAll(strings.TrimPrefix(path, "/"), "/", "_")
	if err := os.Rename(path, dst); err != nil {
		base.Status, base.Detail = "failed", "rename: "+err.Error()
		return base
	}
	_ = os.Chmod(dst, 0)
	base.Status = "executed"
	base.Detail = fmt.Sprintf("已隔离 %s → %s（权限 000）", path, dst)
	return base
}

// ==================== 主机隔离（isolate.host / isolate.remove） ====================
// 自定义链 SIME-ISO：默认全断新连接，放行 lo / ESTABLISHED / protect 网段。
// 挂到 INPUT 首位；remove 时摘链并清空——可干净回退，不留残留规则。

const isoChain = "SIME-ISO"

func (a *Agent) cmdIsolate(base AgentReply) AgentReply {
	if _, err := runCmd("iptables", "-L", isoChain); err != nil {
		if _, err := runCmd("iptables", "-N", isoChain); err != nil {
			base.Status, base.Detail = "failed", "创建链失败: "+err.Error()
			return base
		}
	}
	runCmd("iptables", "-F", isoChain)
	// 放行顺序：lo → 已建立 → 保护网段 → 其余全断
	if _, err := runCmd("iptables", "-A", isoChain, "-i", "lo", "-j", "RETURN"); err != nil {
		base.Status, base.Detail = "failed", err.Error()
		return base
	}
	if _, err := runCmd("iptables", "-A", isoChain, "-m", "state", "--state", "ESTABLISHED,RELATED", "-j", "RETURN"); err != nil {
		base.Status, base.Detail = "failed", err.Error()
		return base
	}
	for _, n := range protectNets {
		if _, err := runCmd("iptables", "-A", isoChain, "-s", n.String(), "-j", "RETURN"); err != nil {
			base.Status, base.Detail = "failed", err.Error()
			return base
		}
	}
	if _, err := runCmd("iptables", "-A", isoChain, "-j", "DROP"); err != nil {
		base.Status, base.Detail = "failed", err.Error()
		return base
	}
	// 挂到 INPUT 首位（幂等：已存在则先摘再挂）
	runCmd("iptables", "-D", "INPUT", "-j", isoChain)
	if _, err := runCmd("iptables", "-I", "INPUT", "-j", isoChain); err != nil {
		base.Status, base.Detail = "failed", "挂链失败: "+err.Error()
		return base
	}
	base.Status = "executed"
	base.Detail = fmt.Sprintf("主机已隔离（放行 lo/ESTABLISHED/%d个保护网段，其余新连接全断）", len(protectNets))
	return base
}

func (a *Agent) cmdIsolateRemove(base AgentReply) AgentReply {
	runCmd("iptables", "-D", "INPUT", "-j", isoChain)
	runCmd("iptables", "-F", isoChain)
	if _, err := runCmd("iptables", "-X", isoChain); err != nil {
		base.Status, base.Detail = "failed", "删除链失败: "+err.Error()
		return base
	}
	base.Status, base.Detail = "executed", "隔离已解除（链已移除，无残留规则）"
	return base
}
