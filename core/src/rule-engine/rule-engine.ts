/**
 * 规则引擎内核 v2 —— 增量聚合机制（蓝图 §6.4，docs/performance.md）。
 *
 * 机制核心：事件到达时一次性更新每规则每分组的增量聚合桶（1 秒粒度），
 * 条件求值 O(1) 读总量，替代"每事件全窗口重扫"的 O(window) 模式：
 *   · count(pred)   → 事件到达即判定谓词，桶计数 +1，过期桶剪枝时回减；
 *   · count_distinct(path) → 桶级 Set，求值时合并活跃桶（常见仅 1 个，O(1)）；
 *   · sequence(...) → 事件驱动状态机逐步推进，替代全窗口贪心扫描；
 *   · 类别预过滤    → 由 AST 推导（仅合取链上的标量等值约束，保证不漏报），
 *                     不相关事件直接跳过规则；
 * 集群后端（Kafka/Flink）替换的是本文件的执行面，DSL 与告警契约不变。
 */
import { compileCondition, Node, durationMs } from './condition-parser';
import { evalCondition, evalScalar, getPath } from './condition-evaluator';

export interface SimeRule {
  id: string;
  name: string;
  severity: string;
  domain: string;
  status: string;
  detection: { source?: string; window?: string; group_by?: string[]; condition: string; except?: string };
  response: { default: string[]; escalate?: { when: string; do: string[] }[] };
  triage: string;
}

export interface SimeAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  domain: string;
  ts: string;
  groupKey: string;
  hits: number;
  actions: string[];
  summary: string;
}

type Agg = { kind: 'count'; pred?: Node } | { kind: 'distinct'; p: string };

interface CompiledRule {
  def: SimeRule;
  ast: Node; // 残余条件（聚合已改写为 aggref 槽位）
  windowMs: number;
  groupBy: string[];
  catFilter?: Set<string>;
  except?: Node;
  aggs: Agg[];
  nDistinct: number;
  seq?: { steps: Node[]; withinMs: number };
}

const BUCKET_MS = 1000;
const MAX_ALERTS = 1000;

/** 编译期改写：把 count()/count_distinct() 摘出为增量聚合槽位；sequence 仅允许作为整个条件。 */
function transform(n: Node, aggs: Agg[]): { node: Node; seq?: { steps: Node[]; withinMs: number } } {
  switch (n.k) {
    case 'or': case 'and': {
      const l = transform(n.l, aggs);
      const r = transform(n.r, aggs);
      if (l.seq || r.seq) throw new Error('sequence 仅允许作为整个条件（v2 限制）');
      return { node: { k: n.k, l: l.node, r: r.node } };
    }
    case 'not': {
      const e = transform(n.e, aggs);
      if (e.seq) throw new Error('sequence 不允许出现在 not 内');
      return { node: { k: 'not', e: e.node } };
    }
    case 'cmp': {
      const l = transform(n.l, aggs);
      const r = transform(n.r, aggs);
      if (l.seq || r.seq) throw new Error('sequence 不允许出现在比较内');
      return { node: { k: 'cmp', op: n.op, l: l.node, r: r.node } };
    }
    case 'in': {
      const e = transform(n.e, aggs);
      if (e.seq) throw new Error('sequence 不允许出现在 in 内');
      return { node: { k: 'in', e: e.node, list: n.list.map((x) => transform(x, aggs).node), neg: n.neg } };
    }
    case 'matches': return { node: { k: 'matches', e: transform(n.e, aggs).node, re: n.re } };
    case 'call': {
      if (n.name === 'count') {
        const i = aggs.length;
        aggs.push({ kind: 'count', pred: n.args[0] });
        return { node: { k: 'aggref', i } };
      }
      if (n.name === 'count_distinct') {
        const i = aggs.length;
        aggs.push({ kind: 'distinct', p: (n.args[0] as { p: string }).p });
        return { node: { k: 'aggref', i } };
      }
      return { node: n }; // 纯函数（time.in_shift/now）原样保留
    }
    case 'seq': return { node: { k: 'lit', v: true }, seq: { steps: n.steps, withinMs: n.withinMs } };
    default: return { node: n }; // lit/path
  }
}

/** 类别预过滤推导：返回 undefined = 放弃预过滤（不可靠或无约束）；非空集合 = 事件 category 必须在其中。
 *  语义保证：仅从"合取链上的标量 event.category 等值/in 约束"收集；含 or/not/seq 一律放弃，绝不漏报。 */
