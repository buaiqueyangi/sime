import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetRegistryService } from '../common/asset-registry.service';
import { PgProfileService } from '../common/pg-profile.service';
import { ResponseService } from '../response/response.service';
import { RuleEngine, SimeAlert, SimeRule } from './rule-engine';

/** 规则内核的 Nest 承载：启动即编译规则库，feed 入口供接入/回放层调用；告警自动落库并触发处置动作。 */
@Injectable()
export class RuleEngineService implements OnModuleInit {
  private readonly logger = new Logger('RuleEngine');
  engine!: RuleEngine;
  pgActive = false;

  constructor(
    private readonly registry: AssetRegistryService,
    private readonly pg: PgProfileService,
    private readonly response: ResponseService,
  ) {}

  onModuleInit() {
    this.onModuleInitEngine();
    this.pg
      .init()
      .then(async (ok) => {
        this.pgActive = ok;
        if (ok) {
          this.logger.log('alerts persisted to pg');
          await this.syncRules();
          const backlog = this.pending.splice(0);
          for (const a of backlog) void this.persist(a);
          if (backlog.length) this.logger.log(`flushed ${backlog.length} buffered alert(s) to pg`);
        }
      })
      .catch((e) => this.logger.warn(`pg init skipped: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** 规则定义同步进 PG（alerts.rule_id 外键依赖；upsert 幂等，规则变更自动跟进）。 */
  private async syncRules(): Promise<void> {
    const db = this.pg.database;
    if (!db) return;
    for (const { data } of this.registry.get('rules').entries) {
      await db
        .insertInto('rules')
        .values({
          id: String(data['id']),
          name: String(data['name']),
          version: String(data['version'] ?? '1.0'),
          domain: String(data['domain'] ?? 'it'),
          category: String(data['category'] ?? 'other'),
          severity: String(data['severity'] ?? 'info'),
          tactics: (data['tactics'] as string[]) ?? [],
          techniques: (data['techniques'] as string[]) ?? [],
          definition: data,
          status: String(data['status'] ?? 'draft'),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            name: String(data['name']),
            severity: String(data['severity'] ?? 'info'),
            definition: data,
            status: String(data['status'] ?? 'draft'),
          }),
        )
        .execute();
    }
    this.logger.log(`rules synced to pg: ${this.engine.rules.length}`);
  }

  feed(event: Record<string, unknown>, tsMs: number): SimeAlert[] {
    const produced = this.engine.feed(event, tsMs);
    for (const a of produced) {
      // PG 未就绪时先缓冲（启动早期接入方的告警不丢），初始化完成后回灌
      if (this.pgActive) void this.persist(a);
      else if (this.pending.length < 500) this.pending.push(a);
    }
    return produced;
  }

  private pending: SimeAlert[] = [];

  private async persist(a: SimeAlert): Promise<void> {
    try {
      const id = await this.pg.insertAlert(a);
      await this.response.execute(a, id);
      for (const fn of this.alertListeners) {
        try {
          fn(a, id);
        } catch {
          /* 监听器异常不影响主链路 */
        }
      }
    } catch (e) {
      this.logger.warn(`alert persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private alertListeners: ((a: SimeAlert, alertId: number | null) => void)[] = [];

  /** 订阅新告警（WebSocket 广播 / SOAR 剧本触发等）。 */
  onAlert(fn: (a: SimeAlert, alertId: number | null) => void): void {
    this.alertListeners.push(fn);
  }

  /** 重建引擎（清空窗口/冷却/告警状态），供"重置回放"使用。 */
  rebuild(): void {
    this.onModuleInitEngine();
  }

  private onModuleInitEngine(): void {
    const defs = this.registry.get('rules').entries.map(({ file, data }) => {
      try {
        return data as unknown as SimeRule;
      } catch (e) {
        throw new Error(`规则编译失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    this.engine = new RuleEngine(defs);
    this.logger.log(`rules compiled: ${this.engine.rules.length}`);
  }
}
