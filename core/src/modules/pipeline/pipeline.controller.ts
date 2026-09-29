import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';
import { attackScenario } from '../../rule-engine/scenario';

@ApiTags('pipeline')
@Controller('pipeline')
export class PipelineController {
  constructor(private readonly engine: RuleEngineService) {}

  /** 一键攻击回放：内置确定性场景经规则引擎产出告警（演示/验收用，幂等由冷却保证）。 */
  @Post('simulate')
  simulate(@Body() body: { reset?: boolean }) {
    if (body?.reset) this.engine.rebuild();
    const events = attackScenario();
    let newAlerts = 0;
    for (const { ev, ts } of events) {
      newAlerts += this.engine.feed(ev, ts).length;
    }
    return {
      events: events.length,
      newAlerts,
      stats: this.engine.engine.stats(),
      note: '同一分组在同一窗口期内由冷却机制去重；点"重置引擎"可清零状态后再回放。',
    };
  }
}
