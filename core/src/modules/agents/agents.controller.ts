import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TelemetryService } from '../../telemetry/telemetry.service';

/** Agent 家族台账（docs/agent-family.md）：六类 Agent + 外部设备的统一清单。 */
@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly tel: TelemetryService) {}

  @Get()
  agents() {
    return this.tel.agents();
  }
}
