/**
 * 条件求值器 v2 —— 机制级优化（蓝图 §6.4 / docs/performance.md）：
 * 1. 点路径分词缓存：getPath 不再逐次 split（规则路径集合有限，命中缓存后零分配）；
 * 2. 聚合与标量分离：count()/count_distinct() 在编译期被改写为 aggref 槽位，
 *    由 rule-engine 的增量桶聚合供值（O(1)），求值器只做纯标量布尔运算；
 * 3. 全程无 eval/new Function，无正则回溯风险的正则来自规则编译期检查。
 */
import { Node } from './condition-parser';

export interface WindowEntry {
  e: Record<string, unknown>;
  ts: number;
}

const pathCache = new Map<string, string[]>();

function tokens(p: string): string[] {
  let t = pathCache.get(p);
  if (!t) {
    t = p.split('.');
    pathCache.set(p, t);
  }
  return t;
}

export function getPath(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  const t = tokens(p);
  for (let i = 0; i < t.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[t[i]!];
  }
  return cur;
}

export interface EvalCtx {
  last: Record<string, unknown>;
  /** 增量聚合槽位取值（由 GroupState 提供，O(1)） */
  agg: (i: number) => number;
}

/** 标量求值（单事件上下文）：sequence 步骤、except 子句、count() 内部谓词。 */
export function evalScalar(n: Node, event: Record<string, unknown>): boolean {
  switch (n.k) {
    case 'or': return evalScalar(n.l, event) || evalScalar(n.r, event);
    case 'and': return evalScalar(n.l, event) && evalScalar(n.r, event);
    case 'not': return !evalScalar(n.e, event);
    case 'cmp': return compare(valueScalar(n.l, event), n.op, valueScalar(n.r, event));
    case 'in': {
      const v = valueScalar(n.e, event);
      const arr = n.list.length === 1 && n.list[0].k === 'path'
        ? valueScalar(n.list[0], event)
        : n.list.map((x) => valueScalar(x, event));
      if (!Array.isArray(arr)) return false; // 右侧集合缺失：一律不命中（NOT IN 不许在不可求值时误报）
      const hit = arr.includes(v);
      return n.neg ? !hit : hit;
    }
    case 'matches': {
      const v = valueScalar(n.e, event);
      return typeof v === 'string' && n.re.test(v);
    }
    case 'call': return plainCall(n) === true;
    case 'lit': return Boolean(n.v);
    case 'path': return Boolean(getPath(event, n.p));
    default: return false; // aggref/seq 不出现在标量上下文
  }
}

function valueScalar(n: Node, event: Record<string, unknown>): unknown {
  if (n.k === 'lit') return n.v;
  if (n.k === 'path') return getPath(event, n.p);
  if (n.k === 'call') return plainCall(n);
  throw new Error(`标量上下文不支持节点 ${n.k}`);
}

function plainCall(n: Node & { k: 'call' }): unknown {
  if (n.name === 'time.in_shift') return false; // v0 桩：默认非值班窗口，v1 接班组/排班元数据
  if (n.name === 'now') return Date.now();
  throw new Error(`标量上下文不支持函数 ${n.name}`);
}

function compare(l: unknown, op: string, r: unknown): boolean {
  if (l == null || r == null) return false;
  if (typeof l === 'number' && typeof r === 'number' && !Number.isFinite(l - r)) return false;
  switch (op) {
    case '==':
      return l === r || (typeof l !== 'object' && typeof r !== 'object' && String(l) === String(r));
    case '!=': return !compare(l, '==', r);
    case '>': return l > r; case '<': return l < r;
    case '>=': return l >= r; case '<=': return l <= r;
    default: throw new Error(`未知比较符 ${op}`);
  }
}

/** 条件主体求值：聚合经由 ctx.agg 增量供值（O(1)），不再扫描窗口。 */
export function evalCondition(n: Node, ctx: EvalCtx): boolean {
  switch (n.k) {
    case 'or': return evalCondition(n.l, ctx) || evalCondition(n.r, ctx);
    case 'and': return evalCondition(n.l, ctx) && evalCondition(n.r, ctx);
    case 'not': return !evalCondition(n.e, ctx);
    case 'cmp': return compare(evalValue(n.l, ctx), n.op, evalValue(n.r, ctx));
    case 'in': {
      const v = evalValue(n.e, ctx);
      const arr = n.list.length === 1 && n.list[0].k === 'path'
        ? evalValue(n.list[0], ctx)
        : n.list.map((x) => evalValue(x, ctx));
      if (!Array.isArray(arr)) return false;
      const hit = arr.includes(v);
      return n.neg ? !hit : hit;
    }
    case 'matches': {
      const v = evalValue(n.e, ctx);
      return typeof v === 'string' && n.re.test(v);
    }
    case 'aggref': return ctx.agg(n.i) > 0;
    case 'call': {
      if (n.name === 'time.in_shift') return false;
      if (n.name === 'now') return true;
      throw new Error(`条件主体不支持函数 ${n.name}`);
    }
    case 'path': return Boolean(getPath(ctx.last, n.p));
    case 'lit': return Boolean(n.v);
    default: return false;
  }
}

function evalValue(n: Node, ctx: EvalCtx): unknown {
  if (n.k === 'lit') return n.v;
  if (n.k === 'path') return getPath(ctx.last, n.p);
  if (n.k === 'aggref') return ctx.agg(n.i);
  if (n.k === 'call') {
    if (n.name === 'time.in_shift') return false;
    if (n.name === 'now') return Date.now();
    throw new Error(`条件主体不支持函数 ${n.name}`);
  }
  throw new Error(`聚合上下文不支持节点 ${n.k}`);
}
