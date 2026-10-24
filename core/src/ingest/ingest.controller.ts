import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import Busboy from 'busboy';
import { IngestService } from './ingest.service';
import { IMPORT_MAX_BYTES, IMPORT_MAX_TEXT_BYTES, ImportOptions, ImportService } from './import.service';
import { detectPcap, PcapParser } from './pcap';

/**
 * 摄入端点：把"平台外的数据"送进平台。
 *
 *   POST /api/v1/ingest/events  —— 单条或数组（JSON），供采集器/脚本直推
 *   POST /api/v1/ingest/import  —— 流量包文件（multipart 或裸 ndjson 流）
 *   GET  /api/v1/ingest/stats   —— 摄入计数（收到/入库/丢弃/告警）
 *
 * 两条写路径最终都落到 IngestService，与 MQTT 接入完全同构。
 */
@ApiTags('ingest')
@Controller('ingest')
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly importer: ImportService,
  ) {}

  @Get('stats')
  stats() {
    return this.ingest.stats();
  }

  /**
   * 事件直推。兼容三种 body 形状：
   *   {event}  /  {events:[...]}  /  直接一个事件对象（或数组）
   * 查询参数：source / domain / persist / feed（脚本可只研判不入库）。
   */
  @Post('events')
  @HttpCode(200)
  async push(@Body() body: unknown, @Query() q: Record<string, string>) {
    const rec = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const qs = q ?? {};
    const source = qs['source'] ?? (typeof rec['source'] === 'string' ? rec['source'] : 'http');
    const opts = {
      source,
      domain: IngestService.domain(qs['domain'] ?? rec['domain']),
      persist: IngestService.flag(qs['persist'] ?? rec['persist'], true),
      feed: IngestService.flag(qs['feed'] ?? rec['feed'], true),
    };

    let list: unknown[];
    if (Array.isArray(rec['events'])) list = rec['events'];
    else if (Array.isArray(body)) list = body;
    else if (rec['event'] !== undefined) list = [rec['event']];
    else if (body && typeof body === 'object') list = [body];
    else throw new BadRequestException('body 必须是事件对象、事件数组或 {events:[...]}');

    if (!list.length) throw new BadRequestException('事件列表为空');
    if (opts.persist && !this.ingest.persistenceReady) {
      throw new ServiceUnavailableException('存储未启用（缺少 SIME_PG_HOST 或初始化失败）；如需只做在线研判可加 ?persist=false');
    }

    if (list.length === 1) {
      const alerts = this.ingest.ingest(list[0], opts);
      // 返回即可查：HTTP 推送不是热路径，等一次刷盘（毫秒级）换取确定的可读语义
      if (opts.persist) await this.ingest.flush();
      return { accepted: 1, rejected: 0, alerts: alerts.length, alertIds: alerts.map((a) => a.id) };
    }
    const r = await this.ingest.ingestBatch(
      list.map((raw, i) => ({ raw, line: i + 1 })),
      opts,
    );
    return { ...r, alertIds: [] };
  }

  /**
   * 流量包导入。
   *
   *   curl -F file=@events.jsonl -F adapter=fortigate -F source=import \
   *        -H "Authorization: Bearer $T" http://host:13000/api/v1/ingest/import
   *   curl -F file=@capture.pcap "?mode=flow" ...        # 抓包：流式解析，不受内存限制
   *   curl --data-binary @events.jsonl -H 'Content-Type: application/x-ndjson' ...
   *
   * multipart 字段：file（必需）、adapter / domain / source / persist / feed。
   * `mode`（flow|packet）只认查询参数：抓包是边收边解析的，等不到 form 字段。
   */
  @Post('import')
  @HttpCode(200)
  async import(@Req() req: Request, @Query() q: Record<string, string>) {
    const ct = String(req.headers['content-type'] ?? '');
    const qs = q ?? {};
    let buf: Buffer | undefined;
    let parser: PcapParser | undefined;
    let streamedSize = 0;
    let filename: string;
    const fields: Record<string, string> = { ...qs };

    if (ct.includes('multipart/form-data')) {
      const parsed = await readMultipart(req, qs['mode']);
      Object.assign(fields, parsed.fields);
      if (!parsed.file) throw new BadRequestException('缺少文件字段 file（form-data 单文件上传）');
      filename = parsed.file.name;
      streamedSize = parsed.file.size;
      buf = parsed.file.buf;
      parser = parsed.file.parser;
    } else if (ct.includes('application/json')) {
      // express.json() 已解析：整包 JSON（数组或单个事件）
      const text = JSON.stringify(req.body ?? null);
      buf = Buffer.from(text, 'utf8');
      filename = String(req.headers['x-sime-filename'] ?? 'body.json');
    } else {
      buf = await readRaw(req, IMPORT_MAX_BYTES);
      filename = String(req.headers['x-sime-filename'] ?? 'upload.ndjson');
    }

    if (parser) {
      // 抓包：字节已经流式喂给解析器，这里只做落库
      if (!streamedSize) throw new BadRequestException('文件为空');
      return this.importer.importPcapStream(parser, streamedSize, filename, this.opts(fields));
    }
    if (!buf || !buf.length) throw new BadRequestException('文件为空');
    return this.importer.importBuffer(buf, filename, this.opts(fields));
  }

  /** 统一的导入参数解析（含 persist/persist=false 时"内存模式不许假成功"的闸） */
  private opts(fields: Record<string, string>): ImportOptions {
    const persist = IngestService.flag(fields['persist'], true);
    if (persist && !this.ingest.persistenceReady) {
      // 内存模式下"导入成功"是谎言：事件进不了库，查不到也研判不了历史
      throw new ServiceUnavailableException('存储未启用（缺少 SIME_PG_HOST 或初始化失败），无法导入事件');
    }
    const raw = fields['mode'];
    const mode: 'flow' | 'packet' | undefined = raw === 'packet' ? 'packet' : raw === 'flow' ? 'flow' : undefined;
    return {
      adapter: fields['adapter'] || undefined,
      source: fields['source'] || undefined,
      domain: IngestService.domain(fields['domain']),
      persist,
      feed: IngestService.flag(fields['feed'], true),
      maxEvents: fields['max_events'] ? Number(fields['max_events']) : undefined,
      mode,
    };
  }
}

