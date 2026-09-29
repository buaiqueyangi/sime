import { HttpCode,BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LakeService } from './lake.service';

@ApiTags('lake')
@Controller('lake')
export class LakeController {
  constructor(private readonly lake: LakeService) {}

  @Get('status')
  status() {
    return this.lake.status();
  }

  /** 快照：PG 最近 24h 遥测/告警 → Parquet（zstd） */
  @HttpCode(200)
  @Post('snapshot')
  snapshot() {
    return this.lake.snapshot();
  }

  /** 受限只读分析查询（DuckDB over Parquet，视图 telemetry / alerts） */
  @HttpCode(200)
  @Post('query')
  async query(@Body() body: { sql?: string }) {
    try {
      return await this.lake.query(body?.sql ?? '');
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : '查询失败');
    }
  }
}