function extractCategoryFilter(n: Node): Set<string> | undefined {
  switch (n.k) {
    case 'and': {
      const l = extractCategoryFilter(n.l);
      const r = extractCategoryFilter(n.r);
      if (l === undefined || r === undefined) return undefined;
      const merged = new Set([...l, ...r]);
      return merged.size ? merged : undefined;
    }
    case 'cmp': {
      if (n.op === '==') {
        if (n.l.k === 'path' && n.l.p === 'event.category' && n.r.k === 'lit' && typeof n.r.v === 'string')
          return new Set([n.r.v]);
        if (n.r.k === 'path' && n.r.p === 'event.category' && n.l.k === 'lit' && typeof n.l.v === 'string')
          return new Set([n.l.v]);
      }
      return new Set(); // 与类别无关的子树：无约束（可合并）
    }
    case 'in': {
      if (!n.neg && n.e.k === 'path' && n.e.p === 'event.category' && n.list.every((x) => x.k === 'lit' && typeof (x as { v: unknown }).v === 'string'))
        return new Set(n.list.map((x) => (x as { v: string }).v));
      return new Set();
    }
    case 'or': case 'not': case 'seq': return undefined; // 结构上无法保证不漏报，放弃预过滤
    default: return new Set(); // lit/path/aggref/matches/call：无类别约束
  }
}

const EMPTY: number[] = [];

/** 每规则每分组的增量状态：桶计数 + 引用计数去重 + 序列状态机。
 *  count_distinct 机制：全局值引用计数表 + 桶级增量，剪枝回减，distinct 计数 O(1)。 */
class GroupState {
  totals: number[];
  buckets = new Map<number, number[]>();
  distinctGlobal: Map<string, number>[];
  distinctBuckets: Map<number, Map<string, number>>[];
  distinctAlive: number[];
  seqIdx = 0;
  seqFirstTs = 0;
  seqLastTs = 0;

  constructor(nAggs: number, distinctIndexes: number[]) {
    this.totals = new Array(nAggs).fill(0);
    const n = distinctIndexes.length;
    this.distinctGlobal = new Array(n);
    this.distinctBuckets = new Array(n);
    this.distinctAlive = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      this.distinctGlobal[i] = new Map();
      this.distinctBuckets[i] = new Map();
    }
  }

  pushIntoBucket(b: number): number[] {
    let d = this.buckets.get(b);
    if (!d) {
      d = new Array(this.totals.length).fill(0);
      this.buckets.set(b, d);
    }
    return d;
  }

  distinctAdd(idx: number, b: number, v: string): void {
    const g = this.distinctGlobal[idx]!;
    const c = (g.get(v) ?? 0) + 1;
    g.set(v, c);
    if (c === 1) this.distinctAlive[idx]!++;
    let bm = this.distinctBuckets[idx]!.get(b);
    if (!bm) {
      bm = new Map();
      this.distinctBuckets[idx]!.set(b, bm);
    }
    bm.set(v, (bm.get(v) ?? 0) + 1);
  }

  prune(cutoff: number): void {
    for (const [k, d] of this.buckets) {
      if (k >= cutoff) break; // Map 保持插入序（事件按时间到达）
      for (let i = 0; i < d.length; i++) this.totals[i]! -= d[i]!;
      this.buckets.delete(k);
      for (let idx = 0; idx < this.distinctBuckets.length; idx++) {
        const bm = this.distinctBuckets[idx]!.get(k);
        if (!bm) continue;
        const g = this.distinctGlobal[idx]!;
        for (const [v, c] of bm) {
          const left = g.get(v)! - c;
          if (left <= 0) {
            g.delete(v);
            this.distinctAlive[idx]!--;
          } else {
            g.set(v, left);
          }
        }
        this.distinctBuckets[idx]!.delete(k);
      }
    }
  }

  distinctCount(idx: number): number {
    return this.distinctAlive[idx]!;
  }
}

export class RuleEngine {
  readonly rules: CompiledRule[] = [];
  readonly alerts: SimeAlert[] = [];
  private states = new Map<string, Map<string, GroupState>>();
  private cooldown = new Map<string, number>();
  private seq = 0;

  constructor(ruleDefs: SimeRule[]) {
    for (const def of ruleDefs) {
      if (def.status === 'deprecated') continue;
      const aggs: Agg[] = [];
      const t = transform(compileCondition(def.detection.condition), aggs);
      const f = extractCategoryFilter(t.node);
      this.rules.push({
        def,
        ast: t.node,
        windowMs: durationMs(def.detection.window ?? '1m'),
        groupBy: def.detection.group_by ?? [],
        catFilter: f && f.size ? f : undefined,
        except: def.detection.except ? compileCondition(def.detection.except) : undefined,
        aggs,
        nDistinct: aggs.filter((a) => a.kind === 'distinct').length,
        seq: t.seq,
      });
    }
  }