interface PartFile {
  name: string;
  size: number;
  /** 文本格式：整包缓冲 */
  buf?: Buffer;
  /** 抓包：上传过程中已流式喂入解析器，不占内存 */
  parser?: PcapParser;
}

/**
 * multipart 文件名解码：浏览器按 UTF-8 发送，busboy 按 latin1 解，
 * 中文名会变成 "å®éª2 …" 这种乱码（现网实测）。这里做一次 latin1→utf8 回转，
 * 回转不合法（出现替换符）就保持原样，避免把正常 ASCII 名字搞坏。
 */
function decodeName(s: string): string {
  if (!s || !/[\u0080-\u00ff]/.test(s)) return s;
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('\ufffd') ? s : utf8;
}

/**
 * 流式解析 multipart：单文件 + 文本字段，文件大小硬上限。
 *
 * 关键点：**边收边判定格式**。看到前 4 字节是 pcap/pcapng 魔数就转流式解析，
 * 之后每个 chunk 直接喂解析器——几百 MB 的抓包也不会把整包读进内存。
 * 文本格式仍整包缓冲（解析前必须先拿到完整文本），另设 IMPORT_MAX_TEXT_BYTES 闸。
 */
function readMultipart(
  req: Request,
  mode?: string,
): Promise<{ file?: PartFile; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: IMPORT_MAX_BYTES, fields: 20, fieldSize: 8192, parts: 24 },
      });
    } catch (e) {
      reject(new BadRequestException(`multipart 解析失败: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const fields: Record<string, string> = {};
    let file: PartFile | undefined;
    let tooLarge = false;
    let tooLargeText = false;
    let tooMany = false;
    let settled = false;

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    bb.on('field', (name, value) => {
      if (Object.keys(fields).length < 20) fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      if (file || (name !== 'file' && name !== 'data')) {
        stream.resume(); // 只收第一个文件，其余丢弃（limits.files=1 也会拦）
        return;
      }
      const fileName = decodeName(info.filename || 'upload.jsonl');
      let size = 0;
      let parser: PcapParser | undefined;
      let decided = false;
      let head: Buffer[] = [];
      const chunks: Buffer[] = [];

      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > IMPORT_MAX_BYTES) { tooLarge = true; return; }
        if (!decided) {
          head.push(c);
          const acc = Buffer.concat(head);
          if (acc.length < 4) return; // 不够魔数，继续攒
          decided = true;
          head = [];
          if (detectPcap(acc.subarray(0, 4))) {
            parser = new PcapParser({
              mode: mode === 'packet' ? 'packet' : 'flow',
              file: fileName,
            });
            parser.push(acc);
          } else {
            chunks.push(acc);
          }
          return;
        }
        if (parser) { parser.push(c); return; }
        if (size > IMPORT_MAX_TEXT_BYTES) { tooLargeText = true; return; }
        chunks.push(c);
      });
      stream.on('limit', () => { tooLarge = true; });
      stream.on('end', () => {
        if (tooLarge || tooLargeText) return;
        if (!decided) {
          // 文件不足 4 字节：当作空/无效文本
          const rest = Buffer.concat(head);
          if (rest.length) chunks.push(rest);
        }
        if (parser) {
          try {
            parser.end();
          } catch (e) {
            fail(new BadRequestException(`抓包解析失败: ${e instanceof Error ? e.message : String(e)}`));
            return;
          }
          file = { name: fileName, size, parser };
        } else {
          file = { name: fileName, size, buf: Buffer.concat(chunks) };
        }
      });
      stream.on('error', (e: Error) => fail(new BadRequestException(`文件上传中断: ${e.message}`)));
    });
    bb.on('filesLimit', () => {
      tooMany = true;
    });
    bb.on('error', (e: Error) => fail(new BadRequestException(`multipart 解析失败: ${e.message}`)));
    bb.on('close', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(new PayloadTooLargeException(
          `文件超过上限 ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB（SIME_IMPORT_MAX_BYTES 可调）；` +
            '超大抓包建议用 editcap -c 分批',
        ));
        return;
      }
      if (tooLargeText) {
        reject(new PayloadTooLargeException(
          `文本流量包超过上限 ${Math.round(IMPORT_MAX_TEXT_BYTES / 1048576)} MB（SIME_IMPORT_MAX_TEXT_BYTES 可调）；` +
            '请拆分后导入（抓包走 pcap 流式解析，不受此限）',
        ));
        return;
      }
      if (tooMany) {
        reject(new BadRequestException('一次只支持一个文件'));
        return;
      }
      resolve({ file, fields });
    });
    req.pipe(bb);
  });
}

/** 裸 body 读取（Content-Type 非 multipart 时走这里），超限立即掐断连接。 */
function readRaw(req: Request, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        reject(new PayloadTooLargeException(`请求体超过上限 ${max} 字节（SIME_IMPORT_MAX_BYTES 可调）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}
