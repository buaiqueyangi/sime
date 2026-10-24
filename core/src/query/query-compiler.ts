/**
 * SIME QL 编译器：AST → 参数化 SQL（蓝图 §4.2 / §5.6 的唯一查询入口）。
 *
 * 安全约束（三条铁律）：
 *  1. 只生成 SELECT；语句由本文件的固定模板拼装，任何用户输入都不会成为 SQL 片段；
 *  2. 所有字面量走 $n 参数，绝不字符串插值；
 *  3. 字段名必须命中所选数据源的 fields 白名单，标识符只取白名单里的值。
 *
 * 因此本模块不存在 SQL 注入面：用户能影响的只有"选哪个源、比哪些白名单字段、比什么值"。
 */
import { Agg, Expr, Lit, ParsedQuery, Stage } from './query-parser';

export interface SourceDef {
  /** 规范名（也是输出里的 source 字段） */
  name: string;
  aliases: string[];
  label: string;
  /** from 子句：固定模板，不含任何用户输入 */
  from: string;
  /** 白名单字段 → SQL 表达式（表达式本身写死在本文件） */
  fields: Record<string, string>;
  /** 不写 fields 时的默认投影 */
  defaultFields: string[];
  /** 默认排序用的时间列（须在 fields 的 key 中） */
  tsField?: string;
  /** 大数据量表：未带时间条件时给出性能提示 */
  large?: boolean;
  /** 数据源可用性说明（部分源依赖尚未落地的写入链路） */
  note?: string;
}

export interface CompiledQuery {
  text: string;
  params: unknown[];
  source: string;
  /** 结果列名（有序） */
  outputColumns: string[];
  /** 实际生效的 LIMIT（已按服务端上限截断） */
  limit: number;
  notes: string[];
}

export class QueryCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryCompileError';
  }
}

