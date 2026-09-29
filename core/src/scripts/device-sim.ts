/**
 * 设备模拟器（M1 演示/验收）：
 *   npm run sim -- --url mqtt://127.0.0.1:1883 [--loop] [--interval 2000] [--burst-sec 300]
 * 行为：
 *   · 5 台虚拟设备（电表×3 / 摄像机 / UPS）按周期上报遥测（正弦日曲线 + 噪声）；
 *   · 每 burst-sec 秒发起一次 22 连发认证失败暴力破解（命中 rule.host.bruteforce.multi-target）。
 * loop 模式常驻运行（compose sim profile 使用）。
 */
import mqtt from 'mqtt';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? def : def;
};
const url = arg('--url', process.env.SIME_MQTT_URL ?? 'mqtt://127.0.0.1:1883');
const intervalMs = Number(arg('--interval', '2000'));
const burstSec = Number(arg('--burst-sec', '300'));
const loop = process.argv.includes('--loop');

const DEVICES = [
  { id: 'dev-meter-001', kind: 'energy.meter', points: (i: number, t: number) => ({ active_power: r(120, 0.15, t, i), voltage_a: r(232, 0.01, t, i + 1) }) },
  { id: 'dev-meter-002', kind: 'energy.meter', points: (i: number, t: number) => ({ active_power: r(95, 0.18, t, i + 2), voltage_a: r(231, 0.01, t, i + 3) }) },
  { id: 'dev-meter-003', kind: 'energy.meter', points: (i: number, t: number) => ({ active_power: r(140, 0.12, t, i + 4), voltage_a: r(233, 0.01, t, i + 5) }) },
  { id: 'dev-cam-001', kind: 'security.camera', points: (i: number, t: number) => ({ bitrate_kbps: r(4096, 0.1, t, i + 6) }) },
  { id: 'dev-ups-001', kind: 'power.ups', points: (i: number, t: number) => ({ load_percent: r(62, 0.08, t, i + 7), battery_percent: 100 }) },
];
function r(base: number, amp: number, t: number, phase: number): number {
  return Math.round((base * (0.85 + 0.3 * Math.sin(t / 60000 + phase) + (Math.random() - 0.5) * amp * 2)) * 100) / 100;
}

const client = mqtt.connect(url, { clientId: `sime-sim-${Date.now() % 100000}` });
let ticks = 0;
let published = 0;

client.on('connect', () => {
  console.log(`[sime-sim] connected ${url} (interval=${intervalMs}ms, burst=${burstSec}s, loop=${loop})`);
  setInterval(tick, intervalMs);
  // 首轮突发延迟：等待订阅方（sime-core）完成 EMQX 订阅，非保留消息先发会丢
  setTimeout(burst, 8000);
  setInterval(burst, burstSec * 1000);
  if (!loop) setTimeout(() => { console.log(`[sime-sim] done: published=${published}`); process.exit(0); }, Math.max(intervalMs * 6 + 5000, 15000));
});
client.on('error', (e) => console.error(`[sime-sim] ${e.message}`));

function tick(): void {
  ticks++;
  const t = Date.now();
  for (const d of DEVICES) {
    const points = d.points(ticks, t);
    // 周期性电压尖峰：超出物模型量程 [0,500]（range_breach），演示遥测越限告警
    if (d.id === 'dev-meter-001' && ticks % 45 === 0) (points as Record<string, number>).voltage_a = 520;
    // 周期性码率异常点：偏离历史基线 >3σ（statistical_anomaly），演示 UEBA
    if (d.id === 'dev-cam-001' && ticks % 90 === 0) (points as Record<string, number>).bitrate_kbps = 40000;
    const payload = JSON.stringify({ asset_id: d.id, kind: d.kind, ts: new Date(t).toISOString(), points });
    client.publish(`sime/v1/${d.id}/telemetry`, payload);
    published++;
  }
}

function burst(): void {
  const t0 = Date.now();
  for (let i = 0; i < 22; i++) {
    setTimeout(() => {
      const payload = JSON.stringify({
        event: { category: 'authentication', outcome: 'failure' },
        src: { ip: '198.51.100.66' },
        dst: { ip: `10.2.85.${100 + (i % 3)}`, asset_id: `dev-meter-00${(i % 3) + 1}` },
        user: { name: 'admin' },
        '@timestamp': new Date(t0 + i * 100).toISOString(),
      });
      client.publish('sime/v1/sim-attacker/event', payload);
      published++;
    }, i * 100);
  }
  console.log(`[sime-sim] bruteforce burst: 22 auth failures -> rule.host.bruteforce.multi-target`);
}
