import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import { AssetRegistry } from '../common/registry';

/** CI/本地资产校验入口：所有 YAML 必须通过 JSON Schema，否则 exit 1。 */
const root = process.env.SIME_ASSET_ROOT ?? '..';
const registry = new AssetRegistry(root);
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

// SOAR 剧本校验（templates/playbooks/*.yaml）
const ajv = new Ajv({ allErrors: true, strict: false });
const pbSchema = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'playbooks', 'schema.json'), 'utf8'));
const validatePb = ajv.compile(pbSchema);
const pbDir = path.join(root, 'templates', 'playbooks');
let pbOk = 0;
if (fs.existsSync(pbDir)) {
  for (const f of fs.readdirSync(pbDir).filter((x) => x.endsWith('.yaml') || x.endsWith('.yml')).sort()) {
    const full = path.join(pbDir, f);
    try {
      const data = yaml.load(fs.readFileSync(full, 'utf8'));
      if (!validatePb(data)) {
        failed++;
        const msg = (validatePb.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
        console.error(`  ✗ templates/playbooks/${f}: ${msg}`);
      } else pbOk++;
    } catch (e) {
      failed++;
      console.error(`  ✗ templates/playbooks/${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
console.log(`[playbooks] loaded=${pbOk} errors=${failed}`);

if (failed > 0) {
  console.error(`asset validation FAILED (${failed} error(s))`);
  process.exit(1);
}
console.log('asset validation passed');
