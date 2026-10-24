import { Injectable, Logger } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';
import { compileQuery, CompiledQuery, DEFAULT_LIMIT, MAX_LIMIT, QueryCompileError, SOURCE_CATALOG } from './query-compiler';
import { parseQuery, ParsedQuery, QuerySyntaxError, Stage } from './query-parser';

export interface QueryRunOptions {
  /** 服务端硬上限 MAX_LIMIT，这里只能往下压 */
  limit?: number;
  /** 单次查询的语句超时，默认 SIME_QL_TIMEOUT_MS / 15000 */
  timeoutMs?: number;
}

export interface QueryResult {
  ok: true;
  source: string;
  /** 编译产物（参数化 SQL），便于控制台排错；不含任何用户拼接片段 */
  sql: string;
  params: unknown[];
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  dbMs: number;
  totalMs: number;
  limit: number;
  notes: string[];
}

/** 查询语言侧的错误：语法/编译错与执行超时都归到这里，由控制器映射为 4xx */
export class SimeQLError extends Error {
  constructor(
    message: string,
    readonly kind: 'syntax' | 'compile' | 'timeout' | 'unavailable' | 'engine',
    readonly detail?: { pos?: number; sql?: string },
  ) {
    super(message);
    this.name = 'SimeQLError';
  }
}

@Injectable()
export class QueryService {
  private readonly logger = new Logger('SimeQL');
  private readonly timeoutMs: number;

  constructor(private readonly pg: PgProfileService) {
    const raw = Number(process.env.SIME_QL_TIMEOUT_MS ?? 15_000);
    this.timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 120_000) : 15_000;
  }

  /** 数据源目录：控制台据此做语法高亮/字段补全 */
  catalog() {
    return {
      language: 'SIME QL',
      version: '1.0',
      limits: { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT, timeoutMs: this.timeoutMs },
      grammar:
        '<source> [| where <expr>] [| stats <agg>[, <agg>...] [by <field>[, <field>...]]] ' +
        '[| sort <field> [asc|desc][, ...]] [| limit <n>] [| fields <f1>[, <f2>...]]',
      operators: ['=', '!=', '<>', '>', '>=', '<', '<=', 'in', 'not in', 'like', 'and', 'or', 'not'],
      timeFunctions: ['now()', 'now() - 24h', 'now() - 30m', 'now() - 7d'],
      aggregateFunctions: ['count()', 'count(field)', 'count_distinct(field)', 'sum', 'avg', 'min', 'max'],
      sources: SOURCE_CATALOG,
      examples: [
        'alerts | where severity in ("critical","high") and ts > now() - 24h | stats count() as c by rule_id | sort c desc | limit 10',
        'alerts | where state = "open" | stats count() as open_cnt by severity',
        'telemetry | where asset_id = "dev-meter-001" and point = "active_power" and ts > now() - 1h | stats avg(value) as avg_v, max(value) as max_v by point',
        'point_latest | where point like "%power%" | sort value desc | limit 20',
        'audit | where status = "simulated" and ts > now() - 7d | stats count() as n by action | sort n desc',
        'devices | where online = false | fields id, asset_name, vendor, model, ts | limit 50',
      ],
    };
  }

  /** 只编译不执行：给控制台做即时校验 */
  validate(q: string): { ok: true; sql: string; params: unknown[]; columns: string[]; notes: string[] } {
    const compiled = this.compile(q);
    return {
      ok: true,
      sql: compiled.text,
      params: compiled.params,
      columns: compiled.outputColumns,
      notes: compiled.notes,
    };
  }

  async run(q: string, opts: QueryRunOptions = {}): Promise<QueryResult> {
    const t0 = Date.now();
    if (!this.pg.ready) {
      throw new SimeQLError(
        '查询引擎不可用：当前是内存模式（未配置 SIME_PG_HOST 或 PG 初始化失败），SIME QL 只在 pg-profile 下生效',
        'unavailable',
      );
    }

    const compiled = this.compile(q, opts.limit);
    // 纵深防御：编译器只会产出 SELECT，这里再卡一次，避免未来改动引入写入
    if (!/^\s*select\s/i.test(compiled.text)) {
      throw new SimeQLError('内部错误：编译产物不是 SELECT，已拒绝执行', 'engine');
    }

    try {
      const res = await this.pg.queryReadonly<Record<string, unknown>>(
        compiled.text,
        compiled.params,
        opts.timeoutMs ?? this.timeoutMs,
      );
      const totalMs = Date.now() - t0;
      this.logger.log(
        `source=${compiled.source} rows=${res.rows.length} db=${res.ms}ms total=${totalMs}ms :: ${q.length > 160 ? q.slice(0, 160) + '…' : q}`,
      );
      return {
        ok: true,
        source: compiled.source,
        sql: compiled.text,
        params: compiled.params,
        columns: compiled.outputColumns,
        rows: res.rows,
        rowCount: res.rows.length,
        dbMs: res.ms,
        totalMs,
        limit: compiled.limit,
        notes: compiled.notes,
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === '57014') {
        throw new SimeQLError(
          `查询超时（超过 ${Math.round((opts.timeoutMs ?? this.timeoutMs) / 1000)}s）。请缩小时间范围（如 ts > now() - 1h）或加更精确的过滤条件`,
          'timeout',
          { sql: compiled.text },
        );
      }
      // 42xxx = 语法/语义错误：说明白名单字段与实际列有偏差，属于部署问题
      throw new SimeQLError(`查询执行失败：${msg}`, 'engine', { sql: compiled.text });
    }
  }

  private compile(q: string, limitOverride?: number): CompiledQuery {
    let parsed: ParsedQuery;
    try {
      parsed = parseQuery(q ?? '');
    } catch (e) {
      if (e instanceof QuerySyntaxError) throw new SimeQLError(e.message, 'syntax', { pos: e.pos });
      throw e;
    }

    // 调用方给的 limit 只能收紧、不能放宽：先摘掉查询里原有的 limit，再用调用方的值补一条
    if (limitOverride !== undefined && Number.isFinite(limitOverride)) {
      const n = Math.min(Math.max(Math.trunc(limitOverride), 1), MAX_LIMIT);
      const stages: Stage[] = parsed.stages.filter((s) => s.k !== 'limit');
      stages.push({ k: 'limit', n });
      parsed = { source: parsed.source, stages };
    }

    try {
      return compileQuery(parsed);
    } catch (e) {
      if (e instanceof QueryCompileError) throw new SimeQLError(e.message, 'compile');
      throw e;
    }
  }
}
