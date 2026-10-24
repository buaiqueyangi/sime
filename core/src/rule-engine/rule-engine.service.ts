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
          for (const a of backlog) void this.persistInsert(a);
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
          source: 'builtin',
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            source: 'builtin',
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
      // 副作用（处置/剧本/WS）总是执行；PG 持久化仅在激活时进行，未就绪先缓冲回灌
      void this.dispatch(a);
      if (this.pgActive) void this.persistInsert(a);
      else if (this.pending.length < 500) this.pending.push(a);
    }
    return produced;
  }

  private pending: SimeAlert[] = [];

  private async dispatch(a: SimeAlert): Promise<void> {
    try {
      await this.response.execute(a, a.pgId ?? null);
      for (const fn of this.alertListeners) {
        try {
          fn(a, a.pgId ?? null);
        } catch {
          /* 监听器异常不影响主链路 */
        }
      }
    } catch (e) {
      this.logger.warn(`alert dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async persistInsert(a: SimeAlert): Promise<void> {
    try {
      const id = await this.pg.insertAlert(a);
      if (id) a.pgId = id;
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
    // 立即可用（空引擎），异步构建随后整体替换——避免 worker 启动期访问 undefined
    this.engine = new (require('./rule-engine').RuleEngine)([]);
    void this.buildEngine();
    this.startVersionPoll();
  }

  /** 构建引擎：文件规则（builtin）+ DB 状态覆盖（禁用）+ DB 自定义规则（custom）。
   *  单条坏规则只跳过并告警，绝不杀死整个平台（生产教训）。 */
  private async buildEngine(): Promise<void> {
    const defs = this.registry.get('rules').entries;
    const db = this.pg.database;

    // DB 覆盖与自定义（等 PG 就绪，最多 60s——晚启动不再锁死内存模式）
    let disabledIds = new Set<string>();
    let customDefs: SimeRule[] = [];
    if (db) {
      for (let i = 0; i < 12; i++) {
        try {
          const rows = (await (db as any).selectFrom('rules').select(['id', 'source', 'status', 'definition']).execute()) as {
            id: string; source: string; status: string; definition: unknown;
          }[];
          disabledIds = new Set(rows.filter((r) => r.status === 'disabled' || r.status === 'deprecated').map((r) => r.id));
          customDefs = rows
            .filter((r) => r.source === 'custom' && r.status !== 'disabled')
            .map((r) => r.definition as unknown as SimeRule);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    const valid: SimeRule[] = [];
    let failed = 0;
    for (const { file, data } of defs) {
      try {
        if (disabledIds.has(String(data['id']))) continue; // builtin 被禁用
        valid.push(data as unknown as SimeRule);
      } catch (e) {
        failed++;
        this.logger.error(`规则装载失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      // 自定义规则并入编译（坏规则逐条跳过，不拖垮平台）
      for (const c of customDefs) {
        try { valid.push(c); } catch { failed++; }
      }
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

  /** 版本轮询：config.rules.version 变化 → 热重建（全分片生效，≤15s 延迟）。 */
  private rulesVersion = '';
  private startVersionPoll(): void {
    const db = this.pg.database;
    if (!db) return;
    const poll = async () => {
      try {
        const rows = (await (db as any).selectFrom('config').select('value').where('key', '=', 'rules.version').execute()) as { value: unknown }[];
        const v = JSON.stringify(rows[0]?.value ?? '');
        if (this.rulesVersion && v !== this.rulesVersion) {
          this.logger.log(`规则版本变化 ${v} → 热重建引擎`);
          await this.buildEngine();
        }
        this.rulesVersion = v;
      } catch { /* PG 抖动忽略 */ }
    };
    void poll();
    setInterval(() => void poll(), 15_000).unref();
  }

  /** 写操作后 bump 版本（API 调用），触发全分片热更新。 */
  async bumpRulesVersion(): Promise<void> {
    const db = this.pg.database;
    if (!db) return;
    await (db as any)
      .insertInto('config')
      .values({ key: 'rules.version', value: JSON.stringify(String(Date.now())) })
      .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(String(Date.now())), updated_at: (globalThis as any).sqlNow ?? new Date() }))
      .execute();
    await this.buildEngine(); // 本进程立即生效
  }

  private compileFailures = 0;
}
