//go:build linux

package main

// Linux 资产清单：纯 /proc 解析（零 cgo），软件清单解析 dpkg 状态文件（回退 rpm -qa 一次 exec）。

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// procSample：单进程快照。
type procSample struct {
	PID  int     `json:"pid"`
	Name string  `json:"name"`
	User string  `json:"user,omitempty"`
	CPU  float64 `json:"cpu"` // 上次采样以来的平均 %
	Mem  float64 `json:"mem"` // RSS 占物理内存 %
	Cmd  string  `json:"cmd,omitempty"`
}

// jiffies：用户态时钟滴答/秒（Linux 固定 100）。
const clockTicks = 100.0

func collectInventory() (map[string]interface{}, error) {
	hostname, _ := os.Hostname()
	var uts syscall.Utsname
	kernel := ""
	if err := syscall.Uname(&uts); err == nil {
		kernel = utsToString(&uts.Release)
	}
	pretty, osVer := readOSRelease()
	bootTime := bootTimeFromProc()

	// CPU：型号 + 核数 + 负载
	cpuModel, cores := "unknown", 0
	if f, err := os.Open("/proc/cpuinfo"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "model name") {
				if i := strings.Index(line, ":"); i > 0 && cpuModel == "unknown" {
					cpuModel = strings.TrimSpace(line[i+1:])
				}
			}
			if strings.HasPrefix(line, "processor") {
				cores++
			}
		}
		f.Close()
	}
	load1 := 0.0
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(b))
		if len(fields) > 0 {
			load1, _ = strconv.ParseFloat(fields[0], 64)
		}
	}

	// 内存：/proc/meminfo（kB → MB）
	memTotal, memAvail := 0.0, 0.0
	if f, err := os.Open("/proc/meminfo"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			kv := strings.Fields(sc.Text())
			if len(kv) < 2 {
				continue
			}
			v, _ := strconv.ParseFloat(kv[1], 64)
			switch kv[0] {
			case "MemTotal:":
				memTotal = v / 1024
			case "MemAvailable:":
				memAvail = v / 1024
			}
		}
		f.Close()
	}

	// 磁盘：/proc/mounts 里真实文件系统 statfs，容量 Top 8
	disks := []map[string]interface{}{}
	if f, err := os.Open("/proc/mounts"); err == nil {
		sc := bufio.NewScanner(f)
		seen := map[string]bool{}
		pseudo := map[string]bool{
			"proc": true, "sysfs": true, "devpts": true, "tmpfs": true, "devtmpfs": true,
			"cgroup": true, "cgroup2": true, "mqueue": true, "shm": true, "overlay": true,
			"squashfs": true, "nsfs": true, "fusectl": true, "securityfs": true, "debugfs": true,
			"tracefs": true, "pstore": true, "bpf": true, "autofs": true, "hugetlbfs": true,
			"efivarfs": true, "ramfs": true, "configfs": true, "fuseblk": true,
		}
		for sc.Scan() && len(disks) < 8 {
			fields := strings.Fields(sc.Text())
			if len(fields) < 3 {
				continue
			}
			fs, mount := fields[0], fields[1]
			if !strings.HasPrefix(mount, "/") || seen[mount] || pseudo[fs] {
				continue
			}
			var st syscall.Statfs_t
			if err := syscall.Statfs(mount, &st); err != nil {
				continue
			}
			total := float64(st.Blocks) * float64(st.Bsize) / (1 << 30)
			free := float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
			if total < 0.5 {
				continue
			}
			seen[mount] = true
			disks = append(disks, map[string]interface{}{
				"fs": fs, "mount": mount, "totalGB": round1(total), "usedGB": round1(total - free),
			})
		}
		f.Close()
	}

	// 进程：两次采样 /proc/[pid]/stat 的 utime+stime，CPU% = Δjiffies / (滴答率 × Δ秒)
	passwd := loadPasswd()
	prev := readProcJiffies()
	time.Sleep(600 * time.Millisecond)
	curr := readProcJiffies()
	elapsed := float64(curr.wall-prev.wall) / 1000.0
	if elapsed < 0.2 {
		elapsed = 0.2
	}
	procs := make([]procSample, 0, len(curr.m))
	for pid, c := range curr.m {
		p := prev.m[pid]
		memPct := 0.0
		if memTotal > 0 {
			memPct = c.rssKB / 1024 / memTotal * 100
		}
		procs = append(procs, procSample{
			PID: pid, Name: c.name, User: passwd[c.uid],
			CPU: round2((c.jiffies - p.jiffies) / clockTicks / elapsed * 100),
			Mem: round2(memPct), Cmd: c.cmd,
		})
	}
	sort.Slice(procs, func(i, j int) bool {
		return procs[i].CPU+procs[i].Mem > procs[j].CPU+procs[j].Mem
	})
	if len(procs) > 40 {
		procs = procs[:40]
	}

	inv := map[string]interface{}{
		"host": map[string]interface{}{
			"hostname": hostname, "os": pretty, "os_version": osVer,
			"kernel": kernel, "arch": archName(), "boot_epoch": bootTime,
		},
		"cpu":    map[string]interface{}{"model": cpuModel, "cores": cores, "load1": round2(load1)},
		"memory": map[string]interface{}{"total_mb": int(memTotal), "available_mb": int(memAvail)},
		"disk":   disks,
		"processes": map[string]interface{}{
			"count": len(curr.m),
			"top":   procs,
		},
		"software": softwareList(),
	}
	return inv, nil
}

