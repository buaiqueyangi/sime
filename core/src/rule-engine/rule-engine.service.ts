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
    // 逐条编译：单条坏规则只跳过并告警，绝不杀死整个平台（生产教训）
    const defs = this.registry.get('rules').entries;
    const valid: SimeRule[] = [];
    let failed = 0;
    for (const { file, data } of defs) {
      try {
        valid.push(data as unknown as SimeRule);
      } catch (e) {
        failed++;
        this.logger.error(`规则装载失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      this.engine = new RuleEngine(valid);
      this.logger.log(`rules compiled: ${this.engine.rules.length}${failed ? `（${failed} 条装载失败已跳过）` : ''}`);
      this.compileFailures = failed;
    } catch (e) {
      // RuleEngine 构造期（条件编译）失败：定位坏规则并跳过
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`规则批量编译失败，进入逐条定位: ${msg}`);
      this.engine = new RuleEngine([]);
      for (const { file, data } of defs) {
        try {
          const probe = new RuleEngine([data as unknown as SimeRule]);
          this.engine.rules.push(...probe.rules);
        } catch {
          failed++;
          this.logger.error(`跳过坏规则 ${file}: ${msg}`);
        }
      }
      this.compileFailures = failed;
      this.logger.warn(`rules compiled (degraded): ${this.engine.rules.length}, skipped ${failed}`);
    }
  }

  private compileFailures = 0;
}
