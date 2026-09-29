import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as duckdb from 'duckdb';
import { PgProfileService } from '../common/pg-profile.service';

/**
 * 数据湖服务（M3，蓝图 §6.2/§6.3）：内嵌 DuckDB + Parquet 冷数据快照。
 * 快照 = PG 最近 24h 的 telemetry/alerts → DuckDB → Parquet（zstd）落 SIME_LAKE_DIR；
 * 分析查询 = 受限只读 SQL 直接跑 Parquet（免 Spark 集群的轻量湖仓，M3 核心思路）。
 * 存储升级路线：SIME_LAKE_DIR 指向 MinIO 挂载即对象存储化（M3.5）。
 */
interface DuckResult {
  rows: Record<string, unknown>[];
}

@Injectable()
export class LakeService implements OnModuleInit {
  private readonly logger = new Logger('Lake');
  private db?: duckdb.Database;
  private con?: duckdb.Connection;
  private lakeDir = process.env.SIME_LAKE_DIR ?? path.join('data', 'lake');
  private lastSnapshot: { sid: string; files: { file: string; bytes: number }[]; tookMs: number } | null = null;
  private available = true;

  constructor(private readonly pg: PgProfileService) {}

  onModuleInit(): void {
    try {
      fs.mkdirSync(this.lakeDir, { recursive: true });
      this.db = new duckdb.Database(path.join(this.lakeDir, 'lake.duckdb'));
      this.con = this.db.connect();
      this.logger.log(`lake ready: ${this.lakeDir}`);
    } catch (e) {
      this.available = false;
      this.logger.warn(`lake init failed（数据湖功能降级）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private all(sqlText: string): Promise<DuckResult['rows']> {
    return new Promise((resolve, reject) => {
      if (!this.con) return reject(new Error('duckdb 不可用'));
      this.con.all(sqlText, (err, rows) => (err ? reject(new Error(err.message)) : resolve(rows ?? [])));
    });
  }

  private run(sqlText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.con) return reject(new Error('duckdb 不可用'));
      this.con.run(sqlText, (err) => (err ? reject(new Error(err.message)) : resolve()));
    });
  }

  status() {
    const files: { file: string; bytes: number }[] = [];
    try {
      for (const f of fs.readdirSync(this.lakeDir).filter((x) => x.endsWith('.parquet'))) {
        files.push({ file: f, bytes: fs.statSync(path.join(this.lakeDir, f)).size });
      }
    } catch { /* 目录尚未创建 */ }
    return {
      available: this.available,
      lakeDir: this.lakeDir,
      lastSnapshot: this.lastSnapshot,
      files,
    };
  }

  /** 快照：PG 最近 24h → DuckDB → Parquet（同路径覆盖，保持"最新快照"语义）。 */
  async snapshot(): Promise<{ sid: string; tookMs: number; files: { file: string; rows: number; bytes: number }[] }> {
    if (!this.available || !this.con) throw new Error('duckdb 不可用（湖仓降级中）');
    const db = this.pg.database;
    if (!db) throw new Error('湖仓快照需要 PostgreSQL（SIME_PG_HOST）');
    const t0 = Date.now();
    const sid = Date.now().toString();
    const files: { file: string; rows: number; bytes: number }[] = [];

    const tables: { name: string; rows: Record<string, unknown>[]; cols: { n: string; t: string }[] }[] = [];
    const tel = (await db
      .selectFrom('telemetry')
      .select(['asset_id', 'point', 'ts', 'value'])
      .where('ts', '>', new Date(Date.now() - 24 * 3600 * 1000))
      .limit(200000)
      .execute()) as unknown as { asset_id: string; point: string; ts: Date; value: number }[];
    tables.push({
      name: 'telemetry',
      rows: tel.map((r) => ({ asset_id: r.asset_id, point: r.point, ts: new Date(r.ts).toISOString(), value: r.value })),
      cols: [
        { n: 'asset_id', t: 'VARCHAR' },
        { n: 'point', t: 'VARCHAR' },
        { n: 'ts', t: 'TIMESTAMP' },
        { n: 'value', t: 'DOUBLE' },
      ],
    });
    const alerts = (await db
      .selectFrom('alerts')
      .select(['id', 'rule_id', 'ts', 'severity', 'domain', 'state', 'summary'])
      .where('ts', '>', new Date(Date.now() - 24 * 3600 * 1000))
      .limit(100000)
      .execute()) as unknown as { id: number; rule_id: string; ts: Date; severity: string; domain: string; state: string; summary: string | null }[];
    tables.push({
      name: 'alerts',
      rows: alerts.map((r) => ({
        id: Number(r.id),
        rule_id: r.rule_id,
        ts: new Date(r.ts).toISOString(),
        severity: r.severity,
        domain: r.domain,
        state: r.state,
        summary: r.summary,
      })),
      cols: [
        { n: 'id', t: 'BIGINT' },
        { n: 'rule_id', t: 'VARCHAR' },
        { n: 'ts', t: 'TIMESTAMP' },
        { n: 'severity', t: 'VARCHAR' },
        { n: 'domain', t: 'VARCHAR' },
        { n: 'state', t: 'VARCHAR' },
        { n: 'summary', t: 'VARCHAR' },
      ],
    });

    for (const t of tables) {
      const tname = `${t.name}_s_${sid}`;
      await this.run(`CREATE OR REPLACE TABLE ${tname} (${t.cols.map((c) => `${c.n} ${c.t}`).join(', ')})`);
      for (let i = 0; i < t.rows.length; i += 500) {
        const batch = t.rows.slice(i, i + 500);
        for (const row of batch) {
          const vals = t.cols.map((c) => {
            const v = (row as Record<string, unknown>)[c.n];
            return v === undefined || v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
          });
          await this.run(`INSERT INTO ${tname} VALUES (${vals.join(', ')})`);
        }
      }
      const parquetFile = path.join(this.lakeDir, `${t.name}.parquet`).replace(/\\/g, '/');
      await this.run(`COPY (SELECT * FROM ${tname}) TO '${parquetFile}' (FORMAT PARQUET, COMPRESSION zstd)`);
      await this.run(`DROP TABLE ${tname}`);
      files.push({ file: path.basename(parquetFile), rows: t.rows.length, bytes: fs.existsSync(parquetFile) ? fs.statSync(parquetFile).size : 0 });
    }

    // 视图：分析查询直接跑 Parquet
    await this.run(`CREATE OR REPLACE VIEW telemetry AS SELECT * FROM read_parquet('${path.join(this.lakeDir, 'telemetry.parquet').replace(/\\/g, '/')}')`);
    await this.run(`CREATE OR REPLACE VIEW alerts AS SELECT * FROM read_parquet('${path.join(this.lakeDir, 'alerts.parquet').replace(/\\/g, '/')}')`);

    const tookMs = Date.now() - t0;
    this.lastSnapshot = { sid, files: files.map((f) => ({ file: f.file, bytes: f.bytes })), tookMs };
    this.logger.log(`lake snapshot ${sid}: ${files.map((f) => `${f.file}=${f.rows}行`).join(', ')} in ${tookMs}ms`);
    return { sid, tookMs, files };
  }

  /** 确保分析视图存在（Parquet 文件在才建；容器重建后自动恢复）。 */
  private async ensureViews(): Promise<void> {
    if (!this.con) throw new Error('duckdb 不可用（湖仓降级中）');
    const tel = path.join(this.lakeDir, 'telemetry.parquet').replace(/\\/g, '/');
    const al = path.join(this.lakeDir, 'alerts.parquet').replace(/\\/g, '/');
    if (!fs.existsSync(tel) && !fs.existsSync(al)) throw new Error('尚未生成快照（先点「生成快照」）');
    if (fs.existsSync(tel))
      await this.run(`CREATE OR REPLACE VIEW telemetry AS SELECT * FROM read_parquet('${tel}')`);
    if (fs.existsSync(al))
      await this.run(`CREATE OR REPLACE VIEW alerts AS SELECT * FROM read_parquet('${al}')`);
  }

  /** 受限只读分析查询：仅允许单条 SELECT/WITH，最多返回 200 行。 */
  async query(sqlText: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    if (!this.available || !this.con) throw new Error('duckdb 不可用（湖仓降级中）');
    const s = (sqlText ?? '').trim().replace(/;+\s*$/, '');
    if (!/^(select|with)\s/i.test(s)) throw new Error('仅允许 SELECT/WITH 查询');
    if (/;/.test(s)) throw new Error('不允许多语句');
    if (/\b(insert|update|delete|drop|create|attach|copy|export)\b/i.test(s)) throw new Error('仅允许只读查询');
    await this.ensureViews();
    const raw = await this.all(`SELECT * FROM (${s}) AS q LIMIT 200`);
    // DuckDB 的 BIGINT 会返回 BigInt，JSON 序列化前转 Number
    const rows = raw.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
      return out;
    });
    const columns = rows.length ? Object.keys(rows[0]!) : [];
    return { columns, rows };
  }
}
