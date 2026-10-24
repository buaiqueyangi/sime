import { HttpCode, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { AssetRegistryService } from '../../common/asset-registry.service';
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
    private readonly registry: AssetRegistryService,
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
          hits: Number(entity.hits ?? 0),
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

  /**
   * 告警详情：控制台点开一条告警看到的东西。
   *
   * 告警行本身只存了 `entity{groupKey,hits}`，看不出"为什么报"。这里把
   * 规则定义（检测条件/窗口/分组）、处置建议、响应动作、ATT&CK 与关联工单
   * 一并拼出来 —— 值班人员不点进规则库就该知道下一步做什么。
   *
   * id 既接受 `pg-123`（列表返回的形式）也接受裸数字 `123`。
   */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const pgId = Number(String(id).replace(/^pg-/, ''));
    const hasPg = Number.isFinite(pgId) && pgId > 0;
    const db = this.pg.database;

    let base:
      | {
          id: string;
          pgId?: number;
          ruleId: string;
          ts: string;
          severity: string;
          domain: string;
          state: string;
          groupKey: string;
          hits: number;
          summary: string;
          actions: string[];
        }
      | null = null;

    if (db && hasPg) {
      const row = await db.selectFrom('alerts').selectAll().where('id', '=', pgId).executeTakeFirst();
      if (row) {
        const entity = (row.entity ?? {}) as { groupKey?: string; hits?: number };
        base = {
          id: `pg-${row.id}`,
          pgId: row.id,
          ruleId: row.rule_id,
          ts: new Date(row.ts).toISOString(),
          severity: row.severity,
          domain: row.domain,
          state: row.state,
          groupKey: entity.groupKey ?? '-',
          hits: Number(entity.hits ?? 0),
          summary: row.summary ?? '',
          actions: [],
        };
      }
    }
    if (!base) {
      // 内存态（或 PG 里已过期清理）：回落到引擎内的告警缓存
      const mem = this.engine.engine.alerts.find((a) => a.id === id || (hasPg && a.pgId === pgId));
      if (!mem) throw new NotFoundException(`告警不存在：${id}`);
      base = {
        id: mem.id,
        ...(mem.pgId !== undefined ? { pgId: mem.pgId } : {}),
        ruleId: mem.ruleId,
        ts: mem.ts,
        severity: mem.severity,
        domain: mem.domain,
        state: mem.state ?? 'open',
        groupKey: mem.groupKey ?? '-',
        hits: Number(mem.hits ?? 0),
        summary: mem.summary ?? '',
        actions: mem.actions ?? [],
      };
    }

    const def = this.registry.get('rules').entries.find(({ data }) => data['id'] === base!.ruleId)?.data;
    const detection = (def?.['detection'] ?? null) as Record<string, unknown> | null;
    const response = (def?.['response'] ?? {}) as { default?: string[] };

    const tickets =
      db && base.pgId
        ? await db
            .selectFrom('tickets')
            .select(['id', 'title', 'state', 'created_at'])
            .where('alert_id', '=', base.pgId)
            .orderBy('id', 'desc')
            .limit(10)
            .execute()
        : [];

    // 关联告警：同主体（groupKey）近 24h 的其他告警——调查一条告警时最关心
    // "这个 IP/资产还触发过什么"。同规则去重（留最近一条）避免循环告警刷屏。
    let related: { pgId: number; ruleId: string; ts: string; severity: string; domain: string; state: string; summary: string }[] = [];
    const selfId = base.pgId;
    const gk = base.groupKey;
    if (db && selfId && gk && gk !== '-' && gk !== '_all') {
      const rows = (await db
        .selectFrom('alerts')
        .select(['id', 'rule_id', 'ts', 'severity', 'domain', 'state', 'summary'])
        .where(({ eb, and }) =>
          and([
            eb(sql`entity->>'groupKey'`, '=', gk),
            eb('id', '!=', selfId),
            eb('ts', '>', new Date(Date.now() - 24 * 3600 * 1000)),
          ]),
        )
        .orderBy('ts', 'desc')
        .limit(50)
        .execute()) as unknown as { id: number; rule_id: string; ts: Date; severity: string; domain: string; state: string; summary: string | null }[];
      related = rows
        .filter((r, i, arr) => arr.findIndex((x) => x.rule_id === r.rule_id) === i)
        .slice(0, 10)
        .map((r) => ({
          pgId: r.id,
          ruleId: r.rule_id,
          ts: new Date(r.ts).toISOString(),
          severity: r.severity,
          domain: r.domain,
          state: r.state,
          summary: (r.summary ?? '').slice(0, 80),
        }));
    }

    return {
      related,
      ...base,
      rule: def
        ? {
            name: String(def['name'] ?? base.ruleId),
            version: String(def['version'] ?? '-'),
            category: String(def['category'] ?? '-'),
            status: String(def['status'] ?? '-'),
            tactics: (def['tactics'] as string[]) ?? [],
            techniques: (def['techniques'] as string[]) ?? [],
            detection,
            triage: String(def['triage'] ?? ''),
            response: response.default ?? [],
            references: (def['references'] as string[]) ?? [],
            file: this.registry.get('rules').entries.find(({ data }) => data['id'] === base!.ruleId)?.file ?? null,
          }
        : null,
      tickets: tickets.map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state,
        createdAt: new Date(t.created_at).toISOString(),
      })),
    };
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
