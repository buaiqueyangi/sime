import { Injectable, Logger } from '@nestjs/common';
import mqtt, { MqttClient } from 'mqtt';
import { PgProfileService } from '../common/pg-profile.service';
import { NotifyService } from '../notify/notify.service';
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

  constructor(
    private readonly pg: PgProfileService,
    private readonly notify: NotifyService,
  ) {
    // cmd 超时清理：Agent 离线/掉线时，sent 不应永远悬置
    setInterval(() => void this.sweepCmdTimeout(), 15_000).unref();
  }

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
          const nTitle = `${alert.ruleName} @ ${alert.groupKey}`;
          const st = await this.notify.dispatch(channel, nTitle, { groupKey: alert.groupKey, severity: alert.severity });
          if (db)
            await db
              .insertInto('notifications')
              .values({ alert_id: alertId, channel, payload: { groupKey: alert.groupKey, severity: alert.severity }, status: st })
              .execute();
          this.memory.notifications.unshift({ channel, groupKey: alert.groupKey, ts: Date.now() });
        } else if (AGENT_ACTIONS.has(name) || name === 'account.suspend') {
          const r = this.resolveTarget(name, positional, kv, alert);
          if (this.cmdEnabled() && r.device) {
            await this.dispatchCommand(alertId, name, r.args, r.target, db, r.device);
          } else {
            if (db)
              await db
                .insertInto('response_audit')
                .values({ alert_id: alertId, action: name, target: r.target, status: 'simulated' })
                .execute();
            this.memory.audit.unshift({ action: name, target: r.target, status: 'simulated', ts: Date.now() });
          }
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
      tickets: tickets.map((t) => ({ id: t.id, title: t.title, state: t.state, ts: new Date(t.created_at).getTime() })),
      notifications: notifications.map((n) => ({
        channel: n.channel,
        groupKey: (n.payload as { groupKey?: string })?.groupKey ?? '-',
        ts: new Date(n.ts).getTime(),
      })),
      audit: audit.map((a) => ({ action: a.action, target: a.target ?? '-', status: a.status, ts: new Date(a.ts).getTime(), detail: ((a as unknown as { reply?: { detail?: string } }).reply)?.detail ?? '', cmdId: (a as unknown as { cmd_id?: string }).cmd_id ?? null })),
    };
  }

  // ==================== P2: cmd 响应执行通道 ====================
  // 自包含：独立 MQTT 客户端（主进程/worker 各自连接，client-id 含 pid），下发
  // sime/v1/{deviceId}/cmd 并订阅 +/cmd/reply，按 cmd_id 关联回执更新 response_audit。

  private cmdClient?: MqttClient;
  private cmdPending = new Map<string, number | null>(); // cmd_id -> response_audit.id
  private cmdSentAt = new Map<string, number>();


  private async sweepCmdTimeout(): Promise<void> {
    const now = Date.now();
    const db = this.pg.database;
    for (const [cmdId, sentAt] of this.cmdSentAt) {
      if (now - sentAt < 30_000) continue;
      const auditId = this.cmdPending.get(cmdId) ?? null;
      this.cmdPending.delete(cmdId);
      this.cmdSentAt.delete(cmdId);
      this.logger.warn(`cmd 超时无回执: ${cmdId}`);
      if (db && auditId) {
        await (db as any)
          .updateTable('response_audit')
          .set({ status: 'timeout', reply: { detail: '30s 未收到 Agent 回执（设备离线或非 host-agent）' } })
          .where('id', '=', auditId)
          .execute()
          .catch(() => undefined);
      }
    }
  }

  cmdEnabled(): boolean {
    return AGENT_ACTIONS !== undefined && !!process.env.SIME_MQTT_URL && !!this.pg.database;
  }

  private async ensureCmdClient(): Promise<MqttClient | null> {
    if (!process.env.SIME_MQTT_URL) return null;
    if (this.cmdClient?.connected) return this.cmdClient;
    if (this.cmdClient) return this.cmdClient; // 重连中
    const url = process.env.SIME_MQTT_URL;
    this.cmdClient = mqtt.connect(url, {
      clientId: 'sime-cmd-' + process.pid,
      reconnectPeriod: 5000,
    });
    this.cmdClient.on('connect', () => {
      this.logger.log('cmd 通道就绪');
      this.cmdClient!.subscribe('sime/v1/+/cmd/reply', (err) => {
        if (err) this.logger.warn('cmd/reply 订阅失败: ' + err.message);
      });
    });
    this.cmdClient.on('message', (_t, payload) => {
      try {
        const reply = JSON.parse(payload.toString('utf8')) as { id?: string; status?: string; detail?: string; action?: string };
        if (reply?.id) void this.onCmdReply(reply);
      } catch { /* 坏帧忽略 */ }
    });
    // 等待首连（最多 5s，失败降级 simulated 由调用方兜底）
    for (let i = 0; i < 50 && !this.cmdClient.connected; i++) await new Promise((r) => setTimeout(r, 100));
    return this.cmdClient.connected ? this.cmdClient : null;
  }

  /** 剧本参数解析：字段引用（user.name/src.ip/...）从告警上下文取真值。 */
  private resolveTarget(name: string, positional: string[], kv: Record<string, string>, alert: SimeAlert): { target: string; args: Record<string, unknown>; device: string | null } {
    const ctx = alert.context ?? {};
    const resolve = (tok: string): unknown => {
      if (ctx[tok] !== undefined) return ctx[tok];
      // src.ip 兜底：分组键本身常是源 IP（group_by src.ip 的规则）
      if (tok === 'src.ip' && /^\d+\.\d+\.\d+\.\d+$/.test(alert.groupKey)) return alert.groupKey;
      if (tok === 'dst.asset_id' && alert.groupKey.startsWith('dev-')) return alert.groupKey;
      return tok; // 字面量
    };
    const args: Record<string, unknown> = {};
    let target = '';
    for (const [k, v] of Object.entries(kv)) {
      if (/^[a-z_]+(\.[a-z_]+)+$/.test(v)) args[k] = resolve(v);
      else if (v === 'true' || v === 'false') args[k] = v === 'true';
      else if (/^\d+$/.test(v)) args[k] = Number(v);
      else args[k] = v;
      if (k === 'target') target = String(args[k]);
    }
    for (const p of positional) {
      const v = /^[a-z_]+(\.[a-z_]+)+$/.test(p) ? resolve(p) : p;
      if (!target) target = String(v);
      else if (v === true || v === false || /^\d+$/.test(String(v))) { /* ttl 等数值位 */ }
    }
    if (!target) target = alert.groupKey;
    // 语义映射：动作 → agent 参数名
    const mapped: Record<string, unknown> = {};
    if (name.startsWith('account.')) mapped.user = target === alert.groupKey ? '' : target;
    if (name.startsWith('firewall.')) mapped.ip = target;
    if (name === 'process.kill') mapped.name = target;
    if (name === 'file.quarantine') mapped.path = target;
    Object.assign(args, mapped);
    // 命令路由：动作在哪台主机执行 —— 事件的目标资产（agent 事件自带 dst.asset_id）
    const device = String(ctx['dst.asset_id'] ?? alert.context?.['dst.asset_id'] ?? '') || null;
    return { target, args, device };
  }

  /** 下发命令：审计行 status=sent + cmd_id；Agent 回执后更新 executed/failed/skipped。 */
  private async dispatchCommand(alertId: number | null, action: string, args: Record<string, unknown>, target: string, db: any, deviceId?: string | null): Promise<void> {
    // 语义别名：剧本里的 suspend 在 agent 侧即 lock
    if (action === 'account.suspend') action = 'account.lock';
    if (!deviceId) {
      this.logger.warn(`cmd 无目标主机（事件缺 dst.asset_id），动作保持 simulated: ${action}`);
      return;
    }
    const client = await this.ensureCmdClient();
    if (!client) {
      this.logger.warn('cmd 通道不可用，动作降级 simulated: ' + action);
      return;
    }
    // 守卫：只向真实 host-agent 下发（devices.agent_type 校验），非 agent 设备保持 simulated
    if (db) {
      const dev = await (db as any)
        .selectFrom('devices')
        .select(['id', 'agent_type'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!dev || dev.agent_type !== 'host') {
        await (db as any)
          .insertInto('response_audit')
          .values({ alert_id: alertId, action, target, status: 'simulated' })
          .execute();
        this.memory.audit.unshift({ action, target, status: 'simulated', ts: Date.now() });
        return;
      }
    }
    const cmdId = 'cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    let auditId: number | null = null;
    if (db) {
      const rows = await db
        .insertInto('response_audit')
        .values({ alert_id: alertId, action, target, status: 'sent', cmd_id: cmdId } as never)
        .returning('id')
        .execute();
      auditId = (rows[0] as { id?: number } | undefined)?.id ?? null;
    }
    this.cmdPending.set(cmdId, auditId);
    this.cmdSentAt.set(cmdId, Date.now());
    client.publish('sime/v1/' + deviceId + '/cmd', JSON.stringify({ id: cmdId, action, args }), { qos: 1 });
    this.logger.log(`cmd 已下发 ${action} → ${deviceId} (${cmdId})`);
    this.memory.audit.unshift({ action, target, status: 'sent', ts: Date.now() });
  }

  /** Agent 回执：sent → executed / failed / skipped（超时 30s 未回执标记 timeout）。 */
  async onCmdReply(reply: { id?: string; status?: string; detail?: string; action?: string }): Promise<void> {
    if (!reply?.id) return;
    const auditId = this.cmdPending.get(reply.id);
    this.cmdPending.delete(reply.id);
    this.cmdSentAt.delete(reply.id);
    const status = reply.status === 'executed' ? 'executed' : reply.status === 'skipped' ? 'skipped' : 'failed';
    this.logger.log('cmd 回执 %s: %s (%s)', reply.action, status, reply.detail ?? '');
    const db = this.pg.database;
    if (db && auditId) {
      await db
        .updateTable('response_audit')
        .set({ status, reply: { detail: reply.detail ?? '', action: reply.action ?? '' } } as never)
        .where('id', '=', auditId)
        .execute();
    }
    if (this.memory.audit[0]?.status === 'sent') this.memory.audit[0] = { ...this.memory.audit[0]!, status };
  }
}

const AGENT_ACTIONS = new Set([
  'account.lock', 'account.unlock',
  'firewall.block', 'firewall.unblock',
  'process.kill', 'file.quarantine',
  'isolate.host', 'ping',
]);
