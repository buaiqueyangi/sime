import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RawBuilder, SelectQueryBuilder, sql } from 'kysely';
import { DB, PgProfileService } from '../common/pg-profile.service';
import { parseTs, SIME_DOMAINS, SimeDomain } from './event-normalizer';

/**
 * events 读路径：列表 / 单条 / 聚合。
 *
 * 默认只查最近 24h：events 是全平台最大的表（保留期 90 天），无时间条件的
 * 全表扫描在生产上是事故，不是功能。要查更早的数据必须显式给 from。
 */
export interface EventListQuery {
  from?: string;
  to?: string;
  domain?: string;
  category?: string;
  name?: string;
  source?: string;
  asset_id?: string;
  threat_id?: string;
  /** 常用字段过滤（与 q 里 "字段:值" 同一条件集，供 API 调用方显式传参） */
  src_ip?: string;
  dst_ip?: string;
  user?: string;
  process?: string;
  file?: string;
  host?: string;
  action?: string;
  outcome?: string;
  q?: string;
  limit?: number | string;
  offset?: number | string;
  order?: 'asc' | 'desc';
  count?: boolean | string;
}

const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const TS_OUT = sql<string>`to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as('ts');

export interface EventRow {
  id: string;
  ts: string;
  domain: string;
  category: string;
  name: string | null;
  source: string | null;
  src: unknown;
  dst: unknown;
  threat_id: string | null;
  payload: unknown;
}

export interface EventListResult {
  rows: EventRow[];
  limit: number;
  offset: number;
  window: { from: string; to: string };
  total?: number;
  ms: number;
}

type EvQB<O> = SelectQueryBuilder<DB, 'events', O>;

/**
 * 时间桶宽度解析：`interval` 来自查询串，必须只产出**数字**。
 *
 * 为什么不用 `date_trunc('15 minute', ts)`：PG 的 date_trunc 只接受单个 unit
 * （'hour' / 'day'），`'1 hour'` 会直接报 "unit not recognized"。而
 * `floor(epoch/secs)*secs` 对 15/30 分钟桶统一成立，也不必维护一堆分支。
 */
function bucketSecs(interval?: string): { secs: number; label: string } {
  const dflt = { secs: 3600, label: '1 hour' };
  const m = /^(\d{1,3})\s+(minute|hour|day)$/i.exec(String(interval ?? '').trim());
  if (!m) return dflt;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase() === 'minute' ? 60 : m[2]!.toLowerCase() === 'hour' ? 3600 : 86400;
  const secs = n * unit;
  // 60 秒 ~ 7 天：再小会把点打散，再大会让响应里的桶数没有意义
  if (!Number.isFinite(secs) || secs < 60 || secs > 7 * 86400) return dflt;
  return { secs, label: `${n} ${m[2]!.toLowerCase()}` };
}

@Injectable()
export class EventsService {
  constructor(private readonly pg: PgProfileService) {}

  private db() {
    const db = this.pg.database;
    if (!db) {
      // 明确报错而不是返回空列表：空列表会被误读成"没有事件"，排障方向直接跑偏
      throw new ServiceUnavailableException('存储未启用（缺少 SIME_PG_HOST 或初始化失败），events 不可查询');
    }
    return db;
  }

  /** 时间窗口：缺省最近 24h；to 缺省为当前时间。 */
  private window(q: { from?: string; to?: string }): { from: Date; to: Date } {
    const to = parseTs(q.to) ?? Date.now();
    const from = parseTs(q.from) ?? to - DEFAULT_WINDOW_MS;
    return { from: new Date(Math.min(from, to)), to: new Date(to) };
  }

  /** 统一过滤条件（列表与计数共用，避免两处条件写法漂移） */
  /** q 里允许的 "字段:值" 键集；不在集内的 token 一律当普通关键词。 */
  private static readonly Q_FIELDS = new Set([
    'name', 'category', 'source', 'domain', 'src', 'dst', 'src_ip', 'dst_ip',
    'user', 'process', 'file', 'host', 'asset', 'asset_id', 'threat', 'threat_id', 'action', 'outcome',
  ]);

  /** 解析 q：`src:10.0.0.8 -user:root 勒索 -"john doe"` → 字段条件/关键词，前缀 `-` 为排除。
   *  值含空格用双引号包住（字段:"两 个 词"）。 */
  private parseQ(q: string): {
    keywords: { v: string; not: boolean }[];
    fields: { key: string; v: string; not: boolean }[];
  } {
    const keywords: { v: string; not: boolean }[] = [];
    const fields: { key: string; v: string; not: boolean }[] = [];
    const tokens = q.trim().match(/-?[^\s"]+:"[^"]*"|-?"[^"]+"|-?\S+/g) ?? [];
    for (const tok0 of tokens) {
      let not = false;
      let tok = tok0;
      if (tok.length > 1 && tok.startsWith('-')) {
        not = true;
        tok = tok.slice(1);
      }
      const i = tok.indexOf(':');
      const key = i > 0 ? tok.slice(0, i).toLowerCase() : '';
      let val = i > 0 ? tok.slice(i + 1) : '';
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
      if (key && val && EventsService.Q_FIELDS.has(key)) fields.push({ key, v: val, not });
      else keywords.push({ v: tok.replace(/^"|"$/g, ''), not });
    }
    return { keywords, fields };
  }

  private filtered<O>(qb: EvQB<O>, q: EventListQuery, win: { from: Date; to: Date }): EvQB<O> {
    let b = qb.where('ts', '>=', win.from).where('ts', '<=', win.to);
    if (q.domain && (SIME_DOMAINS as readonly string[]).includes(q.domain)) {
      b = b.where('domain', '=', q.domain as SimeDomain);
    }
    if (q.category) b = b.where('category', '=', q.category);
    if (q.name) b = b.where('name', '=', q.name);
    if (q.source) b = b.where('source', '=', q.source);
    if (q.threat_id) b = b.where('threat_id', '=', q.threat_id);
    // 显式字段过滤：命中归一化列或 payload 内的 ECS 字段（模糊匹配，和 q 字段语法同一套语义）
    const explicit: { key: string; v: string; not: boolean }[] = [];
    if (q.src_ip) explicit.push({ key: 'src', v: q.src_ip, not: false });
    if (q.dst_ip) explicit.push({ key: 'dst', v: q.dst_ip, not: false });
    if (q.user) explicit.push({ key: 'user', v: q.user, not: false });
    if (q.process) explicit.push({ key: 'process', v: q.process, not: false });
    if (q.file) explicit.push({ key: 'file', v: q.file, not: false });
    if (q.host) explicit.push({ key: 'host', v: q.host, not: false });
    if (q.action) explicit.push({ key: 'action', v: q.action, not: false });
    if (q.outcome) explicit.push({ key: 'outcome', v: q.outcome, not: false });
    if (q.asset_id) explicit.push({ key: 'asset_id', v: q.asset_id, not: false });
    const parsed = q.q
      ? this.parseQ(q.q)
      : { keywords: [] as { v: string; not: boolean }[], fields: [] as { key: string; v: string; not: boolean }[] };
    for (const { key, v, not } of [...explicit, ...parsed.fields]) {
      const cond = this.fieldCond(key, v);
      if (cond) b = b.where(not ? sql<boolean>`not (${cond})` : cond);
    }
    if (parsed.keywords.length) {
      // 关键词：先用 ts 索引缩小范围再过滤；payload::text 兜底让任意深处的字段都能被
      // 搜到（字段要齐全），代价被时间窗口上界兜住。正排 AND（词内 OR），`-词` 排除。
      const orBranches = (kw: string) => {
        const like = `%${kw}%`;
        return sql<boolean>`(coalesce(name,'') ilike ${like} or category ilike ${like}
                     or coalesce(source,'') ilike ${like}
                     or coalesce(src->>'ip','') ilike ${like}
                     or coalesce(dst->>'ip','') ilike ${like}
                     or payload::text ilike ${like})`;
      };
      for (const { v, not } of parsed.keywords) {
        b = b.where(not ? sql<boolean>`not (${orBranches(v)})` : orBranches(v));
      }
    }
    return b;
  }

  /** 字段键 → 条件表达式（模糊匹配；asset 为精确匹配多路命中）。 */
  private fieldCond(key: string, val: string): RawBuilder<boolean> | null {
    const like = `%${val}%`;
    switch (key) {
      case 'name':
        return sql<boolean>`coalesce(name,'') ilike ${like}`;
      case 'category':
        return sql<boolean>`category ilike ${like}`;
      case 'source':
        return sql<boolean>`coalesce(source,'') ilike ${like}`;
      case 'domain':
        return (SIME_DOMAINS as readonly string[]).includes(val)
          ? sql<boolean>`domain = ${val}`
          : null;
      case 'src':
      case 'src_ip':
        return sql<boolean>`(coalesce(src->>'ip','') ilike ${like} or coalesce(src->>'host','') ilike ${like})`;
      case 'dst':
      case 'dst_ip':
        return sql<boolean>`coalesce(dst->>'ip','') ilike ${like}`;
      case 'user':
        return sql<boolean>`coalesce(payload->'user'->>'name','') ilike ${like}`;
      case 'process':
        return sql<boolean>`(coalesce(payload->'process'->>'name','') ilike ${like} or coalesce(payload->'process'->>'command_line','') ilike ${like})`;
      case 'file':
        return sql<boolean>`coalesce(payload->'file'->>'path','') ilike ${like}`;
      case 'host':
        return sql<boolean>`(coalesce(payload->'host'->>'name','') ilike ${like} or coalesce(src->>'host','') ilike ${like} or coalesce(dst->>'host','') ilike ${like})`;
      case 'asset':
      case 'asset_id':
        return sql<boolean>`(src->>'asset_id' = ${val} or src->'asset'->>'id' = ${val}
                       or dst->>'asset_id' = ${val} or dst->'asset'->>'id' = ${val})`;
      case 'threat':
      case 'threat_id':
        return sql<boolean>`coalesce(threat_id,'') ilike ${like}`;
      case 'action':
        return sql<boolean>`coalesce(payload->'event'->>'action','') ilike ${like}`;
      case 'outcome':
        return sql<boolean>`coalesce(payload->'event'->>'outcome','') ilike ${like}`;
      default:
        return null;
    }
  }

  /** 字段键 → 分面取值表达式（facets 用；只列有业务意义的键）。 */
  private facetExpr(key: string): RawBuilder<string> | null {
    switch (key) {
      case 'name':
        return sql<string>`nullif(name,'')`;
      case 'category':
        return sql<string>`nullif(category,'')`;
      case 'source':
        return sql<string>`nullif(source,'')`;
      case 'domain':
        return sql<string>`nullif(domain,'')`;
      case 'src':
        return sql<string>`nullif(src->>'ip','')`;
      case 'dst':
        return sql<string>`nullif(dst->>'ip','')`;
      case 'user':
        return sql<string>`nullif(payload->'user'->>'name','')`;
      case 'process':
        return sql<string>`nullif(payload->'process'->>'name','')`;
      case 'file':
        return sql<string>`nullif(payload->'file'->>'path','')`;
      case 'host':
        return sql<string>`coalesce(nullif(payload->'host'->>'name',''), nullif(src->>'host',''), nullif(dst->>'host',''))`;
      case 'asset':
        return sql<string>`coalesce(nullif(src->>'asset_id',''), nullif(dst->>'asset_id',''))`;
      case 'threat':
        return sql<string>`nullif(threat_id,'')`;
      case 'action':
        return sql<string>`nullif(payload->'event'->>'action','')`;
      case 'outcome':
        return sql<string>`nullif(payload->'event'->>'outcome','')`;
      default:
        return null;
    }
  }

  /** 字段值分布（分面）：当前过滤条件下该字段 top N 取值 + 计数，供点击字段弹出的"可选值"列表。 */
  async facets(q: EventListQuery & { field?: string; facet_limit?: number | string }): Promise<unknown> {
    const key = String(q.field ?? '').toLowerCase();
    const expr = this.facetExpr(key);
    if (!expr) {
      throw new BadRequestException(`不支持的分面字段: ${key}（可选 user/process/file/host/action/outcome/src/dst/category/source/domain/name/asset/threat）`);
    }
    const win = this.window(q);
    const limit = Math.min(Math.max(Math.trunc(Number(q.facet_limit) || 10), 1), 50);
    const db = this.db();
    const rows = (await (this.filtered(db.selectFrom('events') as unknown as EvQB<any>, q, win) as any)
      .where(sql`${expr} is not null`)
      .select([expr.as('value'), sql<number>`count(*)`.as('n')])
      .groupBy(expr)
      .orderBy(sql`count(*) desc`)
      .limit(limit)
      .execute()
      .then((rs: any[]) => rs.map((r) => ({ value: r.value, n: Number(r.n ?? 0) })))) as { value: string; n: number }[];
    return { field: key, rows };
  }

  async list(q: EventListQuery): Promise<EventListResult> {
    const db = this.db();
    const t0 = Date.now();
    const win = this.window(q);
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.trunc(Number(q.offset) || 0), 0);
    const desc = (q.order ?? 'desc') !== 'asc';

    const sel = this.filtered(
      db.selectFrom('events').select([
        sql<string>`id::text`.as('id'),
        TS_OUT,
        'domain',
        'category',
        'name',
        'source',
        'src',
        'dst',
        'threat_id',
        'payload',
      ]),
      q,
      win,
    );

    const rows = (await sel
      .orderBy('ts', desc ? 'desc' : 'asc')
      .orderBy('id', desc ? 'desc' : 'asc')
      .limit(limit)
      .offset(offset)
      .execute()) as unknown as EventRow[];

    const out: EventListResult = {
      rows,
      limit,
      offset,
      window: { from: win.from.toISOString(), to: win.to.toISOString() },
      ms: Date.now() - t0,
    };

    if (q.count === true || q.count === '1' || q.count === 'true') {
      const c = await this.filtered(
        db.selectFrom('events').select(sql<string>`count(*)`.as('n')),
        q,
        win,
      ).executeTakeFirst();
      out.total = Number((c as { n?: string } | undefined)?.n ?? 0);
    }
    return out;
  }

  async one(id: string): Promise<EventRow | null> {
    if (!/^\d{1,19}$/.test(id)) return null;
    const row = await this.db()
      .selectFrom('events')
      .select([
        sql<string>`id::text`.as('id'),
        TS_OUT,
        'domain',
        'category',
        'name',
        'source',
        'src',
        'dst',
        'threat_id',
        'payload',
      ])
      .where(sql<boolean>`id = ${id}::bigint`)
      .executeTakeFirst();
    return (row as unknown as EventRow) ?? null;
  }

  /**
   * 聚合视图：按类别 / 域 / 时间桶计数。三次聚合共用同一时间窗口，
   * 面板一次请求即可画出分布 + 趋势。
   */
  async stats(q: EventListQuery & { interval?: string }): Promise<unknown> {
    const db = this.db();
    const win = this.window(q);
    const { secs, label } = bucketSecs(q.interval);
    // 桶表达式**不能**用 $n 参数：PG 认为 GROUP BY 里的 $3 与 SELECT 里的 $1 不是同一个
    // 表达式，会报 "column events.ts must appear in the GROUP BY clause"（现网踩过）。
    // secs 由 bucketSecs 的白名单算式产出（纯数字），内联没有注入面。
    // 也不用 date_trunc('15 minute', ...)：PG 只认单个 unit，'1 hour' 这种写法直接报错，
    // 而 floor(epoch/secs)*secs 对 15 分钟/30 分钟桶统一成立。
    const bucketExpr = `to_timestamp(floor(extract(epoch from ts) / ${secs}) * ${secs})`;
    const bucket = sql.raw(bucketExpr);
    const bucketUtc = sql.raw(`(${bucketExpr} at time zone 'UTC')`);
    const scope = () => {
      let b = db.selectFrom('events').where('ts', '>=', win.from).where('ts', '<=', win.to);
      if (q.domain && (SIME_DOMAINS as readonly string[]).includes(q.domain)) {
        b = b.where('domain', '=', q.domain as SimeDomain);
      }
      if (q.category) b = b.where('category', '=', q.category);
      if (q.source) b = b.where('source', '=', q.source);
      return b;
    };

    const [totalRow, byCategory, byDomain, byBucket] = await Promise.all([
      scope().select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
      scope()
        .select(['category', 'domain', sql<string>`count(*)`.as('n')])
        .groupBy(['category', 'domain'])
        .orderBy(sql<string>`count(*)`, 'desc')
        .limit(Math.min(Math.max(Math.trunc(Number(q.limit) || 20), 1), 100))
        .execute(),
      scope().select(['domain', sql<string>`count(*)`.as('n')]).groupBy('domain').execute(),
      scope()
        .select(sql<string>`to_char(${bucketUtc}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as('bucket'))
        .select(sql<string>`count(*)`.as('n'))
        .groupBy(bucket as never)
        .orderBy(bucket as never, 'asc')
        .limit(2000)
        .execute(),
    ]);

    const withN = (rows: { n: string }[]) => rows.map((r) => ({ ...r, n: Number(r.n) }));
    return {
      window: { from: win.from.toISOString(), to: win.to.toISOString() },
      interval: label,
      total: Number((totalRow as { n?: string } | undefined)?.n ?? 0),
      byCategory: withN(byCategory as unknown as { n: string }[]),
      byDomain: withN(byDomain as unknown as { n: string }[]),
      byBucket: withN(byBucket as unknown as { n: string }[]),
    };
  }
}
