import { BadRequestException, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ResponseService } from '../../response/response.service';
import { PgProfileService } from '../../common/pg-profile.service';

@ApiTags('responses')
@Controller('responses')
export class ResponsesController {
  constructor(
    private readonly response: ResponseService,
    private readonly pg: PgProfileService,
  ) {}

  /** 处置闭环视图：工单 / 通知 / 响应审计（最近 20 条） */
  @Get()
  lists() {
    return this.response.lists();
  }

  /** 工单关闭（处置完成） */
  @Post('tickets/:id/close')
  async closeTicket(@Param('id') id: string) {
    const db = this.pg.database;
    if (!db) throw new BadRequestException('工单操作需要 PostgreSQL 存储');
    const tid = Number(id);
    if (!Number.isFinite(tid)) throw new BadRequestException('非法工单 ID');
    const rows = await db
      .updateTable('tickets')
      .set({ state: 'closed', closed_at: new Date() })
      .where('id', '=', tid)
      .where('state', '!=', 'closed')
      .returning('id')
      .execute();
    if (!rows.length) throw new NotFoundException('工单不存在或已关闭');
    return { ok: true, id: tid, state: 'closed' };
  }
}