func readOSRelease() (pretty, version string) {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		kv := strings.SplitN(sc.Text(), "=", 2)
		if len(kv) != 2 {
			continue
		}
		v := strings.Trim(kv[1], `"`)
		switch kv[0] {
		case "PRETTY_NAME":
			pretty = v
		case "VERSION_ID":
			version = v
		}
	}
	return pretty, version
}

func loadPasswd() map[string]string {
	m := map[string]string{}
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Split(sc.Text(), ":")
		if len(p) >= 3 {
			m[p[2]] = p[0]
		}
	}
	return m
}

type procRaw struct {
	name    string
	uid     string
	jiffies float64
	rssKB   float64
	cmd     string
}

type procSnap struct {
	m    map[int]procRaw
	wall int64 // 毫秒
}

func bootTimeFromProc() int64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			v, _ := strconv.ParseInt(strings.TrimSpace(line[6:]), 10, 64)
			return v
		}
	}
	return 0
}

func readProcJiffies() procSnap {
	snap := procSnap{m: map[int]procRaw{}, wall: time.Now().UnixMilli()}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return snap
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		dir := filepath.Join("/proc", e.Name())
		raw := procRaw{}
		if b, err := os.ReadFile(filepath.Join(dir, "stat")); err == nil {
			// comm 可能含空格与括号：名字在第一个 '(' 与最后一个 ')' 之间
			s := string(b)
			if i := strings.Index(s, "("); i >= 0 {
				if j := strings.LastIndex(s, ")"); j > i {
					raw.name = s[i+1 : j]
					fields := strings.Fields(s[j+1:])
					if len(fields) > 12 {
						u, _ := strconv.ParseFloat(fields[11], 64)
						sj, _ := strconv.ParseFloat(fields[12], 64)
						raw.jiffies = u + sj
					}
				}
			}
		}
		if b, err := os.ReadFile(filepath.Join(dir, "status")); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "Uid:") {
					if p := strings.Fields(line); len(p) > 1 {
						raw.uid = p[1]
					}
				}
			}
		}
		if b, err := os.ReadFile(filepath.Join(dir, "statm")); err == nil {
			if fields := strings.Fields(string(b)); len(fields) > 1 {
				pages, _ := strconv.ParseFloat(fields[1], 64)
				raw.rssKB = pages * float64(os.Getpagesize()) / 1024
			}
		}
		if b, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil && len(b) > 0 {
			raw.cmd = string(bytes.ReplaceAll(b, []byte{0}, []byte{' '}))
			if len(raw.cmd) > 160 {
				raw.cmd = raw.cmd[:160]
			}
		}
		snap.m[pid] = raw
	}
	return snap
}

// softwareList：dpkg status 优先，回退 rpm -qa（一次 exec）；上限 500 条。
func softwareList() []map[string]string {
	if pkgs := dpkgList(); len(pkgs) > 0 {
		return pkgs
	}
	return rpmList()
}

func dpkgList() []map[string]string {
	f, err := os.Open("/var/lib/dpkg/status")
	if err != nil {
		return nil
	}
	defer f.Close()
	pkgs := []map[string]string{}
	name, ver := "", ""
	flush := func() {
		if name != "" {
			pkgs = append(pkgs, map[string]string{"name": name, "version": ver})
		}
		name, ver = "", ""
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() && len(pkgs) < 500 {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "Package: "):
			flush()
			name = strings.TrimPrefix(line, "Package: ")
		case strings.HasPrefix(line, "Version: "):
			ver = strings.TrimPrefix(line, "Version: ")
		case line == "":
			flush()
		}
	}
	flush()
	return pkgs
}

func rpmList() []map[string]string {
	out, err := exec.Command("rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}\n").Output()
	if err != nil {
		return nil
	}
	pkgs := []map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		p := strings.SplitN(line, "\t", 2)
		if len(p) == 2 && len(pkgs) < 500 {
			pkgs = append(pkgs, map[string]string{"name": p[0], "version": p[1]})
		}
	}
	return pkgs
}

func archName() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return runtime.GOARCH
	}
}

func utsToString(ca *[65]int8) string {
	s := make([]byte, 0, len(ca))
	for _, c := range ca {
		if c == 0 {
			break
		}
		s = append(s, byte(c))
	}
	return string(s)
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }
