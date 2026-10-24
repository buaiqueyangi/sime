import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { parseQuery, QuerySyntaxError } from '../query/query-parser';
import { ExportFormat, ExportService, pickFilename } from './export.service';

/**
 * 数据导出（P0）：`q` 走 SIME QL，语法与 `/api/v1/query` 完全一致。
 *
 * - `GET  /api/v1/export?q=...&format=csv|jsonl&max_rows=N`  浏览器/curl 直接下载
 * - `POST /api/v1/export`  body `{q, format, max_rows}`        前端 fetch + blob
 *
 * 流式写出：结果集多大都不吃内存。行数与截断标记写进 `maintenance_runs`（导出可追溯）。
 */
@ApiTags('export')
@Controller('export')
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @ApiOperation({ summary: '导出能力目录（格式、上限、可用数据源）' })
  @Get('catalog')
  catalog() {
    return this.exporter.catalog();
  }

  @ApiOperation({ summary: '导出（GET，可直接下载）' })
  @Get()
  async get(
    @Res() res: Response,
    @Query('q') q?: string,
    @Query('format') format?: string,
    @Query('max_rows') maxRows?: string,
  ) {
    await this.handle(res, q, format, maxRows === undefined ? undefined : Number(maxRows));
  }

  @ApiOperation({ summary: '导出（POST）' })
  @HttpCode(200)
  @Post()
  async post(
    @Res() res: Response,
    @Body() body: { q?: string; query?: string; format?: string; max_rows?: number; maxRows?: number },
  ) {
    await this.handle(res, body?.q ?? body?.query, body?.format, body?.max_rows ?? body?.maxRows);
  }

  private async handle(
    res: Response,
    q: string | undefined,
    format: string | undefined,
    maxRows: number | undefined,
  ): Promise<void> {
    if (!q || !q.trim()) throw new BadRequestException('缺少查询语句（q）');
    const fmt: ExportFormat = String(format ?? 'csv').toLowerCase() === 'jsonl' ? 'jsonl' : 'csv';

    // 先解析一遍拿数据源名，保证下载文件名有意义（代价可忽略，服务内会再解析一次）
    let source = 'sime';
    try {
      source = parseQuery(q).source;
    } catch (e) {
      if (e instanceof QuerySyntaxError) throw new BadRequestException(e.message);
      throw e;
    }

    let started = false;
    const write = (chunk: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (res.destroyed || res.writableEnded) return resolve();
        if (!started) {
          res.setHeader(
            'Content-Type',
            fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          );
          res.setHeader('Content-Disposition', `attachment; filename="${pickFilename(source, fmt)}"`);
          res.setHeader('Cache-Control', 'no-store');
          res.flushHeaders();
          started = true;
        }
        if (res.write(chunk)) return resolve();
        res.once('drain', () => resolve());
        res.once('error', reject);
      });

    try {
      await this.exporter.stream(q, fmt, write, {
        ...(Number.isFinite(maxRows) && maxRows ? { maxRows: Number(maxRows) } : {}),
      });
      if (!started) {
        // 零行结果：仍然给出一个合法的空文件，而不是 200 空响应
        res.setHeader('Content-Type', fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${pickFilename(source, fmt)}"`);
      }
      res.end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (started) {
        // 正文已经开始写，状态码无法更改：中断连接，避免客户端把半截文件当成功
        res.destroy();
        return;
      }
      if (/未知数据源|字段|语法|查询为空|limit|不接受|不属于/.test(msg)) {
        throw new BadRequestException(msg);
      }
      throw new BadGatewayException(msg);
    }
  }
}
