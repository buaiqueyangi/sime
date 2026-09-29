import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetRegistryService } from '../common/asset-registry.service';
import { PgProfileService } from '../common/pg-profile.service';
import { RuleEngine, SimeAlert, SimeRule } from './rule-engine';

/** 规则内核的 Nest 承载：启动即编译规则库，feed 入口供接入/回放层调用。 */
@Injectable()
export class RuleEngineService implements OnModuleInit {
  private readonly logger = new Logger('RuleEngine');
  engine!: RuleEngine;
  pgActive = false;

  constructor(
    private readonly registry: AssetRegistryService,
    private readonly pg: PgProfileService,
  ) {}

  onModuleInit() {
    const defs = this.registry.get('rules').entries.map(({ file, data }) => {
      try {
        return data as unknown as SimeRule;
      } catch (e) {
        throw new Error(`规则编译失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    this.engine = new RuleEngine(defs);
    this.logger.log(`rules compiled: ${this.engine.rules.length}`);
    this.pg
      .init()
      .then((ok) => {
        this.pgActive = ok;
        if (ok) this.logger.log('alerts persisted to pg');
      })
      .catch((e) => this.logger.warn(`pg init skipped: ${e instanceof Error ? e.message : String(e)}`));
  }

  feed(event: Record<string, unknown>, tsMs: number): SimeAlert[] {
    const produced = this.engine.feed(event, tsMs);
    for (const a of produced) {
      void this.pg.insertAlert(a).catch(() => undefined);
    }
    return produced;
  }
}
