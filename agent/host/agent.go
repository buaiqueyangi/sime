package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Agent：瘦采集器生命周期。
type Agent struct {
	DeviceID  string
	AssetID   string
	Broker    string
	Heartbeat time.Duration
	StateDir  string

	client mqtt.Client
	mu     sync.Mutex // 串行化 publish 计数
	sent   uint64
}

const agentVersion = "0.1.0"

var agentCaps = []string{"auth-log", "inventory", "baseline-users", "baseline-ports", "baseline-cron", "baseline-suid"}

// Run：连接 → 首采基线 → 启动事件流/基线循环/心跳。
func (a *Agent) Run() error {
	if err := a.connect(); err != nil {
		return err
	}
	log.Printf("[sime-agent] 已连接 %s（device=%s）", a.Broker, a.DeviceID)

	// 基线状态目录
	if err := mkdirAll(a.StateDir); err != nil {
		return fmt.Errorf("状态目录: %w", err)
	}

	// 首次基线（建快照，不报事件，避免装机噪声）
	b := NewBaseline(a.StateDir)
	if err := b.Snapshot(); err != nil {
		log.Printf("[sime-agent] 首次基线失败(降级为空基线): %v", err)
	}

	// 事件流：auth.log
	go a.tailAuthLog()

	// 资产清单：10 分钟全量（进程/软件/CPU/内存/磁盘）
	a.inventoryLoop()

	// 周期基线：10 分钟
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for range t.C {
			events, err := b.Diff()
			if err != nil {
				log.Printf("[sime-agent] 基线采集失败: %v", err)
				continue
			}
			for _, ev := range events {
				a.publishEvent(ev)
			}
		}
	}()

	// 心跳：telemetry + agent 元数据（台账注册）
	a.heartbeat()
	hb := time.NewTicker(a.Heartbeat)
	defer hb.Stop()
	for range hb.C {
		a.heartbeat()
	}
	return nil
}

func (a *Agent) connect() error {
	opts := mqtt.NewClientOptions().
		AddBroker(a.Broker).
		SetClientID("sime-agent-" + a.DeviceID + "-" + fmt.Sprint(time.Now().Unix()%10000)).
		SetAutoReconnect(true).
		SetConnectRetryInterval(5 * time.Second).
		SetMaxReconnectInterval(60 * time.Second).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("[sime-agent] MQTT 已连接")
			a.subscribeCmd(c)
		}).
		SetConnectionLostHandler(func(c mqtt.Client, e error) { log.Printf("[sime-agent] MQTT 断开: %v", e) })
	a.client = mqtt.NewClient(opts)
	tok := a.client.Connect()
	tok.Wait()
	if err := tok.Error(); err != nil {
		return fmt.Errorf("连接 MQTT: %w", err)
	}
	return nil
}

// heartbeat：telemetry 主题，携带 agent 元数据（docs/agent-family.md 契约）。
func (a *Agent) heartbeat() {
	payload := map[string]interface{}{
		"asset_id": a.AssetID,
		"kind":     "server",
		"ts":       time.Now().UTC().Format(time.RFC3339Nano),
		"agent": map[string]interface{}{
			"type":         "host",
			"version":      agentVersion,
			"capabilities": agentCaps,
		},
		"points": map[string]interface{}{
			"agent_sent_events": float64(a.eventCount()),
		},
	}
	a.publishJSON(fmt.Sprintf("sime/v1/%s/telemetry", a.DeviceID), payload)
}

// publishEvent：ECS 事件 → event 主题（QoS1）。
func (a *Agent) publishEvent(ev map[string]interface{}) {
	ev["@timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	ev["sime"] = map[string]interface{}{"domain": "it"}
	a.publishJSON(fmt.Sprintf("sime/v1/%s/event", a.DeviceID), ev)
}

func (a *Agent) publishJSON(topic string, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[sime-agent] JSON 编码失败: %v", err)
		return
	}
	tok := a.client.Publish(topic, 1, false, data)
	if !tok.WaitTimeout(5 * time.Second) {
		log.Printf("[sime-agent] 发布超时 topic=%s", topic)
		return
	}
	if err := tok.Error(); err != nil {
		log.Printf("[sime-agent] 发布失败 topic=%s: %v", topic, err)
		return
	}
	a.mu.Lock()
	a.sent++
	a.mu.Unlock()
}

func (a *Agent) eventCount() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sent
}
