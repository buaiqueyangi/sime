/**
 * sime-bench —— 性能基准（蓝图 §6.4：可复现口径，机制优化的验收工具）。
 * 口径：事件预生成（确定性 PRNG），计时只含喂入/求值热路径。
 * 用法：npm run bench [-- --quick]
 */
import { performance } from 'node:perf_hooks';
import { AssetRegistry } from '../common/registry';
import { RuleEngine, SimeRule } from '../rule-engine/rule-engine';
import { AdapterDef, compileAdapter } from '../adapter-engine/adapter-engine';

export interface BenchResult {
  name: string;
  ops: number;
  ms: number;
  opsPerSec: number;
  extra?: Record<string, unknown>;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function genEvents(n: number): { ev: Record<string, unknown>; ts: number }[] {
  const rng = mulberry32(42);
  const out: { ev: Record<string, unknown>; ts: number }[] = new Array(n);
  let ts = Date.now();
  for (let i = 0; i < n; i++) {
    ts += 1;
    const r = rng();
    let ev: Record<string, unknown>;
    if (r < 0.5) {
      ev = {
        event: { category: 'authentication', outcome: 'failure' },
        src: { ip: `10.1.0.${i % 100}` },
        dst: { ip: `10.2.85.${i % 3}`, asset_id: `dev-powe-${i % 3}` },
        user: { name: `u${i % 37}` },
      };
    } else if (r < 0.8) {
      ev = {
        event: { category: 'network-connection', outcome: 'success' },
        src: { ip: `203.0.113.${i % 200}` },
        dst: { ip: `10.2.86.${(i * 7) % 500}`, asset_id: `dev-gate-${(i * 7) % 500}` },
      };
    } else if (r < 0.95) {
      ev = {
        event: { category: 'web', outcome: 'allow' },
        src: { ip: `198.51.100.${i % 150}` },
        dst: { ip: `10.2.85.119`, asset_id: 'dev-gate-0001' },
        http: { request: { method: 'GET', body: { content: 'x=1' } } },
        url: { path: `/item/${i % 997}` },
      };
    } else {
      ev = {
        event: { category: 'ics-command', outcome: 'success', action: 'write' },
        src: { ip: `10.233.9.${i % 60}` },
        dst: {
          ip: '10.233.9.2',
          asset_id: 'dev-plc-0001',
          asset: { id: 'dev-plc-0001', type: 'plc', security: { command_allowlist: ['scada-master-01'] } },
        },
      };
    }
    out[i] = { ev, ts };
  }
  return out;
}

export function benchRuleEngine(n = 200_000): BenchResult {
  const registry = new AssetRegistry(process.env.SIME_ASSET_ROOT ?? '..');
  const defs = registry.load('rules').entries.map(({ data }) => data as unknown as SimeRule);
  const engine = new RuleEngine(defs);
  const events = genEvents(n);
  const t0 = performance.now();
  let alerts = 0;
  for (const { ev, ts } of events) alerts += engine.feed(ev, ts).length;
  const ms = performance.now() - t0;
  return { name: 'S1 rule-engine.feed', ops: n, ms: Math.round(ms), opsPerSec: Math.round(n / (ms / 1000)), extra: { alerts, rules: engine.rules.length } };
}

export function benchAdapter(n = 100_000): BenchResult {
  const registry = new AssetRegistry(process.env.SIME_ASSET_ROOT ?? '..');
  const entry = registry
    .load('adapters')
    .entries.map(({ data }) => data as unknown as AdapterDef)
    .find((d) => d.id === 'adapter.sangfor.ips')!;
  const ca = compileAdapter(entry);
  const lines: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    lines[i] = `time=2025-04-27 10:23:01 src_ip=203.0.113.${i % 250} src_port=${10000 + (i % 50000)} dst_ip=10.2.85.${i % 50} dst_port=8080 rule_id=${1000001 + (i % 5)} threat=攻击行为 level=高危 action=阻断`;
  }
  const t0 = performance.now();
  for (let i = 0; i < n; i++) ca.map(lines[i]!);
  const ms = performance.now() - t0;
  return { name: 'S2 adapter.map(kv)', ops: n, ms: Math.round(ms), opsPerSec: Math.round(n / (ms / 1000)) };
}

function main(): void {
  const quick = process.argv.includes('--quick');
  const scale = quick ? 0.25 : 1;
  const results = [benchRuleEngine(Math.round(200_000 * scale)), benchAdapter(Math.round(100_000 * scale))];
  for (const r of results) {
    console.log(
      `${r.name}: ops=${r.ops} ms=${r.ms} -> ${r.opsPerSec.toLocaleString('en-US')}/s` +
        (r.extra ? ` extra=${JSON.stringify(r.extra)}` : ''),
    );
  }
  console.log('(口径：确定性事件预生成，计时仅含喂入/求值热路径；单进程 Node，Linux 生产吞吐见 docs/performance.md)');
}

if (require.main === module) main();