  /** 喂入一条标准化事件（ECS 基线），返回本次新产出的告警。时间必须单调不回退。 */
  feed(event: Record<string, unknown>, tsMs: number): SimeAlert[] {
    const produced: SimeAlert[] = [];
    for (let ri = 0; ri < this.rules.length; ri++) {
      const rule = this.rules[ri]!;
      if (rule.except && evalScalar(rule.except, event)) continue;
      if (rule.catFilter) {
        const c = getPath(event, 'event.category');
        if (c !== undefined && !rule.catFilter.has(String(c))) continue;
      }
      const key = rule.groupBy.length
        ? rule.groupBy.map((p) => String(getPath(event, p) ?? 'null')).join('|')
        : '_all';
      let m = this.states.get(rule.def.id);
      if (!m) { m = new Map(); this.states.set(rule.def.id, m); }
      let st = m.get(key);
      if (!st) {
        st = new GroupState(rule.aggs.length, rule.aggs.flatMap((a, i) => (a.kind === 'distinct' ? [i] : [])));
        m.set(key, st);
      }

      const cutoff = tsMs - rule.windowMs;
      st.prune(cutoff);
      const b = Math.floor(tsMs / BUCKET_MS) * BUCKET_MS;
      const deltas = rule.aggs.length ? st.pushIntoBucket(b) : EMPTY;
      for (let i = 0; i < rule.aggs.length; i++) {
        const agg = rule.aggs[i]!;
        if (agg.kind === 'count') {
          if (!agg.pred || evalScalar(agg.pred, event)) {
            deltas[i]!++;
            st.totals[i]!++;
          }
        } else {
          const v = getPath(event, agg.p);
          if (v !== undefined) {
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            st.distinctAdd(aggIndex(rule, i), b, s);
          }
        }
      }

      // 序列状态机推进
      if (rule.seq) {
        if (st.seqIdx < rule.seq.steps.length && evalScalar(rule.seq.steps[st.seqIdx]!, event)) {
          if (st.seqIdx === 0) st.seqFirstTs = tsMs;
          st.seqLastTs = tsMs;
          st.seqIdx++;
        }
      }

      // 求值
      let hit: boolean;
      if (rule.seq) {
        hit = st.seqIdx >= rule.seq.steps.length && st.seqLastTs - st.seqFirstTs <= rule.seq.withinMs;
        if (hit) { st.seqIdx = 0; st.seqFirstTs = 0; } // 完成后复位，准备下一条序列
      } else {
        hit = evalCondition(rule.ast, {
          last: event,
          agg: (i) => {
            const agg = rule.aggs[i]!;
            return agg.kind === 'count' ? st!.totals[i]! : st!.distinctCount(aggIndex(rule, i));
          },
        });
      }
      if (!hit) continue;

      const cdKey = `${rule.def.id}|${key}`;
      const lastCd = this.cooldown.get(cdKey) ?? 0;
      if (tsMs - lastCd < rule.windowMs) continue; // 冷却期内去重
      this.cooldown.set(cdKey, tsMs);
      produced.push(this.emit(rule, key, tsMs));
    }
    return produced;
  }

  private emit(rule: CompiledRule, groupKey: string, tsMs: number): SimeAlert {
    this.seq++;
    const alert: SimeAlert = {
      id: `al-${String(this.seq).padStart(6, '0')}`,
      ruleId: rule.def.id,
      ruleName: rule.def.name,
      severity: rule.def.severity,
      domain: rule.def.domain,
      ts: new Date(tsMs).toISOString(),
      groupKey,
      hits: 0,
      actions: rule.def.response?.default ?? [],
      summary: rule.def.triage.trim().split('\n')[0]!.slice(0, 120),
    };
    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.shift();
    return alert;
  }

  stats() {
    const bySeverity: Record<string, number> = {};
    for (const a of this.alerts) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    return { rules: this.rules.length, alerts: this.alerts.length, bySeverity };
  }
}

function aggIndex(rule: CompiledRule, i: number): number {
  // distinct 聚合在 aggs 数组中的序号 → 在 distinct 数组中的序号（编译期顺序一致）
  let d = 0;
  for (let k = 0; k < i; k++) if (rule.aggs[k]!.kind === 'distinct') d++;
  return d;
}
