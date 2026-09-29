import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly registry: AssetRegistryService,
    private readonly engine: RuleEngineService,
  ) {}

  @Get()
  health() {
    const errors = this.registry.errors();
    return {
      status: 'ok',
      version: '0.1.0',
      assets: this.registry.counts(),
      assetErrors: errors.length,
      ruleEngine: { compiled: this.engine.engine.rules.length, alerts: this.engine.engine.alerts.length },
      pgProfile: this.engine.pgActive ? 'active' : 'memory-only',
    };
  }
}