const SOURCE_LIST: SourceDef[] = [
  {
    name: 'alerts',
    aliases: ['alert'],
    label: '告警（左连规则名）',
    from: `(select a.id::text as id, a.ts, a.rule_id, r.name as rule_name, r.category as rule_category,
                    a.severity, a.domain, a.state,
                    a.entity->>'groupKey' as group_key,
                    (a.entity->>'hits')::int as hits,
                    a.summary
             from alerts a left join rules r on r.id = a.rule_id) alerts`,
    fields: {
      id: 'id',
      ts: 'ts',
      rule_id: 'rule_id',
      rule_name: 'rule_name',
      rule_category: 'rule_category',
      severity: 'severity',
      domain: 'domain',
      state: 'state',
      group_key: 'group_key',
      hits: 'hits',
      summary: 'summary',
    },
    defaultFields: ['ts', 'severity', 'rule_id', 'state', 'group_key', 'summary'],
    tsField: 'ts',
  },
  {
    name: 'events',
    aliases: ['event'],
    label: '原始事件（ECS 基线）',
    from: `(select id::text as id, ts, domain, category, name, source, threat_id,
                    src->>'ip' as src_ip,
                    coalesce(dst->>'asset_id', dst->'asset'->>'id', src->>'asset_id', src->'asset'->>'id') as asset_id,
                    dst->>'ip' as dst_ip,
                    coalesce(src->>'asset_id', src->'asset'->>'id') as src_asset_id,
                    coalesce(dst->>'asset_id', dst->'asset'->>'id') as dst_asset_id,
                    coalesce(payload->'event'->>'outcome', payload->>'outcome') as outcome,
                    coalesce(payload->'event'->>'action', payload->>'action') as action,
                    payload->>'severity' as severity
             from events) events`,
    fields: {
      id: 'id',
      ts: 'ts',
      domain: 'domain',
      category: 'category',
      name: 'name',
      source: 'source',
      threat_id: 'threat_id',
      asset_id: 'asset_id',
      src_ip: 'src_ip',
      src_asset_id: 'src_asset_id',
      dst_ip: 'dst_ip',
      dst_asset_id: 'dst_asset_id',
      outcome: 'outcome',
      action: 'action',
      severity: 'severity',
    },
    defaultFields: ['ts', 'domain', 'category', 'name', 'src_ip', 'dst_ip', 'outcome'],
    tsField: 'ts',
    large: true,
    note: '全平台最大的表（保留期 90 天）：查询请带 ts 条件，无时间条件即全表扫描。',
  },
  {
    name: 'telemetry',
    aliases: ['metrics'],
    label: '遥测明细',
    from: '(select asset_id, point, ts, value from telemetry) telemetry',
    fields: { asset_id: 'asset_id', point: 'point', ts: 'ts', value: 'value' },
    defaultFields: ['ts', 'asset_id', 'point', 'value'],
    tsField: 'ts',
    large: true,
  },
  {
    name: 'point_latest',
    aliases: ['latest'],
    label: '测点最新值',
    from: '(select asset_id, point, ts, value from point_latest) point_latest',
    fields: { asset_id: 'asset_id', point: 'point', ts: 'ts', value: 'value' },
    defaultFields: ['asset_id', 'point', 'ts', 'value'],
    tsField: 'ts',
  },
  {
    name: 'tickets',
    aliases: ['ticket'],
    label: '工单',
    from: '(select id::text as id, alert_id, title, state, assignee, created_at as ts, closed_at from tickets) tickets',
    fields: {
      id: 'id',
      alert_id: 'alert_id',
      title: 'title',
      state: 'state',
      assignee: 'assignee',
      ts: 'ts',
      closed_at: 'closed_at',
    },
    defaultFields: ['ts', 'id', 'title', 'state', 'assignee'],
    tsField: 'ts',
  },
  {
    name: 'notifications',
    aliases: ['notification'],
    label: '通知投递',
    from: '(select id::text as id, alert_id, channel, status, ts from notifications) notifications',
    fields: { id: 'id', alert_id: 'alert_id', channel: 'channel', status: 'status', ts: 'ts' },
    defaultFields: ['ts', 'channel', 'status', 'alert_id'],
    tsField: 'ts',
  },
  {
    name: 'audit',
    aliases: ['response_audit'],
    label: '响应审计',
    from: '(select id::text as id, alert_id, action, target, status, ts from response_audit) audit',
    fields: {
      id: 'id',
      alert_id: 'alert_id',
      action: 'action',
      target: 'target',
      status: 'status',
      ts: 'ts',
    },
    defaultFields: ['ts', 'action', 'target', 'status'],
    tsField: 'ts',
  },
  {
    name: 'playbook_runs',
    aliases: ['playbooks', 'runs'],
    label: '剧本执行记录',
    from: `(select id::text as id, playbook_id, alert_id, rule_id,
                    array_to_string(actions, ',') as actions, ts
             from playbook_runs) playbook_runs`,
    fields: {
      id: 'id',
      playbook_id: 'playbook_id',
      alert_id: 'alert_id',
      rule_id: 'rule_id',
      actions: 'actions',
      ts: 'ts',
    },
    defaultFields: ['ts', 'playbook_id', 'rule_id', 'actions'],
    tsField: 'ts',
  },
  {
    name: 'assets',
    aliases: ['asset'],
    label: '资产台账',
    from: '(select id, name, type, domain, thing_model, created_at as ts from assets) assets',
    fields: {
      id: 'id',
      name: 'name',
      type: 'type',
      domain: 'domain',
      thing_model: 'thing_model',
      ts: 'ts',
    },
    defaultFields: ['id', 'name', 'type', 'domain'],
    tsField: 'ts',
  },
  {
    name: 'devices',
    aliases: ['device'],
    label: '设备台账（含资产名）',
    from: `(select d.id, d.asset_id, a.name as asset_name, d.vendor, d.model,
                    d.online, d.last_seen_at as ts
             from devices d left join assets a on a.id = d.asset_id) devices`,
    fields: {
      id: 'id',
      asset_id: 'asset_id',
      asset_name: 'asset_name',
      vendor: 'vendor',
      model: 'model',
      online: 'online',
      ts: 'ts',
    },
    defaultFields: ['id', 'asset_name', 'vendor', 'model', 'online', 'ts'],
    tsField: 'ts',
  },
  {
    name: 'measure_points',
    aliases: ['points_meta'],
    label: '测点定义',
    from: '(select id, device_id, point_id, unit from measure_points) measure_points',
    fields: { id: 'id', device_id: 'device_id', point_id: 'point_id', unit: 'unit' },
    defaultFields: ['id', 'device_id', 'point_id', 'unit'],
  },
];

