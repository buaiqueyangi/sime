import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';

/** 框架无关的资产注册器：core 服务、CI 校验、smoke 测试共用同一实现。 */

export type AssetKind = 'rules' | 'adapters' | 'thing-models';

export const KIND_DIRS: Record<AssetKind, string> = {
  rules: 'rules',
  adapters: 'adapters',
  'thing-models': path.join('templates', 'thing-model'),
};

export const KIND_SCHEMAS: Record<AssetKind, string> = {
  rules: path.join('rules', 'schema', 'rule.schema.json'),
  adapters: path.join('adapters', 'schema', 'adapter.schema.json'),
  'thing-models': path.join('templates', 'thing-model', 'schema.json'),
};

export interface AssetEntry {
  file: string;
  data: Record<string, unknown>;
}

export interface LoadResult {
  kind: AssetKind;
  entries: AssetEntry[];
  errors: { file: string; error: string }[];
}

function walkYaml(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkYaml(full));
    else if (/\.ya?ml$/i.test(name)) out.push(full);
  }
  return out.sort();
}

export class AssetRegistry {
  private ajv = new Ajv({ allErrors: true, strict: false });
  private cache = new Map<AssetKind, LoadResult>();

  constructor(private readonly assetRoot: string) {}

  load(kind: AssetKind, useCache = true): LoadResult {
    if (useCache && this.cache.has(kind)) return this.cache.get(kind)!;
    const dir = path.join(this.assetRoot, KIND_DIRS[kind]);
    const schemaFile = path.join(this.assetRoot, KIND_SCHEMAS[kind]);
    const validate = this.ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
    const result: LoadResult = { kind, entries: [], errors: [] };
    for (const file of walkYaml(dir)) {
      try {
        const data = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const rel = path.relative(this.assetRoot, file).replace(/\\/g, '/');
        if (!validate(data)) {
          const msg = (validate.errors ?? [])
            .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
            .join('; ');
          result.errors.push({ file: rel, error: msg });
          continue;
        }
        result.entries.push({ file: rel, data });
      } catch (e) {
        result.errors.push({ file: file, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.cache.set(kind, result);
    return result;
  }

  loadAll(): Record<AssetKind, LoadResult> {
    return {
      rules: this.load('rules'),
      adapters: this.load('adapters'),
      'thing-models': this.load('thing-models'),
    };
  }

  counts(): Record<AssetKind, number> {
    const all = this.loadAll();
    return {
      rules: all.rules.entries.length,
      adapters: all.adapters.entries.length,
      'thing-models': all['thing-models'].entries.length,
    };
  }

  totalErrors(): { file: string; error: string }[] {
    const all = this.loadAll();
    return [...all.rules.errors, ...all.adapters.errors, ...all['thing-models'].errors];
  }
}

export function registryFromEnv(): AssetRegistry {
  const root = process.env.SIME_ASSET_ROOT ?? '..';
  return new AssetRegistry(root);
}
