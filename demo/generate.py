#!/usr/bin/env python3
"""SIME demo data generator (M0).

Generates:
  devices.jsonl          设备台账（物模型模板实例化）
  telemetry.jsonl        测点遥测（含周期规律 + 噪声）
  security-events.jsonl  攻击场景回放（暴力破解/扫描/WebShell/OT 越权写指令）

Stdlib only. Sizes: --smoke for CI; default simulates a campus (500 points / 7 days).
"""
import argparse
import json
import math
import os
import random
from datetime import datetime, timedelta

TEMPLATES = {
    "power-meter": {"points": ["active_power", "reactive_power", "voltage_a"], "base": {"active_power": 120, "reactive_power": 35, "voltage_a": 232}},
    "ip-camera": {"points": ["bitrate_kbps"], "base": {"bitrate_kbps": 4096}},
    "ups": {"points": ["load_percent", "battery_percent"], "base": {"load_percent": 62, "battery_percent": 100}},
}
ZONES = ["A", "B", "C"]


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def make_devices(count: int, seed: random.Random) -> list:
    """物模型模板实例化为设备台账。"""
    devices = []
    names = list(TEMPLATES) + ["gateway"]
    for i in range(count):
        t = names[i % len(names)]
        zone = ZONES[i % len(ZONES)]
        dev = {
            "asset_id": f"dev-{t[:4]}-{i:04d}",
            "thing_model": f"tmpl.{t}.v1" if t != "power-meter" else "tmpl.power-meter.v2",
            "type": t,
            "labels": {"building": f"楼{zone}", "floor": str(seed.randint(1, 6)), "zone": "dmz" if t == "gateway" and i % 17 == 0 else "intranet"},
            "security": {"asset_criticality": 5 if t == "ups" else seed.randint(1, 3), "exposure": "dmz" if t == "gateway" else "intranet"},
        }
        devices.append(dev)
    return devices


def make_telemetry(devices: list, days: int, step_min: int, seed: random.Random) -> list:
    """周期规律（日曲线）+ 噪声；500 点 × 7 天 × 15min ≈ 336k 行。"""
    rows = []
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days)
    steps = days * 24 * 60 // step_min
    for s in range(steps):
        ts = start + timedelta(minutes=s * step_min)
        hour = ts.hour + ts.minute / 60
        day_factor = 0.55 + 0.45 * math.sin((hour - 6) / 24 * 2 * math.pi)  # 白天高、夜间低
        for dev in devices:
            tpl = TEMPLATES.get(dev["type"])
            if not tpl:
                continue
            for point, base in tpl["base"].items():
                if point == "battery_percent":
                    value = base - (5 if 12 <= hour <= 14 else 0)
                else:
                    value = base * day_factor + seed.gauss(0, base * 0.04)
                rows.append({"asset_id": dev["asset_id"], "point": point, "ts": iso(ts), "value": round(max(value, 0), 2)})
    return rows


def attack_events(seed: random.Random) -> list:
    """攻击场景回放：ECS 风格字段，供规则引擎/告警演示。"""
    now = datetime.now().replace(microsecond=0)
    events = []

    def ev(offset_s, **kw):
        e = {"@timestamp": iso(now - timedelta(seconds=offset_s)), "event": {"category": kw.pop("category"), "outcome": kw.pop("outcome", "failure")}, "sime": {"domain": kw.pop("domain", "it")}}
        e.update(kw)
        events.append(e)

    # 场景1：暴力破解（同源 5 分钟内对 3 台主机 22 次失败）→ 命中 rule.host.bruteforce.multi-target
    for i in range(22):
        ev(600 - i * 13, category="authentication", src={"ip": "198.51.100.7"},
           dst={"ip": f"10.2.85.{100 + i % 3}", "asset_id": f"dev-powe-{i % 3:04d}"},
           user={"name": seed.choice(["admin", "root", "test"])})
    # 场景2：高频扫描（5 分钟 20+ 资产）→ rule.edge.scan.high-freq
    for i in range(24):
        ev(300 - i * 12, category="network-connection", src={"ip": "203.0.113.9"}, dst={"ip": f"10.2.86.{i + 1}", "asset_id": f"dev-gate-{i:04d}"})
    # 场景3：WebShell 上传 → rule.host.webshell.upload
    ev(120, category="web", outcome="deny", src={"ip": "203.0.113.15"}, dst={"ip": "10.2.85.119"}, http={"request": {"method": "POST", "body": {"content": "<?php eval($_POST[cmd]); ?>"}}}, url={"path": "/uploads/cmd.php"}, file={"name": "cmd.php"})
    # 场景4：OT 越权写指令（非值班时段）→ rule.ot.plc-write-offhours
    ev(60, category="ics-command", outcome="success", domain="ot", src={"ip": "10.233.9.66"}, dst={"ip": "10.233.9.2", "asset_id": "dev-plc-0001", "asset": {"id": "dev-plc-0001", "type": "plc", "security": {"command_allowlist": ["scada-master-01"]}}}, event={"category": "ics-command", "outcome": "success", "action": "write"})
    # 场景5：感染后暴力破解链（跨源序列）→ rule.merged.infection-then-bruteforce
    ev(3600, category="endpoint", outcome="detected", src={"ip": "10.233.71.108", "asset_id": "dev-gate-0042"}, event={"category": "endpoint", "name": "virus_detect", "outcome": "detected"})
    for i in range(6):
        ev(3400 - i * 15, category="authentication", src={"ip": "10.233.71.108", "asset_id": "dev-gate-0042"}, dst={"ip": "10.2.88.50", "asset_id": "dev-gate-0099"}, user={"name": "admin"})
    return events


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--points", type=int, default=500, help="设备数")
    ap.add_argument("--days", type=int, default=7, help="遥测天数")
    ap.add_argument("--step-min", type=int, default=15, help="遥测间隔（分钟）")
    ap.add_argument("--out", default="demo/out")
    ap.add_argument("--smoke", action="store_true", help="CI 模式：20 设备 × 1 天 × 60min")
    args = ap.parse_args()
    if args.smoke:
        args.points, args.days, args.step_min = 20, 1, 60
    seed = random.Random(42)
    os.makedirs(args.out, exist_ok=True)

    devices = make_devices(args.points, seed)
    telemetry = make_telemetry(devices, args.days, args.step_min, seed)
    events = attack_events(seed)

    def dump(name, rows):
        with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    dump("devices.jsonl", devices)
    dump("telemetry.jsonl", telemetry)
    dump("security-events.jsonl", events)
    print(f"devices={len(devices)} telemetry_rows={len(telemetry)} security_events={len(events)} -> {args.out}")


if __name__ == "__main__":
    main()
