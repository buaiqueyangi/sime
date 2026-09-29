import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
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
}
interface NotificationsRow {
  id: Generated<number>;
  alert_id: number | null;
  channel: string;
  payload: unknown;
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

export interface DB {
  alerts: AlertsRow;
  tickets: TicketsRow;
  notifications: NotificationsRow;
  response_audit: ResponseAuditRow;
  telemetry: TelemetryRow;
  point_latest: PointLatestRow;
  assets: AssetsRow;
  devices: DevicesRow;
  rules: RulesRow;
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

  async init(): Promise<boolean> {
    if (!this.enabled) return false;
    const dir = process.env.SIME_PG_DDL_DIR ?? path.join('..', 'storage', 'pg', 'init');
    this.pool = new Pool({
      host: process.env.SIME_PG_HOST,
      port: Number(process.env.SIME_PG_PORT ?? 5432),
      user: process.env.SIME_PG_USER ?? 'sime',
      password: process.env.SIME_PG_PASSWORD ?? 'sime-change-me',
      database: process.env.SIME_PG_DB ?? 'sime',
    });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) await this.pool.query(fs.readFileSync(path.join(dir, f), 'utf8')); // 全部 IF NOT EXISTS，幂等
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }) });
    this.logger.log(`pg profile active, DDL ensured: ${files.join(', ')}`);
    return true;
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

  async onModuleDestroy() {
    await this.db?.destroy();
    await this.pool?.end();
  }
}
