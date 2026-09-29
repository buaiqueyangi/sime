import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly engine: RuleEngineService) {}

  @Get()
  list() {
    const e = this.engine.engine;
    return {
      stats: e.stats(),
      pgActive: this.engine.pgActive,
      items: e.alerts.slice(-50).reverse(),
    };
  }
}
