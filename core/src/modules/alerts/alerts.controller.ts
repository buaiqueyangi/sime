import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { PgProfileService } from '../../common/pg-profile.service';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly engine: RuleEngineService,
    private readonly pg: PgProfileService,
  ) {}

  @Get()
  list() {
    const e = this.engine.engine;
    return {
      stats: e.stats(),
      pgActive: this.engine.pgActive,
      items: e.alerts.slice(-50).reverse(),
    };
  }

  /** 24h 告警趋势（按小时分桶）：PG 聚合优先，内存兜底。 */
  @Get('trend')
  async trend() {
    const buckets = new Map<number, number>();
    const db = this.pg.database;
    if (db) {
      const rows = await db
        .selectFrom('alerts')
        .select([sql<Date>`date_trunc('hour', ts)`.as('h'), (qb) => qb.fn.countAll().as('c')])
        .where('ts', '>', new Date(Date.now() - 24 * 3600 * 1000))
        .groupBy(sql`date_trunc('hour', ts)`)
        .execute();
      for (const r of rows) buckets.set(new Date(r.h).getTime(), Number(r.c));
    } else {
      for (const a of this.engine.engine.alerts) {
        const h = Math.floor(Date.parse(a.ts) / 3600000) * 3600000;
        buckets.set(h, (buckets.get(h) ?? 0) + 1);
      }
    }
    const startH = Math.floor(Date.now() / 3600000) * 3600000 - 23 * 3600000;
    const hours: { ts: number; count: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const ts = startH + i * 3600000;
      hours.push({ ts, count: buckets.get(ts) ?? 0 });
    }
    return { hours, total: hours.reduce((s, x) => s + x.count, 0) };
  }
}
