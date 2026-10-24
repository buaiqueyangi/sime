import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import type { Generated } from 'kysely';
import type { SimeAlert } from '../rule-engine/rule-engine';

/**
 * 存储层 pg-profile（可插拔第一档，蓝图 §6.1）。
 * 只有设置 SIME_PG_HOST 才激活；本地无 PG 时平台以内存态运行（开箱即用优先）。
 * 换 opensearch/iotdb/sime-ts profile 时：新增 profile 文件 + 本文件同接口，业务层不动。
 */
interface AlertsRow {
  id: Generated<number>;
  rule_id: string;
  ts: Generated<Date>;
  severity: string;
  domain: string;
  state: Generated<string>;
  entity: unknown;
  summary: string | null;
}
interface TicketsRow {
  id: Generated<number>;
  alert_id: number | null;
  title: string;
  state: Generated<string>;
  assignee: string | null;
  created_at: Generated<Date>;
  closed_at: Date | null;
}
interface NotificationsRow {
  id: Generated<number>;
  alert_id: number | null;
  channel: string;
  payload: unknown;
  status: Generated<string>;
  ts: Generated<Date>;
}
interface ResponseAuditRow {
  id: Generated<number>;
  alert_id: number | null;
  action: string;
  target: string | null;
  status: Generated<string>;
  ts: Generated<Date>;
}
interface EventsRow {
  id: Generated<number>;
  ts: Date;
  domain: string;
  category: string;
  name: string | null;
  source: string | null;
  src: unknown;
  dst: unknown;
  payload: unknown;
  threat_id: string | null;
}
interface TelemetryRow {
  asset_id: string;
  point: string;
  ts: Date;
  value: number;
}
interface PointLatestRow {
  asset_id: string;
  point: string;
  ts: Date;
  value: number;
}
interface AssetsRow {
  id: string;
  name: string;
  type: string;
  domain: string;
}
interface DevicesRow {
  id: string;
  asset_id: string;
  agent_type: string | null;
  agent_version: string | null;
  capabilities: string | null; // jsonb：写入侧 JSON.stringify（pg 驱动读侧自动反序列化）
  last_seen_at: Date | null;
}
interface RulesRow {
  id: string;
  name: string;
  version: string;
  domain: string;
  category: string;
  severity: string;
  tactics: string[];
  techniques: string[];
  definition: unknown;
  status: string;
}
interface PlaybookRunsRow {
  id: Generated<number>;
  playbook_id: string;
  alert_id: number | null;
  rule_id: string;
  actions: string[];
  ts: Generated<Date>;
}
interface ConfigRow {
  key: string;
  value: unknown;
  updated_at: Generated<Date>;
}

export interface DB {
  alerts: AlertsRow;
  events: EventsRow;
  tickets: TicketsRow;
  notifications: NotificationsRow;
  response_audit: ResponseAuditRow;
  telemetry: TelemetryRow;
  point_latest: PointLatestRow;
  assets: AssetsRow;
  devices: DevicesRow;
  rules: RulesRow;
  playbook_runs: PlaybookRunsRow;
  config: ConfigRow;
}

@Injectable()
export class PgProfileService implements OnModuleDestroy {
  private readonly logger = new Logger('PgProfile');
  private db?: Kysely<DB>;
  private pool?: Pool;

  get enabled(): boolean {
    return Boolean(process.env.SIME_PG_HOST);
  }

  get database(): Kysely<DB> | undefined {
    return this.db;
  }

  /** 连接池是否就绪（SIME_PG_HOST 已配置且 init 成功） */
  get ready(): boolean {
    return Boolean(this.pool);
  }

