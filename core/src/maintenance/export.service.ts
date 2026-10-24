import { Injectable, Logger } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';
import { compileQuery, SOURCE_CATALOG } from '../query/query-compiler';
import { parseQuery } from '../query/query-parser';
import { RetentionService } from './retention.service';

/**
 * 导出（P0）。
 *
 * 复用 SIME QL 的解析/编译链路 → 导出与查询是同一门语言、同一套字段白名单，
 * 不会出现"查询能看到、导出导不出"的口径分裂。
 *
 * 与 `/query` 的区别只有一个：LIMIT 上限从 1000 提到 `SIME_EXPORT_MAX_ROWS`（默认 20 万），
 * 并用 **分页流式** 输出，内存占用与结果集大小无关。
 */

export type ExportFormat = 'csv' | 'jsonl';

export interface ExportOptions {
  format?: ExportFormat;
  /** 覆盖导出上限（只能往下压） */
  maxRows?: number;
  /** 每页取多少行 */
  pageSize?: number;
}

export interface ExportSummary {
  source: string;
  format: ExportFormat;
  columns: string[];
  rows: number;
  pages: number;
  truncated: boolean;
  ms: number;
  bytes: number;
}

const IDENT_OK = /^[A-Za-z0-9_.-]+$/;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** CSV 单元格转义：含分隔符/引号/换行才加引号，内部引号双写 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function jsonCell(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v));
}

export function pickFilename(source: string, format: ExportFormat, at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  const safe = IDENT_OK.test(source) ? source : 'sime';
  return `sime-${safe}-${stamp}.${format === 'csv' ? 'csv' : 'jsonl'}`;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger('Export');
  private readonly maxRowsDefault = Math.min(envInt('SIME_EXPORT_MAX_ROWS', 200_000), 1_000_000);
  private readonly pageSizeDefault = Math.min(envInt('SIME_EXPORT_PAGE', 5_000), 20_000);
  private readonly deadlineMs = envInt('SIME_EXPORT_DEADLINE_MS', 300_000);

  constructor(
    private readonly pg: PgProfileService,
    private readonly retention: RetentionService,
  ) {}

  catalog() {
    return {
      formats: ['csv', 'jsonl'] as ExportFormat[],
      maxRows: this.maxRowsDefault,
      pageSize: this.pageSizeDefault,
      deadlineMs: this.deadlineMs,
      sources: SOURCE_CATALOG.map((s) => s.name),
      note:
        '导出复用 SIME QL：`q` 与 /api/v1/query 完全同语法。未写 limit 时上限为 maxRows；' +
        '写了 limit 则按 limit 导。CSV 带 UTF-8 BOM（Excel 直接双击不乱码）。',
    };
  }

  /**
   * 流式导出。`write` 返回 Promise 以便正确处理背压。
   * 不缓冲整个结果集：每页 5000 行取完即写，写完即丢。
   */
  async stream(
    q: string,
    format: ExportFormat,
    write: (chunk: string) => Promise<void>,
    opts: ExportOptions = {},
  ): Promise<ExportSummary> {
    if (!this.pg.ready) throw new Error('导出不可用：当前是内存模式（未配置 SIME_PG_HOST）');

    const t0 = Date.now();
    const maxRows = Math.min(opts.maxRows ?? this.maxRowsDefault, this.maxRowsDefault);
    const pageSize = Math.max(1, Math.min(opts.pageSize ?? this.pageSizeDefault, maxRows));

    const parsed = parseQuery(q ?? '');
    const explicitLimit = parsed.stages.some((s) => s.k === 'limit');
    const compiled = compileQuery(
      parsed,
      explicitLimit ? { maxLimit: maxRows } : { defaultLimit: maxRows, maxLimit: maxRows },
    );
    // 行数预算：写了 limit 就按 limit，没写就按导出上限。
    // 分页会把语句自带的 limit 摘掉，所以预算必须在这里单独记住，否则会把整张表导出去。
    const budget = Math.min(compiled.limit, maxRows);

    // 分页必须真正下推：先摘掉编译产物自带的 `limit N`，再按页拼 `limit take offset k`。
    // 否则第一页就会把整张结果集读进内存，"流式"名存实亡。
    const noLimit = compiled.text.replace(/\s+limit\s+\d+\s*$/i, '');
    // 分页要有稳定顺序：查询本身没写 order by 时补一个（列 1 通常是有序主键/时间列）
    const hasOrder = /\border\s+by\b/i.test(noLimit);
    const baseSql = hasOrder ? noLimit : `${noLimit} order by 1`;

    const columns = compiled.outputColumns;
    const fmt = format === 'csv' ? 'csv' : 'jsonl';
    let rows = 0;
    let pages = 0;
    let bytes = 0;
    let truncated = false;

    const emit = async (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      await write(chunk);
    };

    if (fmt === 'csv') await emit(`\ufeff${columns.map(csvCell).join(',')}\r\n`);

    for (;;) {
      if (rows >= budget) {
        truncated = true;
        break;
      }
      if (Date.now() - t0 > this.deadlineMs) {
        truncated = true;
        this.logger.warn(`export ${compiled.source} 超过时间预算，已截断于 ${rows} 行`);
        break;
      }

      const take = Math.min(pageSize, budget - rows);
      const pageSql = `${baseSql} limit ${take} offset ${rows}`;
      const page = await this.pg.queryReadonly<Record<string, unknown>>(
        pageSql,
        compiled.params,
        Math.min(this.deadlineMs, 60_000),
      );
      pages++;

      if (page.rows.length === 0) break;

      const buf: string[] = [];
      for (const row of page.rows) {
        if (rows >= budget) {
          truncated = true;
          break;
        }
        buf.push(fmt === 'csv' ? columns.map((c) => csvCell(row[c])).join(',') : jsonCell(row));
        rows++;
      }
      if (buf.length) await emit(buf.join(fmt === 'csv' ? '\r\n' : '\n') + (fmt === 'csv' ? '\r\n' : '\n'));

      if (page.rows.length < take) break;
    }

    // 恰好导满 maxRows 时无法判断"真的没了"还是"被截断"——补一次探测，避免误报
    if (truncated && rows === budget) {
      try {
        const probe = await this.pg.queryReadonly(
          `${baseSql} limit 1 offset ${rows}`,
          compiled.params,
          15_000,
        );
        if (probe.rows.length === 0) truncated = false;
      } catch {
        /* 探测失败不影响已导出的内容，保守保留 truncated=true */
      }
    }

    const ms = Date.now() - t0;
    this.logger.log(
      `export source=${compiled.source} format=${fmt} rows=${rows} pages=${pages} ${ms}ms truncated=${truncated}`,
    );
    void this.retention
      .recordExport(
        compiled.source,
        rows,
        ms,
        truncated ? 'partial' : 'ok',
        `${fmt} rows=${rows} pages=${pages} truncated=${truncated} q=${q.slice(0, 120)}`,
      )
      .catch(() => undefined);

    return { source: compiled.source, format: fmt, columns, rows, pages, truncated, ms, bytes };
  }
}