const BY_NAME = new Map<string, SourceDef>();
for (const s of SOURCE_LIST) {
  BY_NAME.set(s.name, s);
  for (const a of s.aliases) BY_NAME.set(a, s);
}

/** 字段名归一：忽略大小写、下划线与点，`ruleName` / `rule_name` / `src.ip` 均可命中 */
const norm = (s: string): string => s.toLowerCase().replace(/[_.]/g, '');

export const SOURCE_CATALOG = SOURCE_LIST.map((s) => ({
  name: s.name,
  aliases: s.aliases,
  label: s.label,
  fields: Object.keys(s.fields),
  defaultFields: s.defaultFields,
  large: Boolean(s.large),
  ...(s.note ? { note: s.note } : {}),
}));

export function resolveSource(name: string): SourceDef {
  const def = BY_NAME.get(name.toLowerCase());
  if (!def) {
    throw new QueryCompileError(
      `未知数据源 "${name}"；可用：${SOURCE_LIST.map((s) => s.name).join(' / ')}`,
    );
  }
  return def;
}

/** 单列：SQL 表达式 + 对外列名 */
interface Column {
  expr: string;
  name: string;
}

class Compiler {
  private readonly params: unknown[] = [];

  constructor(private readonly src: SourceDef) {}

  getParams(): unknown[] {
    return this.params;
  }

  private p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  /** 白名单 → SQL 表达式；未知字段直接拒绝 */
  field(name: string): string {
    const exact = this.src.fields[name];
    if (exact) return exact;
    const target = norm(name);
    for (const [k, v] of Object.entries(this.src.fields)) {
      if (norm(k) === target) return v;
    }
    throw new QueryCompileError(
      `字段 "${name}" 不属于数据源 ${this.src.name}；可用字段：${Object.keys(this.src.fields).join(', ')}`,
    );
  }

  /** 白名单 → 规范字段名（用于对外列名/别名匹配） */
  canonicalField(name: string): string {
    if (this.src.fields[name] !== undefined) return name;
    const target = norm(name);
    const hit = Object.keys(this.src.fields).find((k) => norm(k) === target);
    if (hit) return hit;
    this.field(name); // 未命中：抛出统一错误
    return name;
  }

  expr(e: Expr): string {
    switch (e.k) {
      case 'and':
        return `(${this.expr(e.l)} AND ${this.expr(e.r)})`;
      case 'or':
        return `(${this.expr(e.l)} OR ${this.expr(e.r)})`;
      case 'not':
        return `(NOT ${this.expr(e.e)})`;
      case 'cmp':
        return `(${this.expr(e.l)} ${e.op === '<>' ? '!=' : e.op} ${this.expr(e.r)})`;
      case 'in': {
        if (!e.list.length) throw new QueryCompileError('in 列表不能为空');
        const allNum = e.list.every((l) => l.k === 'num');
        const allStr = e.list.every((l) => l.k === 'str');
        if (!allNum && !allStr) {
          throw new QueryCompileError('in 列表元素类型必须一致（全数字或全字符串）');
        }
        const arr: (number | string)[] = e.list.map((l) =>
          allNum ? Number((l as Extract<Lit, { k: 'num' }>).v) : String((l as Extract<Lit, { k: 'str' }>).v),
        );
        const sql = `${this.expr(e.e)} = ANY(${this.p(arr)})`;
        return e.neg ? `(NOT ${sql})` : `(${sql})`;
      }
      case 'like': {
        const sql = `${this.expr(e.e)} ILIKE ${this.p(e.v)}`;
        return e.neg ? `(NOT ${sql})` : `(${sql})`;
      }
      case 'field':
        return this.field(e.name);
      case 'lit':
        return this.p(this.litValue(e.v));
      case 'time':
        if (e.offsetMs === 0) return 'now()';
        return `(now() - (${this.p(e.offsetMs)}::bigint * interval '1 millisecond'))`;
    }
  }

