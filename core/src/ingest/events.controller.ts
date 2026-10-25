import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EventListQuery, EventListResult, EventsService } from './events.service';

/**
 * events 检索端点（SIME QL 之外的结构化入口）。
 *
 * 与 `/api/v1/query` 的分工：QL 面向"任意组合的表达式分析"，本组端点面向
 * "列表页 + 详情 + 分布图"这类固定形状的读；两者读同一张表、同一套字段。
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** 事件列表（默认最近 24h，倒序，limit 上限 1000；count=1 时附带总数） */
  @Get()
  list(@Query() q: EventListQuery): Promise<EventListResult> {
    return this.events.list(q);
  }

  /** 分布视图：按类别 / 域 / 时间桶（interval 默认 1 hour） */
  @Get('stats')
  stats(@Query() q: EventListQuery & { interval?: string }): Promise<unknown> {
    return this.events.stats(q);
  }

  /** 字段值分布（分面）：?field=user&facet_limit=10 —— 供检索页点击字段弹出的"可选值"列表。 */
  @Get('facets')
  facets(@Query() q: EventListQuery & { field?: string; facet_limit?: number | string }): Promise<unknown> {
    return this.events.facets(q);
  }

  /** 单条事件（含完整 payload，取证用） */
  @Get(':id')
  async one(@Param('id') id: string) {
    const row = await this.events.one(id);
    if (!row) throw new NotFoundException(`事件不存在: ${id}`);
    return row;
  }
}
