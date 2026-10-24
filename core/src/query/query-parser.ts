/**
 * SIME QL 解析器（自研，无 eval）。
 *
 * 语法（管道式，PPL 风格超集）：
 *   <source> | where <expr> | stats <agg> [by <field>] | sort <field> [desc] | limit <n> | fields <f1>,<f2>
 *
 * 示例：
 *   alerts | where severity in ("critical","high") and ts > now() - 24h | stats count() as c by rule_id | sort c desc | limit 10
 *   telemetry | where asset_id = "dev-meter-001" and point = "active_power" and ts > now() - 1h | stats avg(value) as avg_v by point
 *
 * 只做词法/语法分析，不接触数据库；字段合法性由 compiler 的源白名单校验。
 */

export interface Tok {
  t: 'id' | 'num' | 'str' | 'dur' | 'op' | 'punc' | 'pipe';
  v: string;
  n?: number;
  pos: number;
}

export type Lit =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'dur'; ms: number };

export type TimeExpr = { k: 'time'; offsetMs: number };

export type Expr =
  | { k: 'and'; l: Expr; r: Expr }
  | { k: 'or'; l: Expr; r: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'cmp'; op: string; l: Expr; r: Expr }
  | { k: 'in'; e: Expr; list: Lit[]; neg: boolean }
  | { k: 'like'; e: Expr; v: string; neg: boolean }
  | { k: 'field'; name: string }
  | { k: 'lit'; v: Lit }
  | TimeExpr;

export type Agg = {
  fn: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  as: string;
};

export type Stage =
  | { k: 'where'; e: Expr }
  | { k: 'stats'; aggs: Agg[]; by: string[] }
  | { k: 'sort'; keys: { field: string; desc: boolean }[] }
  | { k: 'limit'; n: number }
  | { k: 'fields'; names: string[] };

export interface ParsedQuery {
  source: string;
  stages: Stage[];
}

export class QuerySyntaxError extends Error {
  constructor(message: string, readonly pos?: number) {
    super(pos === undefined ? message : `${message}（位置 ${pos}）`);
    this.name = 'QuerySyntaxError';
  }
}

const DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { i = src.length; break; } // 行注释
    if (c === '|') { out.push({ t: 'pipe', v: '|', pos: i }); i++; continue; }

    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let v = '';
      while (j < src.length) {
        const d = src[j]!;
        if (d === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        // SQL 风格的双写转义：'it''s' → it's
        if (d === quote && src[j + 1] === quote) { v += quote; j += 2; continue; }
        if (d === quote) break;
        v += d; j++;
      }
      if (j >= src.length) throw new QuerySyntaxError('字符串未闭合', i);
      out.push({ t: 'str', v, pos: i });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      const numText = src.slice(i, j);
      const unit = (src[j] ?? '').toLowerCase();
      if (unit && DURATION_UNITS[unit] !== undefined && !/[A-Za-z0-9_]/.test(src[j + 1] ?? '')) {
        out.push({ t: 'dur', v: numText + unit, n: Number(numText) * DURATION_UNITS[unit]!, pos: i });
        i = j + 1;
      } else {
        out.push({ t: 'num', v: numText, n: Number(numText), pos: i });
        i = j;
      }
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '!=' || two === '<>') {
      out.push({ t: 'op', v: two, pos: i }); i += 2; continue;
    }
    if ('=><+-'.includes(c)) { out.push({ t: 'op', v: c, pos: i }); i++; continue; }
    if ('(),'.includes(c)) { out.push({ t: 'punc', v: c, pos: i }); i++; continue; }

    throw new QuerySyntaxError(`无法识别的字符 "${c}"`, i);
  }
  return out;
}

function splitStages(tokens: Tok[]): Tok[][] {
  const stages: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.t === 'punc' && t.v === '(') depth++;
    if (t.t === 'punc' && t.v === ')') depth--;
    if (depth < 0) throw new QuerySyntaxError('括号不匹配', t.pos);
    if (t.t === 'pipe' && depth === 0) { stages.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (depth !== 0) throw new QuerySyntaxError('括号不匹配');
  stages.push(cur);
  return stages;
}

