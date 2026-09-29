import { HttpCode,Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { PgProfileService } from '../../common/pg-profile.service';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';
import { WsService } from '../../ws/ws.service';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly engine: RuleEngineService,
    private readonly pg: PgProfileService,
    private readonly ws: WsService,
  ) {}

  /** 告警列表：PG 激活时读持久化历史（含状态，可闭环操作）；否则内存态。 */
  @Get()
  async list() {
    const e = this.engine.engine;
    const db = this.pg.database;
    if (db) {
      const rows = await db
        .selectFrom('alerts')
        .leftJoin('rules', 'rules.id', 'alerts.rule_id')
        .select([
          'alerts.id',
          'alerts.rule_id',
          'alerts.ts',
          'alerts.severity',
          'alerts.domain',
          'alerts.state',
          'alerts.entity',
          'alerts.summary',
          'rules.name as rule_name',
        ])
        .orderBy('alerts.ts', 'desc')
        .limit(100)
        .execute();
      const total = await db
        .selectFrom('alerts')
        .select((qb) => qb.fn.countAll().as('c'))
        .execute();
      const items = rows.map((r) => {
        const entity = (r.entity ?? {}) as { groupKey?: string; hits?: number };
        return {
          id: `pg-${r.id}`,
          pgId: r.id,
          ruleId: r.rule_id,
          ruleName: r.rule_name ?? r.rule_id,
          severity: r.severity,
          domain: r.domain,
          state: r.state,
          ts: new Date(r.ts).toISOString(),
          groupKey: entity.groupKey ?? '-',
          summary: r.summary ?? '',
          actions: [] as string[],
        };
      });
      return {
        stats: { rules: e.rules.length, alerts: Number((total[0] as { c?: number })?.c ?? items.length) },
        pgActive: true,
        items,
      };
    }
    return { stats: e.stats(), pgActive: false, items: e.alerts.slice(-50).reverse() };
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

  /** 告警确认（ack）：值班人员已知晓并开始处理。 */
  @HttpCode(200)
  @Post(':id/ack')
  async ack(@Param('id') id: string) {
    return this.setState(Number(id), 'ack');
  }

  /** 告警解决（resolve）：处置完成闭环。 */
  @HttpCode(200)
  @Post(':id/resolve')
  async resolve(@Param('id') id: string) {
    return this.setState(Number(id), 'resolved');
  }

  private async setState(pgId: number, state: 'ack' | 'resolved') {
    const db = this.pg.database;
    if (!db) throw new Error('告警闭环操作需要 PostgreSQL 存储（当前为内存模式）');
    if (!Number.isFinite(pgId)) throw new Error('非法告警 ID');
    await db.updateTable('alerts').set({ state }).where('id', '=', pgId).execute();
    this.ws.broadcastAlertState(pgId, state);
    return { ok: true, pgId, state };
  }
}
