import { HttpCode, Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';
import { attackScenario } from '../../rule-engine/scenario';
import { IngestService } from '../../ingest/ingest.service';

@ApiTags('pipeline')
@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly engine: RuleEngineService,
    private readonly ingest: IngestService,
  ) {}

  /**
   * 一键攻击回放：内置确定性场景经**统一摄入管道**（events 表 + 规则引擎）回放。
   * 与文件导入、MQTT 接入走同一条链，因此 UI 的事件列表和 SIME QL 的 events 源
   * 都能看到这批数据，不再只是内存里的告警。
   */
  @HttpCode(200)
  @Post('simulate')
  simulate(@Body() body: { reset?: boolean }) {
    if (body?.reset) this.engine.rebuild();
    const events = attackScenario();
    let newAlerts = 0;
    for (const { ev, ts } of events) {
      newAlerts += this.ingest.ingest(ev, { source: 'replay', fallbackTs: ts }).length;
    }
    return {
      events: events.length,
      newAlerts,
      stats: this.engine.engine.stats(),
      note: '同一分组在同一窗口期内由冷却机制去重；点"重置引擎"可清零状态后再回放。',
    };
  }
}
