import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TelemetryService } from './telemetry.service';

@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly tel: TelemetryService) {}

  @Get('latest')
  latest() {
    return this.tel.latest();
  }

  @Get('series')
  series(
    @Query('asset_id') assetId: string,
    @Query('point') point: string,
    @Query('limit') limit?: string,
  ) {
    return this.tel.series(assetId, point, Number(limit ?? 240));
  }

  @Get('devices')
  async devices() {
    return this.tel.devices();
  }
}
