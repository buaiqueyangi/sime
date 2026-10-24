import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgProfileService } from '../common/pg-profile.service';

/**
 * 日志保留策略（P0）。
 *
 * 背景：`telemetry` 807 万行 / 1.08 GB 只增不减，`alerts` 3.4 万、`notifications` 3.1 万同理。
 * 没有清理策略的时序库最终都会把磁盘写满，这是运维债里最先爆的一笔。
 *
 * 设计取舍：
 *  - **分批删除**：`with victims as (select ctid ... limit N) delete ... using victims`，
 *    单批默认 2 万行。一次性 `delete from t where ts < x` 会长时间持锁、撑大 WAL，
 *    在一张 800 万行的表上足以让整个平台卡住。
 *  - **advisory lock**：`SIME_WORKERS=4` 时四个进程都有定时器，用
 *    `pg_try_advisory_lock(hashtext('sime:retention'))` 保证同一时刻只有一个在删。
 *  - **先干跑**：`dry_run` 只统计不删，上线前用它确认"会删多少"。
 *  - **留痕**：每次运行写 `maintenance_runs`，删了多少行可追溯。
 *  - 不做分区表改造：改现有表结构风险高于收益，分批 DELETE + autovacuum 足够。
 */

export interface RetentionPolicy {
  table: string;
  tsColumn: string;
  /** 0 = 不清理（业务单据/台账/最新值表） */
  days: number;
  label: string;
  /** 是否大表（大表批次更大、间隔更长） */
  large?: boolean;
}

export interface TableRunResult {
  table: string;
  days: number;
  cutoff: string | null;
  matched: number;
  deleted: number;
  batches: number;
  ms: number;
  status: 'ok' | 'skipped' | 'partial' | 'error';
  detail?: string;
}

