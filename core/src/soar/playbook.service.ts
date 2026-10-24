import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { PgProfileService } from '../common/pg-profile.service';
import { ResponseService } from '../response/response.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';
import type { SimeAlert } from '../rule-engine/rule-engine';

/**
 * SOAR 剧本引擎 v0（M2）：
 * 剧本 = YAML（templates/playbooks/*.yaml），trigger.rules 匹配到新告警即执行 steps 动作
 * （复用 ResponseService 落库：工单/通知/响应审计），执行记录入 playbook_runs。
 * v0 语义：新告警触发一次（冷却由规则引擎保证）；steps 为追加处置动作。
 */
interface PlaybookDef {
  id: string;
  name: string;
  version: string;
  status?: string;
  trigger: { rules: string[] };
  steps: string[];
}

interface PlaybookRun {
  playbookId: string;
  alertId: number | null;
  ruleId: string;
  ts: number;
}

@Injectable()
export class PlaybookService implements OnModuleInit {
  private readonly logger = new Logger('Playbook');
  private playbooks: PlaybookDef[] = [];
  private runs: PlaybookRun[] = [];

  constructor(
    private readonly pg: PgProfileService,
    private readonly response: ResponseService,
    private readonly engine: RuleEngineService,
  ) {}

  onModuleInit(): void {
    this.load();
    this.engine.onAlert((a, alertId) => void this.handle(a, alertId));
  }

  private load(): void {
    // 与资产根同一约定：本地 dev 相对 core/，容器内指向 /app/assets
    const dir = path.join(process.env.SIME_ASSET_ROOT ?? '..', 'templates', 'playbooks');
    this.playbooks = [];
    if (!fs.existsSync(dir)) {
      this.logger.warn(`playbook dir missing: ${dir}`);
      return;
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml') || x.endsWith('.yml')).sort()) {
      try {
        const def = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as PlaybookDef;
        if (def?.id && def.trigger?.rules?.length && def.steps?.length) this.playbooks.push(def);
        else this.logger.warn(`playbook skipped (missing id/trigger/steps): ${f}`);
      } catch (e) {
        this.logger.warn(`playbook load failed ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.logger.log(`playbooks loaded: ${this.playbooks.length} (files)`);
    void this.mergeDb();
    this.startVersionPoll();
  }

  /** DB 合并：custom 追加 + builtin 禁用剔除 + custom 禁用剔除。 */
  private async mergeDb(): Promise<void> {
    const db = (this.pg as any).database;
    if (!db) return;
    try {
      const rows = (await db.selectFrom('playbooks').select(['id', 'name', 'version', 'status', 'trigger', 'steps', 'source']).execute()) as Record<string, unknown>[];
      const disabled = new Set(rows.filter((r) => r.status === 'disabled' || r.status === 'deprecated').map((r) => String(r.id)));
      this.playbooks = this.playbooks.filter((p) => !disabled.has(p.id)); // builtin 禁用剔除
      for (const r of rows) {
        if (r.source !== 'custom' || disabled.has(String(r.id))) continue;
        this.playbooks.push({
          id: String(r.id), name: String(r.name), version: String(r.version), status: String(r.status),
          trigger: r.trigger as { rules: string[] }, steps: r.steps as string[],
        });
      }
      this.logger.log(`playbooks merged: ${this.playbooks.length} (+${rows.filter((r) => r.source === 'custom').length} custom)`);
    } catch (e) {
      this.logger.warn(`playbooks DB 合并失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private pbVersion = '';
  private startVersionPoll(): void {
    const db = (this.pg as any).database;
    if (!db) return;
    const poll = async () => {
      try {
        const rows = (await db.selectFrom('config').select('value').where('key', '=', 'playbooks.version').execute()) as { value: unknown }[];
        const v = JSON.stringify(rows[0]?.value ?? '');
        if (this.pbVersion && v !== this.pbVersion) {
          this.logger.log(`剧本版本变化 → 热重载`);
          this.load();
        }
        this.pbVersion = v;
      } catch { /* 忽略 */ }
    };
    void poll();
    setInterval(() => void poll(), 15_000).unref();
  }

  /** 写操作后 bump：本进程立即重载，其余分片 ≤15s。 */
  async bumpVersion(): Promise<void> {
    const db = (this.pg as any).database;
    if (!db) return;
    const now = JSON.stringify(String(Date.now()));
    await (db as any).insertInto('config').values({ key: 'playbooks.version', value: now })
      .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: now, updated_at: new Date() })).execute();
    this.load();
  }

  private async handle(alert: SimeAlert, alertId: number | null): Promise<void> {
    for (const pb of this.playbooks) {
      if (!pb.trigger.rules.includes(alert.ruleId)) continue;
      const pseudo: SimeAlert = { ...alert, actions: pb.steps };
      await this.response.execute(pseudo, alertId);
      const run: PlaybookRun = { playbookId: pb.id, alertId, ruleId: alert.ruleId, ts: Date.now() };
      this.runs.unshift(run);
      if (this.runs.length > 200) this.runs.pop();
      const db = this.pg.database;
      if (db) {
        void db
          .insertInto('playbook_runs')
          .values({ playbook_id: pb.id, alert_id: alertId, rule_id: alert.ruleId, actions: pb.steps })
          .execute()
          .catch(() => undefined);
      }
      this.logger.log(`playbook ${pb.id} executed for ${alert.ruleId}`);
    }
  }

  async listWithMeta(): Promise<{ id: string; name: string; version: string; rules: string[]; steps: string[]; runs: number; source: string; status: string }[]> {
    const db = (this.pg as any).database;
    let meta = new Map<string, { source?: string; status?: string }>();
    if (db) {
      try {
        const rows = (await db.selectFrom('playbooks').select(['id', 'source', 'status']).execute()) as Record<string, string>[];
        meta = new Map(rows.map((r) => [r.id, { source: r.source, status: r.status }]));
      } catch { /* 忽略 */ }
    }
    return this.playbooks.map((p) => {
      const m = meta.get(p.id) ?? {};
      return {
        id: p.id, name: p.name, version: p.version,
        rules: p.trigger.rules, steps: p.steps,
        runs: this.runs.filter((r) => r.playbookId === p.id).length,
        source: m.source === 'custom' ? 'custom' : 'builtin',
        status: m.status === 'disabled' ? 'disabled' : (p.status ?? 'stable'),
      };
    });
  }

  list(): { id: string; name: string; version: string; rules: string[]; steps: string[]; runs: number }[] {
    return this.playbooks.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      rules: p.trigger.rules,
      steps: p.steps,
      runs: this.runs.filter((r) => r.playbookId === p.id).length,
    }));
  }

  recentRuns(): PlaybookRun[] {
    return this.runs.slice(0, 20);
  }
}