class ExprParser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  peek(): Tok | undefined { return this.toks[this.i]; }
  next(): Tok | undefined { return this.toks[this.i++]; }
  eatPunc(v: string): boolean {
    const t = this.peek();
    if (t && t.t === 'punc' && t.v === v) { this.i++; return true; }
    return false;
  }
  expectEnd(): void {
    if (this.i !== this.toks.length) {
      throw new QuerySyntaxError(`多余的内容 "${this.toks[this.i]!.v}"`, this.toks[this.i]!.pos);
    }
  }
  isKeyword(v: string): boolean {
    const t = this.peek();
    return Boolean(t && t.t === 'id' && t.v.toLowerCase() === v);
  }
  eatKeyword(v: string): boolean {
    if (this.isKeyword(v)) { this.i++; return true; }
    return false;
  }

  parse(): Expr {
    const e = this.parseOr();
    this.expectEnd();
    return e;
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.eatKeyword('or')) l = { k: 'or', l, r: this.parseAnd() };
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseNot();
    while (this.eatKeyword('and')) l = { k: 'and', l, r: this.parseNot() };
    return l;
  }

  private parseNot(): Expr {
    if (this.eatKeyword('not')) return { k: 'not', e: this.parseNot() };
    return this.parseCmp();
  }

  private parseCmp(): Expr {
    const l = this.parseAdditive();
    const t = this.peek();
    if (!t) return l;

    if (t.t === 'op' && ['=', '!=', '<>', '>', '>=', '<', '<='].includes(t.v)) {
      this.i++;
      return { k: 'cmp', op: t.v, l, r: this.parseAdditive() };
    }
    if (this.isKeyword('in') || this.isKeyword('not')) {
      const neg = this.eatKeyword('not');
      if (neg && !this.eatKeyword('in')) throw new QuerySyntaxError('not 之后应为 in', t.pos);
      if (!neg) this.eatKeyword('in');
      if (!this.eatPunc('(')) throw new QuerySyntaxError('in 之后应为 (');
      const list: Lit[] = [];
      if (!this.peek() || this.peek()!.v !== ')') {
        for (;;) {
          list.push(this.parseLit());
          if (this.eatPunc(',')) continue;
          break;
        }
      }
      if (!this.eatPunc(')')) throw new QuerySyntaxError('in 列表缺少 )');
      return { k: 'in', e: l, list, neg };
    }
    if (this.isKeyword('like')) {
      this.i++;
      const s = this.next();
      if (!s || s.t !== 'str') throw new QuerySyntaxError('like 之后应为字符串');
      return { k: 'like', e: l, v: s.v, neg: false };
    }
    return l;
  }

  private parseAdditive(): Expr {
    let l = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op' || (t.v !== '+' && t.v !== '-')) break;
      this.i++;
      const r = this.parsePrimary();
      const lm = this.asTime(l);
      const rm = this.asTime(r);
      if (lm && rm) {
        l = { k: 'time', offsetMs: lm.offsetMs + (t.v === '-' ? rm.offsetMs : -rm.offsetMs) };
        continue;
      }
      // 时间 ± 持续时间：now() - 24h
      if (lm && r.k === 'lit' && r.v.k === 'dur') {
        l = { k: 'time', offsetMs: lm.offsetMs + (t.v === '-' ? r.v.ms : -r.v.ms) };
        continue;
      }
      throw new QuerySyntaxError('只支持时间表达式之间的加减', t.pos);
    }
    return l;
  }

  private asTime(e: Expr): TimeExpr | null {
    return e.k === 'time' ? e : null;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (!t) throw new QuerySyntaxError('表达式意外结束');
    if (t.t === 'punc' && t.v === '(') {
      const e = this.parseOr();
      if (!this.eatPunc(')')) throw new QuerySyntaxError('缺少 )', t.pos);
      return e;
    }
    if (t.t === 'num') return { k: 'lit', v: { k: 'num', v: t.n! } };
    if (t.t === 'str') return { k: 'lit', v: { k: 'str', v: t.v } };
    if (t.t === 'dur') return { k: 'lit', v: { k: 'dur', ms: t.n! } };
    if (t.t === 'id') {
      const lower = t.v.toLowerCase();
      if (lower === 'now') {
        if (!this.eatPunc('(') || !this.eatPunc(')')) throw new QuerySyntaxError('now 应为 now()', t.pos);
        return { k: 'time', offsetMs: 0 };
      }
      if (lower === 'true') return { k: 'lit', v: { k: 'str', v: 'true' } };
      if (lower === 'false') return { k: 'lit', v: { k: 'str', v: 'false' } };
      return { k: 'field', name: t.v };
    }
    throw new QuerySyntaxError(`意外的记号 "${t.v}"`, t.pos);
  }

  private parseLit(): Lit {
    const t = this.next();
    if (!t) throw new QuerySyntaxError('列表意外结束');
    if (t.t === 'num') return { k: 'num', v: t.n! };
    if (t.t === 'str') return { k: 'str', v: t.v };
    throw new QuerySyntaxError('列表元素只能是数字或字符串', t.pos);
  }
}

