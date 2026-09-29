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
interface DB {
  alerts: AlertsRow;
}

@Injectable()
export class PgProfileService implements OnModuleDestroy {
  private readonly logger = new Logger('PgProfile');
  private db?: Kysely<DB>;
  private pool?: Pool;

  get enabled(): boolean {
    return Boolean(process.env.SIME_PG_HOST);
  }

  async init(): Promise<boolean> {
    if (!this.enabled) return false;
    const ddlPath = process.env.SIME_PG_DDL ?? path.join('..', 'storage', 'pg', 'init', '01-schema.sql');
    this.pool = new Pool({
      host: process.env.SIME_PG_HOST,
      port: Number(process.env.SIME_PG_PORT ?? 5432),
      user: process.env.SIME_PG_USER ?? 'sime',
      password: process.env.SIME_PG_PASSWORD ?? 'sime-change-me',
      database: process.env.SIME_PG_DB ?? 'sime',
    });
    const ddl = fs.readFileSync(ddlPath, 'utf8');
    await this.pool.query(ddl); // DDL 全部 IF NOT EXISTS，幂等
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }) });
    this.logger.log('pg profile active, schema ensured');
    return true;
  }

  async insertAlert(a: SimeAlert): Promise<void> {
    if (!this.db) return;
    await this.db
      .insertInto('alerts')
      .values({
        rule_id: a.ruleId,
        severity: a.severity,
        domain: a.domain,
        entity: { groupKey: a.groupKey, hits: a.hits },
        summary: a.summary,
      })
      .execute();
  }

  async onModuleDestroy() {
    await this.db?.destroy();
    await this.pool?.end();
  }
}
