import { BadGatewayException, BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryService, SimeQLError } from './query.service';

/**
 * SIME QL 统一查询入口（蓝图 §5.6：`POST /api/v1/query` 是平台唯一查询面）。
 *
 * 之前告警/遥测/审计各有一个专用端点，字段口径和过滤能力互不相同；
 * 这里把它们收敛到同一门语言，控制台只学一次语法。
 */
@ApiTags('query')
@Controller('query')
export class QueryController {
  constructor(private readonly query: QueryService) {}

  /** 数据源 + 语法目录：控制台据此做字段补全 */
  @ApiOperation({ summary: 'SIME QL 数据源与语法目录' })
  @Get('sources')
  sources() {
    return this.query.catalog();
  }

  /** 只编译不执行：编辑器里回车前先拿到 sql 与字段校验结果 */
  @ApiOperation({ summary: '校验 SIME QL（编译但不执行）' })
  @HttpCode(200)
  @Post('validate')
  validate(@Body() body: { q?: string; query?: string }) {
    const q = body?.q ?? body?.query ?? '';
    try {
      return this.query.validate(q);
    } catch (e) {
      throw this.toHttp(e);
    }
  }

  /** 执行查询 */
  @ApiOperation({ summary: '执行 SIME QL 查询' })
  @HttpCode(200)
  @Post()
  async run(@Body() body: { q?: string; query?: string; limit?: number; timeout_ms?: number }) {
    const q = body?.q ?? body?.query ?? '';
    if (!q.trim()) throw new BadRequestException('缺少查询语句（body.q）');
    try {
      return await this.query.run(q, {
        ...(body?.limit !== undefined ? { limit: Number(body.limit) } : {}),
        ...(body?.timeout_ms !== undefined ? { timeoutMs: Number(body.timeout_ms) } : {}),
      });
    } catch (e) {
      throw this.toHttp(e);
    }
  }

  private toHttp(e: unknown): Error {
    if (e instanceof SimeQLError) {
      switch (e.kind) {
        case 'syntax':
        case 'compile':
          return new BadRequestException({ message: e.message, kind: e.kind, pos: e.detail?.pos });
        case 'timeout':
          return new BadRequestException({ message: e.message, kind: e.kind });
        case 'unavailable':
          return new BadGatewayException({ message: e.message, kind: e.kind });
        default:
          return new BadGatewayException({ message: e.message, kind: e.kind });
      }
    }
    return e instanceof Error ? e : new BadGatewayException('查询失败');
  }
}
