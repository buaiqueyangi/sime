import { AssetRegistry } from '../common/registry';

/** CI/本地资产校验入口：所有 YAML 必须通过 JSON Schema，否则 exit 1。 */
const registry = new AssetRegistry(process.env.SIME_ASSET_ROOT ?? '..');
const all = registry.loadAll();
let failed = 0;
for (const [kind, result] of Object.entries(all)) {
  const errors = result.errors;
  console.log(`[${kind}] loaded=${result.entries.length} errors=${errors.length}`);
  for (const e of errors) {
    failed++;
    console.error(`  ✗ ${e.file}: ${e.error}`);
  }
}
if (failed > 0) {
  console.error(`asset validation FAILED (${failed} error(s))`);
  process.exit(1);
}
console.log('asset validation passed');