function parseStage(toks: Tok[], idx: number): Stage {
  const head = toks[0];
  if (!head || head.t !== 'id') throw new QuerySyntaxError(`第 ${idx} 段缺少命令名`);
  const cmd = head.v.toLowerCase();
  const rest = toks.slice(1);

  if (cmd === 'where') {
    return { k: 'where', e: new ExprParser(rest).parse() };
  }

  if (cmd === 'stats') {
    return parseStats(rest);
  }

  if (cmd === 'sort') {
    return parseSort(rest);
  }

  if (cmd === 'limit' || cmd === 'head') {
    const n = rest[0];
    if (!n || n.t !== 'num') throw new QuerySyntaxError(`${cmd} 之后应为数字`);
    if (rest.length > 1) throw new QuerySyntaxError(`${cmd} 参数过多`);
    const v = n.n!;
    if (!Number.isInteger(v) || v < 1) throw new QuerySyntaxError(`${cmd} 必须是 ≥ 1 的整数`);
    return { k: 'limit', n: v };
  }

  if (cmd === 'fields' || cmd === 'table') {
    const names = parseNameList(rest);
    if (!names.length) throw new QuerySyntaxError('fields 需要至少一个字段');
    return { k: 'fields', names };
  }

  throw new QuerySyntaxError(`未知命令 "${head.v}"（支持 where/stats/sort/limit/head/fields）`, head.pos);
}

function parseNameList(toks: Tok[]): string[] {
  const names: string[] = [];
  for (const t of toks) {
    if (t.t === 'punc' && t.v === ',') continue;
    if (t.t !== 'id') throw new QuerySyntaxError(`字段名不合法 "${t.v}"`, t.pos);
    names.push(t.v);
  }
  return names;
}

function parseStats(toks: Tok[]): Stage {
  const aggs: Agg[] = [];
  const by: string[] = [];
  let i = 0;
  let mode: 'agg' | 'by' = 'agg';

  while (i < toks.length) {
    const t = toks[i]!;
    if (t.t === 'punc' && t.v === ',') { i++; continue; }
    if (t.t === 'id' && t.v.toLowerCase() === 'by') { mode = 'by'; i++; continue; }

    if (mode === 'by') {
      if (t.t !== 'id') throw new QuerySyntaxError('by 之后应为字段名', t.pos);
      by.push(t.v);
      i++;
      continue;
    }

    if (t.t !== 'id') throw new QuerySyntaxError('stats 需要聚合函数', t.pos);
    const fnRaw = t.v.toLowerCase();
    const fn = (fnRaw === 'count_distinct' ? 'count_distinct' : fnRaw) as Agg['fn'];
    if (!['count', 'count_distinct', 'sum', 'avg', 'min', 'max'].includes(fn)) {
      throw new QuerySyntaxError(`不支持的聚合函数 "${t.v}"`, t.pos);
    }
    i++;
    if (!toks[i] || toks[i]!.v !== '(') throw new QuerySyntaxError(`${t.v} 之后应为 (`);
    i++;
    let field: string | undefined;
    if (toks[i] && toks[i]!.t === 'id') { field = toks[i]!.v; i++; }
    if (!toks[i] || toks[i]!.v !== ')') throw new QuerySyntaxError('聚合函数缺少 )');
    i++;
    if (fn !== 'count' && fn !== 'count_distinct' && !field) {
      throw new QuerySyntaxError(`${fn} 需要字段参数`);
    }

    let alias = field ? `${fn}_${field}` : fn;
    if (toks[i] && toks[i]!.t === 'id' && toks[i]!.v.toLowerCase() === 'as') {
      const a = toks[i + 1];
      if (!a || a.t !== 'id') throw new QuerySyntaxError('as 之后应为别名');
      alias = a.v;
      i += 2;
    }
    aggs.push({ fn, field, as: alias });
  }

  if (!aggs.length) throw new QuerySyntaxError('stats 需要至少一个聚合');
  return { k: 'stats', aggs, by };
}

function parseSort(toks: Tok[]): Stage {
  const keys: { field: string; desc: boolean }[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.t === 'punc' && t.v === ',') { i++; continue; }
    if (t.t !== 'id') throw new QuerySyntaxError('sort 需要字段名', t.pos);
    const field = t.v;
    i++;
    let desc = false;
    const d = toks[i];
    if (d && d.t === 'id') {
      const w = d.v.toLowerCase();
      if (w === 'desc') { desc = true; i++; }
      else if (w === 'asc') { i++; }
    }
    keys.push({ field, desc });
  }
  if (!keys.length) throw new QuerySyntaxError('sort 需要至少一个字段');
  return { k: 'sort', keys };
}

export function parseQuery(src: string): ParsedQuery {
  if (!src || !src.trim()) throw new QuerySyntaxError('查询为空');
  if (src.length > 4000) throw new QuerySyntaxError('查询过长（上限 4000 字符）');

  const stages = splitStages(tokenize(src)).filter((s) => s.length > 0);
  if (!stages.length) throw new QuerySyntaxError('查询为空');

  const head = stages[0]!;
  if (head.length !== 1 || head[0]!.t !== 'id') {
    throw new QuerySyntaxError('查询必须以数据源开头（alerts / events / telemetry / point_latest / tickets / notifications / audit / devices）');
  }

  return {
    source: head[0]!.v,
    stages: stages.slice(1).map((s, idx) => parseStage(s, idx + 1)),
  };
}
