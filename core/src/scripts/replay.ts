import { readFileSync } from 'fs';
import { AssetRegistry } from '../common/registry';
import { RuleEngine, SimeRule } from '../rule-engine/rule-engine';

/** 回放 CLI：npm run replay -- <events.jsonl>  —— 事件经规则内核产出告警（开箱演示路径）。 */
const file = process.argv[2] ?? '../demo/out/security-events.jsonl';
const registry = new AssetRegistry(process.env.SIME_ASSET_ROOT ?? '..');
const defs = registry.load('rules').entries.map(({ data }) => data as unknown as SimeRule);
const engine = new RuleEngine(defs);

const events = readFileSync(file, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
events.sort((a, b) => Date.parse(String(a['@timestamp'])) - Date.parse(String(b['@timestamp'])));

let total = 0;
for (const ev of events) {
  const ts = Date.parse(String(ev['@timestamp']));
  for (const a of engine.feed(ev, Number.isNaN(ts) ? Date.now() : ts)) {
    total++;
    console.log(`[ALERT] ${a.id} ${a.severity.toUpperCase().padEnd(8)} ${a.ruleId}  group=${a.groupKey}`);
  }
}
console.log(`\nreplayed=${events.length} alerts=${total}`);
console.log('stats:', JSON.stringify(engine.stats()));
