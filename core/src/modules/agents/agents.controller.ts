import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TelemetryService } from '../../telemetry/telemetry.service';
import { InventoryService } from '../../agents/inventory.service';

/** Agent 家族台账（docs/agent-family.md）：六类 Agent + 外部设备的统一清单。 */
@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly tel: TelemetryService,
    private readonly inv: InventoryService,
  ) {}

  @Get()
  agents() {
    return this.tel.agents();
  }

  /** 资产清单摘要：哪些设备有快照 + 系统概要（OS/进程数/软件数）。 */
  @Get('inventory')
  inventoryList() {
    return { count: this.inv.count(), rows: this.inv.list() };
  }

  /** 单设备清单快照：主机/CPU/内存/磁盘 + 进程 Top + 已装软件。 */
  @Get('inventory/:deviceId')
  inventoryOne(@Param('deviceId') deviceId: string) {
    const snap = this.inv.get(deviceId);
    if (!snap) throw new NotFoundException(`该设备尚无资产清单（agent 需 0.2.0+，首次上报约在接入后 3 秒）`);
    return snap;
  }
}
