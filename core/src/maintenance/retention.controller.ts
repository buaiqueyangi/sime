import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RetentionService } from './retention.service';

/**
 * 日志保留策略（P0）。
 *
 * - `GET  /api/v1/retention`      策略 + 各表体量 + 最近 20 次运行记录
 * - `POST /api/v1/retention/run`  立即执行一次，`{"dry_run":true}` 只统计不删
 */
@ApiTags('retention')
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @ApiOperation({ summary: '保留策略与表体量' })
  @Get()
  status() {
    return this.retention.status();
  }

  @ApiOperation({ summary: '执行一次保留清理（可干跑）' })
  @HttpCode(200)
  @Post('run')
  async run(@Body() body: { dry_run?: boolean; tables?: string[] }) {
    return this.retention.run({
      dryRun: body?.dry_run === true,
      ...(Array.isArray(body?.tables) ? { tables: body.tables.filter((t) => typeof t === 'string') } : {}),
    });
  }
}
