/**
 * 适配库执行引擎 v2 —— compile-once 机制（docs/performance.md）：
 * 适配器定义（YAML）在加载时编译一次：kv 模板 → 正则、mapping → 解析器闭包数组；
 * 事件处理路径零模板解析、零正则重建。样例驱动回归照常强制（CI）。
 * 三层语义不变：parse（regex/json/kv）→ mapping（<捕获> / $.路径 / lookup: / 常量）
 * → normalize（值归一，支持 Nxx 通配）→ threat_map（厂商 ID → sime.tht.*）。
 */
import { getPath } from '../rule-engine/condition-evaluator';

export interface AdapterDef {
  id: string;
  vendor: string;
  product: string;
  protocol: string;
  parse: { format: 'regex' | 'json' | 'kv' | 'cef' | 'lef'; template?: string };
  mapping: Record<string, string>;
  threat_map?: Record<string, string>;
  normalize?: Record<string, Record<string, string>>;
  sample: string;
}

type Matcher = (raw: string) => Record<string, unknown>;
type Resolver = (parsed: Record<string, unknown>) => unknown;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(def: AdapterDef): Matcher {
  switch (def.parse.format) {
    case 'json':
      return (raw) => JSON.parse(raw) as Record<string, unknown>;
    case 'regex': {
      const re = new RegExp(def.parse.template!);
      return (raw) => {
        const m = re.exec(raw);
        if (!m?.groups) throw new Error('regex 未命中');
        return { ...m.groups };
      };
    }
    case 'kv': {
      // 模板 "k=<a> k2=<b>" → 每个占位符惰性匹配到下一个字面量键（值可含空格）；编译一次
      const parts: string[] = ['^'];
      let last = 0;
      const re = /<([A-Za-z_][A-Za-z0-9_]*)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(def.parse.template!))) {
        parts.push(escapeRe(def.parse.template!.slice(last, m.index)));
        parts.push(`(?<${m[1]}>.*?)`);
        last = m.index + m[0].length;
      }
      parts.push(escapeRe(def.parse.template!.slice(last)));
      parts.push('$');
      const kre = new RegExp(parts.join(''));
      return (raw) => {
        const km = kre.exec(raw.trim());
        if (!km?.groups) throw new Error('kv 模板未命中');
        return { ...km.groups };
      };
    }
    default:
      throw new Error(`v2 暂不支持格式 ${def.parse.format}`);
  }
}

function compileExpr(expr: string): Resolver {
  if (expr.startsWith('<') && expr.endsWith('>')) {
    const name = expr.slice(1, -1);
    return (parsed) => parsed[name];
  }
  if (expr.startsWith('$.')) {
    return (parsed) => getPath(parsed, expr.slice(2));
  }
  if (expr.startsWith('lookup:')) {
    const inner = compileExpr(expr.slice(7));
    return (parsed) => {
      const key = inner(parsed);
      return key === undefined ? undefined : String(key);
    };
  }
  return () => expr; // 常量
}

export interface CompiledAdapter {
  def: AdapterDef;
  parse(raw: string): Record<string, unknown>;
  map(raw: string): Record<string, unknown>;
}

export function compileAdapter(def: AdapterDef): CompiledAdapter {
  const matcher = buildMatcher(def);
  const resolvers = Object.entries(def.mapping).map(([target, expr]) => ({
    target,
    resolve: compileExpr(expr),
  }));
  const threatMap = def.threat_map;
  const normalize = def.normalize;

  function normalizeMatch(dict: Record<string, string>, raw: string): string | undefined {
    if (dict[raw] !== undefined) return dict[raw];
    for (const [k, v] of Object.entries(dict)) {
      const m = /^(\d)xx$/.exec(k);
      if (m && new RegExp(`^${m[1]}`).test(raw)) return v;
    }
    return undefined;
  }

  return {
    def,
    parse: matcher,
    map(raw: string): Record<string, unknown> {
      const parsed = matcher(raw);
      const out: Record<string, unknown> = {};
      for (const { target, resolve } of resolvers) {
        const v = resolve(parsed);
        if (v === undefined) continue;
        let s = String(v);
        if (target === 'sime.threat_id' && threatMap?.[s] !== undefined) {
          s = threatMap[s]!;
        } else if (normalize?.[target]) {
          s = normalizeMatch(normalize[target]!, s) ?? s;
        }
        out[target] = s;
      }
      return out;
    },
  };
}

/** 样例驱动回归：适配器必须能解析自己的 sample 并产出时间戳与事件类别。 */
export function sampleRegression(def: AdapterDef): { ok: boolean; error?: string } {
  try {
    const mapped = compileAdapter(def).map(def.sample);
    if (!mapped['@timestamp']) return { ok: false, error: '样例映射缺少 @timestamp' };
    if (!mapped['event.category']) return { ok: false, error: '样例映射缺少 event.category' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
