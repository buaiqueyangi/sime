package main

// 定时基线：用户 / 监听端口 / cron / SUID —— 快照 + 差异 → ECS 事件。
// 对齐规则：account-created-offhours（user_add）、suid-binary-added、crontab-modify、
// rule.cp.login-outside-hours（Accepted success 事件由 authlog 流提供）。

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type Baseline struct {
	dir  string
	users map[string]bool
	cron  map[string]string // path -> md5
	suid  map[string]bool
}

func NewBaseline(dir string) *Baseline {
	return &Baseline{dir: dir, users: map[string]bool{}, cron: map[string]string{}, suid: map[string]bool{}}
}

func (b *Baseline) stateFile() string { return filepath.Join(b.dir, "baseline.json") }

// Snapshot：采集当前状态；若磁盘有历史状态则加载（装机重启不重报）。
func (b *Baseline) Snapshot() error {
	if data, err := os.ReadFile(b.stateFile()); err == nil {
		_ = json.Unmarshal(data, b) // 历史基线优先
		return b.save()
	}
	users, _ := listUsers()
	for _, u := range users {
		b.users[u] = true
	}
	for _, p := range cronPaths() {
		if h, ok := fileMD5(p); ok {
			b.cron[p] = h
		}
	}
	for _, p := range suidFiles() {
		b.suid[p] = true
	}
	return b.save()
}

// Diff：重新采集并对比，返回事件（同时更新基线）。
func (b *Baseline) Diff() ([]map[string]interface{}, error) {
	var events []map[string]interface{}

	// 用户增删
	users, _ := listUsers()
	cur := map[string]bool{}
	for _, u := range users {
		cur[u] = true
		if !b.users[u] {
			events = append(events, baselineEvent("user_add", u, fmt.Sprintf("新增用户 %s", u)))
		}
	}
	for u := range b.users {
		if !cur[u] {
			events = append(events, baselineEvent("user_remove", u, fmt.Sprintf("删除用户 %s", u)))
		}
	}
	b.users = cur

	// cron 变更
	for _, p := range cronPaths() {
		h, ok := fileMD5(p)
		if !ok {
			if _, had := b.cron[p]; had {
				delete(b.cron, p)
				events = append(events, baselineEvent("crontab_modify", p, "cron 文件被删除: "+p))
			}
			continue
		}
		old, had := b.cron[p]
		if !had {
			events = append(events, baselineEvent("crontab_modify", p, "新增 cron 文件: "+p))
		} else if old != h {
			events = append(events, baselineEvent("crontab_modify", p, "cron 文件内容变更: "+p))
		}
		b.cron[p] = h
	}

	// SUID 新增
	suidNow := map[string]bool{}
	for _, p := range suidFiles() {
		suidNow[p] = true
		if !b.suid[p] {
			events = append(events, baselineEvent("suid_added", p, "新增 SUID 文件: "+p))
		}
	}
	b.suid = suidNow

	if err := b.save(); err != nil {
		return events, err
	}
	return events, nil
}

func baselineEvent(name, target, msg string) map[string]interface{} {
	return map[string]interface{}{
		"event":   map[string]interface{}{"category": "host", "name": name, "outcome": "success"},
		"file":    map[string]interface{}{"path": target},
		"message": msg,
	}
}

func (b *Baseline) save() error {
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return os.WriteFile(b.stateFile(), data, 0600)
}

// ---- 系统采集 ----

func listUsers() ([]string, error) {
	data, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return nil, err
	}
	var users []string
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) >= 1 && parts[0] != "" {
			users = append(users, parts[0])
		}
	}
	sort.Strings(users)
	return users, nil
}

func cronPaths() []string {
	var paths []string
	paths = append(paths, "/etc/crontab")
	entries, _ := filepath.Glob("/etc/cron.d/*")
	paths = append(paths, entries...)
	entries, _ = filepath.Glob("/var/spool/cron/crontabs/*")
	paths = append(paths, entries...)
	entries, _ = filepath.Glob("/var/spool/cron/*")
	paths = append(paths, entries...)
	return paths
}

// suidFiles：限定常用二进制目录（P1 不做全盘扫描，避免 IO 风暴）。
func suidFiles() []string {
	dirs := []string{"/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/bin", "/sbin"}
	var out []string
	for _, d := range dirs {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.Mode()&04000 != 0 && !e.IsDir() {
				out = append(out, filepath.Join(d, e.Name()))
			}
		}
	}
	return out
}

func fileMD5(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	sum := md5.Sum(data)
	return hex.EncodeToString(sum[:]), true
}

// 监听端口数（心跳遥测补充；exec 失败静默返回 0）
func listeningPorts() int {
	out, err := exec.Command("ss", "-tuln").Output()
	if err != nil {
		return 0
	}
	return strings.Count(string(out), "\n") - 1
}

func mkdirAll(dir string) error { return os.MkdirAll(dir, 0750) }

