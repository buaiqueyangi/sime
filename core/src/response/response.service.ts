import { Injectable, Logger } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';
import type { SimeAlert } from '../rule-engine/rule-engine';

/**
 * 告警处置执行器（SOAR 地基，M1/M2）：
 * 规则 response.default 的动作字符串在此落地——
 *   ticket.create(sla=15m) → 工单表
 *   notify.sec_team        → 通知表
 *   firewall.block / isolate.host / plc.deny / account.lock ... → 响应审计表（模拟执行，
 *   真实联动通过适配器/物模型服务接入后升级为 executed）
 */
interface MemoryState {
  tickets: { title: string; state: string; ts: number }[];
  notifications: { channel: string; groupKey: string; ts: number }[];
  audit: { action: string; target: string; status: string; ts: number }[];
}

@Injectable()
export class ResponseService {
  private readonly logger = new Logger('Response');
  private memory: MemoryState = { tickets: [], notifications: [], audit: [] };

  constructor(private readonly pg: PgProfileService) {}

  async execute(alert: SimeAlert, alertId: number | null): Promise<void> {
    for (const raw of alert.actions ?? []) {
      const m = /^([a-z][a-z0-9_.]*)(?:\((.*)\))?$/.exec(raw);
      if (!m) continue;
      const name = m[1]!;
      const argStr = m[2] ?? '';
      const positional: string[] = [];
      const kv: Record<string, string> = {};
      for (const p of argStr.split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = p.indexOf('=');
        if (eq > 0 && !p.slice(0, eq).includes('.')) kv[p.slice(0, eq)] = p.slice(eq + 1);
        else positional.push(p);
      }
      const target = positional[0] ?? kv['target'] ?? alert.groupKey;
      try {
        const db = this.pg.database;
        if (name === 'ticket.create') {
          const title = `${alert.ruleName} @ ${alert.groupKey}`;
          if (db) await db.insertInto('tickets').values({ alert_id: alertId, title }).execute();
          this.memory.tickets.unshift({ title, state: 'open', ts: Date.now() });
        } else if (name.startsWith('notify.')) {
          const channel = name.slice(7);
          if (db)
            await db
              .insertInto('notifications')
              .values({ alert_id: alertId, channel, payload: { groupKey: alert.groupKey, severity: alert.severity } })
              .execute();
          this.memory.notifications.unshift({ channel, groupKey: alert.groupKey, ts: Date.now() });
        } else {
          if (db)
            await db
              .insertInto('response_audit')
              .values({ alert_id: alertId, action: name, target, status: 'simulated' })
              .execute();
          this.memory.audit.unshift({ action: name, target, status: 'simulated', ts: Date.now() });
        }
      } catch (e) {
        this.logger.warn(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  snapshot(): MemoryState {
    return {
      tickets: this.memory.tickets.slice(0, 20),
      notifications: this.memory.notifications.slice(0, 20),
      audit: this.memory.audit.slice(0, 20),
    };
  }

  /** 处置闭环列表：PG 优先（持久），内存兜底（未接 PG 时）。 */
  async lists(): Promise<{
    tickets: { title: string; state: string; ts: number }[];
    notifications: { channel: string; groupKey: string; ts: number }[];
    audit: { action: string; target: string; status: string; ts: number }[];
  }> {
    const db = this.pg.database;
    if (!db) return this.memory;
    const [tickets, notifications, audit] = await Promise.all([
      db.selectFrom('tickets').selectAll().orderBy('created_at', 'desc').limit(20).execute(),
      db.selectFrom('notifications').selectAll().orderBy('ts', 'desc').limit(20).execute(),
      db.selectFrom('response_audit').selectAll().orderBy('ts', 'desc').limit(20).execute(),
    ]);
    return {
      tickets: tickets.map((t) => ({ title: t.title, state: t.state, ts: new Date(t.created_at).getTime() })),
      notifications: notifications.map((n) => ({
        channel: n.channel,
        groupKey: (n.payload as { groupKey?: string })?.groupKey ?? '-',
        ts: new Date(n.ts).getTime(),
      })),
      audit: audit.map((a) => ({ action: a.action, target: a.target ?? '-', status: a.status, ts: new Date(a.ts).getTime() })),
    };
  }
}