  private litValue(l: Lit): number | string {
    if (l.k === 'num') return l.v;
    if (l.k === 'str') return l.v;
    return l.ms;
  }

  /** where 里是否出现 ts 条件（用于大数据源性能提示） */
  hasTimePredicate(e: Expr | undefined): boolean {
    if (!e) return false;
    if (e.k === 'and' || e.k === 'or') return this.hasTimePredicate(e.l) || this.hasTimePredicate(e.r);
    if (e.k === 'not') return this.hasTimePredicate(e.e);
    if (e.k === 'cmp') {
      const l = e.l.k === 'field' ? norm(e.l.name) : '';
      const r = e.r.k === 'field' ? norm(e.r.name) : '';
      return l === 'ts' || r === 'ts';
    }
    if (e.k === 'in') return e.e.k === 'field' && norm(e.e.name) === 'ts';
    return false;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function aggSql(c: Compiler, a: Agg): string {
  switch (a.fn) {
    case 'count':
      return a.field ? `count(${c.field(a.field)})` : 'count(*)';
    case 'count_distinct':
      return `count(distinct ${c.field(a.field!)})`;
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return `${a.fn}(${c.field(a.field!)})`;
  }
}

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;

export interface CompileOptions {
  /** 未写 limit 时的默认值（默认 100） */
  defaultLimit?: number;
  /** 单次结果集上限（默认 1000；导出等受控场景可提高） */
  maxLimit?: number;
}

/**
 * 编译入口。
 *
 * 参数编号顺序 == SQL 里出现的顺序：先编译 where（唯一会产生参数的子句），
 * 再拼 select/group/order —— select 与 order 只含白名单标识符，不产生参数。
 */
export function compileQuery(parsed: ParsedQuery, opts: CompileOptions = {}): CompiledQuery {
  const src = resolveSource(parsed.source);
  const c = new Compiler(src);
  const notes: string[] = [];
  if (src.note) notes.push(src.note);

  const defaultLimit = Math.max(Math.trunc(opts.defaultLimit ?? DEFAULT_LIMIT), 1);
  const maxLimit = Math.max(Math.trunc(opts.maxLimit ?? MAX_LIMIT), 1);

  // ---- 1. 归并各 stage（顺序无关，where 用 AND 合并）----
  let where: Expr | undefined;
  let stats: Extract<Stage, { k: 'stats' }> | undefined;
  let sort: Extract<Stage, { k: 'sort' }> | undefined;
  let explicitFields: string[] | undefined;
  let limit: number | undefined;

  for (const st of parsed.stages) {
    switch (st.k) {
      case 'where':
        where = where ? { k: 'and', l: where, r: st.e } : st.e;
        break;
      case 'stats':
        if (stats) throw new QueryCompileError('stats 只能出现一次');
        stats = st;
        break;
      case 'sort':
        if (sort) throw new QueryCompileError('sort 只能出现一次');
        sort = st;
        break;
      case 'limit':
        if (limit !== undefined) throw new QueryCompileError('limit 只能出现一次');
        limit = st.n;
        break;
      case 'fields':
        if (explicitFields) throw new QueryCompileError('fields 只能出现一次');
        explicitFields = st.names;
        break;
    }
  }

  if (src.large && !c.hasTimePredicate(where)) {
    notes.push(`数据源 ${src.name} 数据量较大，建议加时间条件（如 ts > now() - 1h）`);
  }

  // ---- 2. 先编译 where（唯一产生参数的子句）----
  const whereSql = where ? ` where ${c.expr(where)}` : '';
  const groupBy: string[] = [];
  const cols: Column[] = [];

  // ---- 3. 投影 ----
  if (stats) {
    for (const f of stats.by) {
      const canonical = c.canonicalField(f);
      cols.push({ expr: c.field(canonical), name: canonical });
      groupBy.push(c.field(canonical));
    }
    for (const a of stats.aggs) {
      const name = a.as;
      if (cols.some((x) => norm(x.name) === norm(name))) {
        throw new QueryCompileError(`stats 输出列名重复："${name}"，请用 as 改名`);
      }
      cols.push({ expr: aggSql(c, a), name });
    }

    const projected = explicitFields
      ? explicitFields.map((f) => {
          const hit = cols.find((x) => norm(x.name) === norm(f));
          if (!hit) {
            throw new QueryCompileError(
              `fields 字段 "${f}" 不在 stats 输出列中：${cols.map((x) => x.name).join(', ')}`,
            );
          }
          return hit;
        })
      : cols;

    return finish(
      c, src, projected, groupBy, whereSql,
      resolveStatsOrderBy(cols, projected, sort), limit, notes, defaultLimit, maxLimit,
    );
  }

  const picked = explicitFields ? explicitFields.map((f) => c.canonicalField(f)) : src.defaultFields;
  for (const name of picked) cols.push({ expr: c.field(name), name });

  const orderBy = sort
    ? sort.keys
        .map((k) => {
          const canonical = c.canonicalField(k.field);
          return `${c.field(canonical)} ${k.desc ? 'desc' : 'asc'}`;
        })
        .join(', ')
    : src.tsField
      ? `${c.field(src.tsField)} desc`
      : undefined;

  return finish(c, src, cols, groupBy, whereSql, orderBy, limit, notes, defaultLimit, maxLimit);
}

/** stats 的 order by：优先输出列别名，回落到第一个 count 列降序（最符合 Top N 直觉） */
function resolveStatsOrderBy(
  allCols: Column[],
  projected: Column[],
  sort: Extract<Stage, { k: 'sort' }> | undefined,
): string | undefined {
  if (sort) {
    return sort.keys
      .map((k) => {
        const hit = projected.find((x) => norm(x.name) === norm(k.field));
        if (!hit) {
          throw new QueryCompileError(
            `sort 字段 "${k.field}" 不在输出列中：${projected.map((x) => x.name).join(', ')}`,
          );
        }
        return `${quoteIdent(hit.name)} ${k.desc ? 'desc' : 'asc'}`;
      })
      .join(', ');
  }
  const counted = allCols.find((x) => /^count/i.test(x.name));
  if (counted && projected.includes(counted)) return `${quoteIdent(counted.name)} desc`;
  return undefined;
}

function finish(
  c: Compiler,
  src: SourceDef,
  cols: Column[],
  groupBy: string[],
  whereSql: string,
  orderBy: string | undefined,
  limit: number | undefined,
  notes: string[],
  defaultLimit: number,
  maxLimit: number,
): CompiledQuery {
  if (!cols.length) throw new QueryCompileError('投影为空：请用 fields 指定至少一个字段');

  const requested = limit ?? defaultLimit;
  const cap = Math.min(Math.max(Math.trunc(requested), 1), maxLimit);
  if (requested > maxLimit) notes.push(`limit ${requested} 已截断为 ${maxLimit}（服务端上限）`);

  const selectSql = cols.map((x) => `${x.expr} as ${quoteIdent(x.name)}`).join(', ');
  const text =
    `select ${selectSql} from ${src.from}` +
    whereSql +
    (groupBy.length ? ` group by ${groupBy.join(', ')}` : '') +
    (orderBy ? ` order by ${orderBy}` : '') +
    ` limit ${cap}`;

  return {
    text,
    params: c.getParams(),
    source: src.name,
    outputColumns: cols.map((x) => x.name),
    limit: cap,
    notes,
  };
}
