import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ResponseService } from '../../response/response.service';

@ApiTags('responses')
@Controller('responses')
export class ResponsesController {
  constructor(private readonly response: ResponseService) {}

  /** 处置闭环视图：工单 / 通知 / 响应审计（最近 20 条） */
  @Get()
  lists() {
    return this.response.lists();
  }
}