  async init(): Promise<boolean> {
    if (this.db) return true; // 幂等：多 worker/多次引导不重复建池
    if (!this.enabled) return false;
    const dir = process.env.SIME_PG_DDL_DIR ?? path.join('..', 'storage', 'pg', 'init');
    // 重试：postgres 晚于 core 启动（容器编排常见）不应让平台永久锁死在内存模式
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        this.pool = new Pool({
          host: process.env.SIME_PG_HOST,
          port: Number(process.env.SIME_PG_PORT ?? 5432),
          user: process.env.SIME_PG_USER ?? 'sime',
          password: process.env.SIME_PG_PASSWORD ?? 'sime-change-me',
          database: process.env.SIME_PG_DB ?? 'sime',
          connectionTimeoutMillis: 5000,
        });
        await this.pool.query('SELECT 1');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
        for (const f of files) await this.pool.query(fs.readFileSync(path.join(dir, f), 'utf8')); // 全部 IF NOT EXISTS，幂等
        this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }) });
        this.logger.log(`pg profile active, DDL ensured: ${files.join(', ')}`);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`pg init attempt ${attempt}/5 failed: ${msg}`);
        await this.pool?.end().catch(() => undefined);
        this.pool = undefined;
        if (attempt < 5) await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
    return false;
  }

  async insertAlert(a: SimeAlert): Promise<number | null> {
    if (!this.db) return null;
    const rows = await this.db
      .insertInto('alerts')
      .values({
        rule_id: a.ruleId,
        severity: a.severity,
        domain: a.domain,
        entity: { groupKey: a.groupKey, hits: a.hits },
        summary: a.summary,
      })
      .returning('id')
      .execute();
    return (rows[0] as { id?: number } | undefined)?.id ?? null;
  }

  /**
   * 受限只读查询通道（SIME QL 的执行底座）。
   *
   * 三道护栏叠在一起：
   *  1. `BEGIN TRANSACTION READ ONLY` —— 写语句由 PG 直接拒绝，不依赖字符串过滤；
   *  2. `SET LOCAL statement_timeout` —— 超时自动中断，避免大表全扫拖垮实例；
   *  3. 语句与参数由上层 SIME QL 编译器产出，本方法不做任何拼接。
   */
  async queryReadonly<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
    timeoutMs = 15_000,
  ): Promise<{ rows: T[]; rowCount: number; ms: number }> {
    if (!this.pool) throw new Error('pg profile 未启用（缺少 SIME_PG_HOST 或初始化失败）');
    const budget = Math.min(Math.max(Math.trunc(timeoutMs) || 15_000, 100), 120_000);
    const client = await this.pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${budget}`);
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const res = await client.query(text, params as unknown[]);
      await client.query('COMMIT');
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length, ms: Date.now() - t0 };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 可写语句通道（维护任务专用：保留策略删除、维护记录写入）。
   *
   * 与 `queryReadonly` 的区别只是不开 READ ONLY 事务；语句仍然由调用方以**常量 + $n 参数**
   * 形式给出，不接受外部拼接（维护任务里唯一的"变量"是白名单表名与批次大小）。
   */
  async queryWrite<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
    timeoutMs = 60_000,
  ): Promise<{ rows: T[]; rowCount: number; ms: number }> {
    if (!this.pool) throw new Error('pg profile 未启用（缺少 SIME_PG_HOST 或初始化失败）');
    const budget = Math.min(Math.max(Math.trunc(timeoutMs) || 60_000, 100), 600_000);
    const client = await this.pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${budget}`);
      const res = await client.query(text, params as unknown[]);
      await client.query('COMMIT');
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length, ms: Date.now() - t0 };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 在**同一条连接**上持 advisory lock 执行，拿不到锁直接返回 null。
   *
   * 用途：`SIME_WORKERS=4` 时四个进程都会跑定时维护，必须保证同一时刻只有一个在删数据。
   * advisory lock 是会话级的，所以必须复用同一个 client，不能走连接池随手取。
   */
  async withAdvisoryLock<T>(
    key: string,
    fn: (client: PoolClient) => Promise<T>,
    timeoutMs = 600_000,
  ): Promise<T | null> {
    if (!this.pool) throw new Error('pg profile 未启用（缺少 SIME_PG_HOST 或初始化失败）');
    const budget = Math.min(Math.max(Math.trunc(timeoutMs) || 600_000, 1_000), 3_600_000);
    const client = await this.pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)::bigint) as ok",
        [key],
      );
      if (!got.rows[0]?.ok) return null;
      // 会话级超时：批量 DELETE 必须能被兜住；释放连接前复位，避免污染池里的下一位使用者
      await client.query(`SET statement_timeout = ${budget}`);
      try {
        return await fn(client);
      } finally {
        await client.query('SET statement_timeout = 0').catch(() => undefined);
        await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  /**
   * 表体量概览：行数取 `reltuples` 估算（毫秒级），字节数取真实关系大小。
   * 用于 `/retention` 状态页，不对大表做 count(*)。
   */
  async tableStats(
    names: string[],
  ): Promise<{ table: string; rows: number; bytes: number }[]> {
    if (!this.pool) return [];
    const res = await this.pool.query<{ t: string; rows: string; bytes: string }>(
      `select c.relname as t,
              greatest(c.reltuples, 0)::bigint as rows,
              pg_total_relation_size(c.oid) as bytes
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind = 'r' and c.relname = any($1)`,
      [names],
    );
    return res.rows.map((r) => ({ table: r.t, rows: Number(r.rows), bytes: Number(r.bytes) }));
  }

  async onModuleDestroy() {
    await this.db?.destroy();
    await this.pool?.end();
  }
}