export interface RetentionRunResult {
  startedAt: string;
  dryRun: boolean;
  ms: number;
  locked: boolean;
  tables: TableRunResult[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** 默认策略：能给出保留期的场景一律给，业务单据类不动 */
const DEFAULT_POLICIES: RetentionPolicy[] = [
  { table: 'telemetry', tsColumn: 'ts', days: 30, label: '遥测明细', large: true },
  { table: 'events', tsColumn: 'ts', days: 90, label: '原始事件', large: true },
  { table: 'alerts', tsColumn: 'ts', days: 180, label: '告警' },
  { table: 'notifications', tsColumn: 'ts', days: 90, label: '通知投递' },
  { table: 'response_audit', tsColumn: 'ts', days: 365, label: '响应审计（合规留存）' },
  { table: 'playbook_runs', tsColumn: 'ts', days: 90, label: '剧本执行记录' },
  { table: 'maintenance_runs', tsColumn: 'ts', days: 30, label: '维护记录' },
  { table: 'point_latest', tsColumn: 'ts', days: 0, label: '测点最新值（覆盖写，不清理）' },
  { table: 'tickets', tsColumn: 'created_at', days: 0, label: '工单（业务单据，不清理）' },
  { table: 'assets', tsColumn: 'created_at', days: 0, label: '资产台账' },
  { table: 'devices', tsColumn: 'last_seen_at', days: 0, label: '设备台账' },
];

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer?: NodeJS.Timeout;
  private running = false;

  /** 单批删除行数 */
  private readonly batch = Math.max(envInt('SIME_RETENTION_BATCH', 20_000), 100);
  /** 单表单次运行最多删多少批 */
  private readonly maxBatches = Math.max(envInt('SIME_RETENTION_MAX_BATCHES', 200), 1);
  /** 整次运行的总时间预算 */
  private readonly deadlineMs = Math.max(envInt('SIME_RETENTION_DEADLINE_MS', 300_000), 5_000);
  private readonly intervalMin = Math.max(envInt('SIME_RETENTION_INTERVAL_MIN', 60), 5);
  private readonly enabled = process.env.SIME_RETENTION_ENABLED !== '0';
  private readonly dryRunByDefault = process.env.SIME_RETENTION_DRY === '1';

  constructor(private readonly pg: PgProfileService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('retention disabled (SIME_RETENTION_ENABLED=0)');
      return;
    }
    // cluster 模式下每个 worker 也会加载 AppModule；只让主进程排程，
    // 避免 5 个定时器抢同一把 advisory lock（正确性靠锁兜底，这里只是减少无谓争抢）。
    if (process.env.SIME_SHARD !== undefined) {
      this.logger.log(`retention not scheduled in worker (shard=${process.env.SIME_SHARD})`);
      return;
    }
    // 首次延迟 3 分钟：让启动、规则同步、遥测入库先稳定下来
    const first = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.intervalMin * 60_000);
      this.timer.unref?.();
    }, 180_000);
    first.unref?.();
    this.logger.log(
      `retention scheduled every ${this.intervalMin}min (batch=${this.batch}, dry=${this.dryRunByDefault})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (!this.pg.ready) return;
    if (this.dryRunByDefault) {
      await this.run({ dryRun: true }).catch((e: unknown) =>
        this.logger.warn(`dry run failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    await this.run({}).catch((e: unknown) =>
      this.logger.warn(`run failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** 生效策略（含环境变量覆盖）：`SIME_RETENTION_<TABLE>_DAYS` */
  policies(): RetentionPolicy[] {
    return DEFAULT_POLICIES.map((p) => {
      const override = process.env[`SIME_RETENTION_${p.table.toUpperCase()}_DAYS`];
      if (override === undefined) return p;
      const n = Number(override);
      return Number.isFinite(n) && n >= 0 ? { ...p, days: Math.trunc(n) } : p;
    });
  }

  /** 状态页：策略 + 表体量估算 + 最近运行记录 */
  async status() {
    const policies = this.policies();
    const stats = await this.pg.tableStats(policies.map((p) => p.table));
    const byName = new Map(stats.map((s) => [s.table, s]));

    let lastRuns: Record<string, unknown>[] = [];
    const schedule = {
      enabled: this.enabled,
      intervalMin: this.intervalMin,
      batch: this.batch,
      maxBatches: this.maxBatches,
      dryRunByDefault: this.dryRunByDefault,
      running: this.running,
    };
    if (this.pg.ready) {
      try {
        const r = await this.pg.queryReadonly(
          `select id::text as id, job, target, scanned, affected, dry_run, ms, status, detail, ts
             from maintenance_runs order by ts desc limit 20`,
          [],
          5_000,
        );
        lastRuns = r.rows;
      } catch {
        lastRuns = [];
      }
    }

    return {
      schedule,
      policies: policies.map((p) => ({
        ...p,
        rows: byName.get(p.table)?.rows ?? 0,
        bytes: byName.get(p.table)?.bytes ?? 0,
        cutoff: p.days > 0 ? new Date(Date.now() - p.days * 86_400_000).toISOString() : null,
      })),
      totalBytes: stats.reduce((a, s) => a + s.bytes, 0),
      lastRuns,
    };
  }

  /**
   * 执行清理。`dryRun` 只统计不删。
   * 拿不到 advisory lock 说明别的进程正在跑，返回 `locked: true`。
   */
  async run(opts: { dryRun?: boolean; tables?: string[] } = {}): Promise<RetentionRunResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const dryRun = opts.dryRun === true;
    const only = opts.tables?.length ? new Set(opts.tables) : null;
    const policies = this.policies().filter(
      (p) => p.days > 0 && (!only || only.has(p.table)),
    );
    const results: TableRunResult[] = [];

    if (!this.pg.ready) {
      return { startedAt, dryRun, ms: 0, locked: false, tables: [] };
    }
    if (!policies.length) {
      return { startedAt, dryRun, ms: 0, locked: false, tables: [] };
    }

    this.running = true;
    try {
      const locked = await this.pg.withAdvisoryLock('sime:retention', async (client) => {
        for (const p of policies) {
          if (Date.now() - t0 > this.deadlineMs) {
            results.push({
              table: p.table,
              days: p.days,
              cutoff: null,
              matched: 0,
              deleted: 0,
              batches: 0,
              ms: 0,
              status: 'skipped',
              detail: '超出本次运行的时间预算',
            });
            continue;
          }
          results.push(await this.runOne(client, p, dryRun));
        }
        return results;
      });

      if (locked === null) {
        this.logger.warn('retention skipped: another instance holds the advisory lock');
        return { startedAt, dryRun, ms: Date.now() - t0, locked: true, tables: [] };
      }

      const deleted = results.reduce((a, r) => a + r.deleted, 0);
      const scanned = results.reduce((a, r) => a + r.matched, 0);
      this.logger.log(
        `retention done: tables=${results.length} scanned=${scanned} deleted=${deleted} dry=${dryRun} ${Date.now() - t0}ms`,
      );
      return { startedAt, dryRun, ms: Date.now() - t0, locked: false, tables: results };
    } finally {
      this.running = false;
    }
  }

  private async runOne(
    client: PoolClient,
    p: RetentionPolicy,
    dryRun: boolean,
  ): Promise<TableRunResult> {
    const t0 = Date.now();
    const cutoff = new Date(Date.now() - p.days * 86_400_000).toISOString();
    const base: TableRunResult = {
      table: p.table,
      days: p.days,
      cutoff,
      matched: 0,
      deleted: 0,
      batches: 0,
      ms: 0,
      status: 'ok',
    };

    if (!IDENT.test(p.table) || !IDENT.test(p.tsColumn)) {
      return { ...base, status: 'error', detail: '表名/列名不在标识符白名单内' };
    }

    try {
      // 干跑：只数
      if (dryRun) {
        const r = await client.query<{ n: string }>(
          `select count(*)::bigint as n from ${p.table} where ${p.tsColumn} < $1`,
          [cutoff],
        );
        const matched = Number(r.rows[0]?.n ?? 0);
        base.matched = matched;
        base.ms = Date.now() - t0;
        await this.record(client, {
          job: 'retention',
          target: p.table,
          scanned: matched,
          affected: 0,
          dryRun: true,
          ms: base.ms,
          status: 'ok',
          detail: `cutoff=${cutoff} days=${p.days}`,
        });
        return base;
      }

      // 实跑：分批删
      let total = 0;
      let batches = 0;
      for (;;) {
        if (batches >= this.maxBatches || Date.now() - t0 > this.deadlineMs) {
          base.status = 'partial';
          base.detail = `达到批次/时间上限（batches=${batches}），下次运行继续`;
          break;
        }
        const r = await client.query(
          `with victims as (
             select ctid from ${p.table} where ${p.tsColumn} < $1 limit $2
           )
           delete from ${p.table} x using victims v where x.ctid = v.ctid`,
          [cutoff, this.batch],
        );
        const n = r.rowCount ?? 0;
        total += n;
        batches++;
        if (n < this.batch) break;
      }

      base.matched = total;
      base.deleted = total;
      base.batches = batches;
      base.ms = Date.now() - t0;
      await this.record(client, {
        job: 'retention',
        target: p.table,
        scanned: total,
        affected: total,
        dryRun: false,
        ms: base.ms,
        status: base.status,
        detail: base.detail ?? `cutoff=${cutoff} days=${p.days} batches=${batches}`,
      });
      return base;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`retention ${p.table} failed: ${msg}`);
      base.ms = Date.now() - t0;
      base.status = 'error';
      base.detail = msg;
      await this.record(client, {
        job: 'retention',
        target: p.table,
        scanned: base.matched,
        affected: base.deleted,
        dryRun,
        ms: base.ms,
        status: 'error',
        detail: msg.slice(0, 500),
      }).catch(() => undefined);
      return base;
    }
  }

  private async record(
    client: PoolClient,
    row: {
      job: string;
      target: string;
      scanned: number;
      affected: number;
      dryRun: boolean;
      ms: number;
      status: string;
      detail: string;
    },
  ): Promise<void> {
    await client.query(
      `insert into maintenance_runs (job, target, scanned, affected, dry_run, ms, status, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.job, row.target, row.scanned, row.affected, row.dryRun, row.ms, row.status, row.detail],
    );
  }

  /** 导出任务也写一条记录，方便回答"谁把数据导走了" */
  async recordExport(target: string, rows: number, ms: number, status: string, detail: string): Promise<void> {
    if (!this.pg.ready) return;
    await this.pg
      .queryWrite(
        `insert into maintenance_runs (job, target, scanned, affected, dry_run, ms, status, detail)
         values ('export', $1, $2, $2, false, $3, $4, $5)`,
        [target, rows, ms, status, detail.slice(0, 500)],
        5_000,
      )
      .catch(() => undefined);
  }
}
