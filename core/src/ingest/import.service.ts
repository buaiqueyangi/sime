import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AssetRegistryService } from '../common/asset-registry.service';
import { envNum } from '../common/env';
import { getCompiled } from '../adapter-engine/adapter-engine';
import type { AdapterDef } from '../adapter-engine/adapter-engine';
import { expandDotted, SimeDomain } from './event-normalizer';
import { IngestBatchResult, IngestIssue, IngestService } from './ingest.service';
import { detectPcap, PcapParser, PcapStats } from './pcap';

/**
 * 流量包导入（POST /api/v1/ingest/import）。
 *
 * 支持两种输入，都走 IngestService 同一条管道（归一 → events 表 → 规则引擎）：
 *  1. **ECS JSONL / JSON 数组** —— 已经是标准事件，直接入库；
 *  2. **适配器模式（adapter=<id>）** —— 每行是厂商原始日志，先用注册表里的
 *     适配器映射成 ECS 点号键，再展开成嵌套结构入库。这条路径让"现场拿来
 *     一堆防火墙日志，配个适配器就能回放"成为可用功能，而不是文档里的承诺。
 *
 * 为什么整包读进内存再解析：multipart 字段顺序不可保证（adapter 可能在文件之后
 * 才到），边解析边入库会拿到未生效的参数。因此统一在文件收齐、参数确定后解析；
 * 单文件上限由 SIME_IMPORT_MAX_BYTES 控制（默认 64MB），事件条数上限由
 * SIME_IMPORT_MAX_EVENTS 控制（默认 5 万条），两者都远超单次回放的实际需要。
 */
export interface ImportOptions {
  source?: string;
  domain?: SimeDomain;
  adapter?: string;
  persist?: boolean;
  feed?: boolean;
  maxEvents?: number;
  deadlineMs?: number;
  /** pcap：flow（默认，按五元组聚合）| packet（逐包一条，受 maxPackets 约束） */
  mode?: 'flow' | 'packet';
  maxFlows?: number;
  maxPackets?: number;
}

export interface ImportReport extends IngestBatchResult {
  file: string;
  bytes: number;
  format: 'jsonl' | 'json-array' | 'json' | 'adapter-lines' | 'pcap' | 'pcapng';
  adapter?: string;
  source: string;
  stored: boolean;
  fed: boolean;
  /** 仅 pcap/pcapng：解析统计（包数/流数/分片/截断/链路层） */
  pcap?: PcapStats;
}

/** 上传体积上限（multipart 单文件）。pcap 走流式解析，不需要整包进内存，故可放宽。 */
export const IMPORT_MAX_BYTES = Math.max(envNum('SIME_IMPORT_MAX_BYTES', 512 * 1024 * 1024, 1024), 1024);

/** 文本格式（JSONL/JSON/适配器模式）的上限：整包读成字符串，内存约为 2×，必须单独设闸 */
export const IMPORT_MAX_TEXT_BYTES = Math.min(
  IMPORT_MAX_BYTES,
  Math.max(envNum('SIME_IMPORT_MAX_TEXT_BYTES', 128 * 1024 * 1024, 1024), 1024),
);

@Injectable()
export class ImportService {
  private readonly logger = new Logger('Import');

  constructor(
    private readonly ingest: IngestService,
    private readonly registry: AssetRegistryService,
  ) {}

  /** 解析文本为事件数组；格式判定见文件头注释。解析失败的行以 line+reason 形式单独返回。 */
  private parse(
    text: string,
    adapterId: string | undefined,
  ): { rows: { raw: unknown; line?: number }[]; errors: IngestIssue[]; format: ImportReport['format']; adapter?: string } {
    const body = text.replace(/^\uFEFF/, '').trim();
    if (!body) throw new BadRequestException('文件为空');

    const errors: IngestIssue[] = [];
    if (adapterId) {
      const entry = this.registry.get('adapters').entries.find(({ data }) => data['id'] === adapterId);
      if (!entry) throw new BadRequestException(`适配器不存在: ${adapterId}`);
      const compiled = getCompiled(entry.data as unknown as AdapterDef);
      const rows: { raw: unknown; line?: number }[] = [];
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          // 适配器产出打平的点号键，必须展开成嵌套 ECS，规则引擎才认 getPath
          rows.push({ raw: expandDotted(compiled.map(line)), line: i + 1 });
        } catch (e) {
          if (errors.length < 20) errors.push({ line: i + 1, reason: `适配器解析失败: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      return { rows, errors, format: 'adapter-lines', adapter: adapterId };
    }

    if (body.startsWith('[')) {
      let arr: unknown;
      try {
        arr = JSON.parse(body);
      } catch (e) {
        throw new BadRequestException(`JSON 数组解析失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!Array.isArray(arr)) throw new BadRequestException('文件不是 JSON 数组');
      return { rows: arr.map((raw, i) => ({ raw, line: i + 1 })), errors, format: 'json-array' };
    }

    if (!body.startsWith('{')) {
      const head = body.slice(0, 24).replace(/\s+/g, ' ');
      throw new BadRequestException(
        `无法识别的内容（以 "${head}" 开头）：只支持 ECS JSONL / JSON 数组；CSV 请先用 SIME QL 导出为 JSONL，或用 adapter 模式导入原始日志`,
      );
    }

    // 单行 JSON：整包解析，兼容美化输出
    if (!body.includes('\n')) {
      try {
        const one = JSON.parse(body);
        if (Array.isArray(one)) return { rows: one.map((raw, i) => ({ raw, line: i + 1 })), errors, format: 'json-array' };
        return { rows: [{ raw: one, line: 1 }], errors, format: 'json' };
      } catch (e) {
        throw new BadRequestException(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const rows: { raw: unknown; line?: number }[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        rows.push({ raw: JSON.parse(line), line: i + 1 });
      } catch (e) {
        if (errors.length < 20) errors.push({ line: i + 1, reason: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return { rows, errors, format: 'jsonl' };
  }

  async importBuffer(buf: Buffer, filename: string, opts: ImportOptions = {}): Promise<ImportReport> {
    if (buf.length > IMPORT_MAX_BYTES) {
      throw new BadRequestException(
        `文件 ${buf.length} 字节超过上限 ${IMPORT_MAX_BYTES}，请拆分后再导入（SIME_IMPORT_MAX_BYTES 可调）`,
      );
    }
    // pcap/pcapng 是二进制：必须在"含 NUL 就拒"之前分流，否则抓包永远进不来
    if (detectPcap(buf.subarray(0, 4))) {
      return this.importPcapBuffer(buf, filename, opts);
    }
    const text = buf.toString('utf8');
    if (text.includes('\u0000')) {
      throw new BadRequestException('文件含二进制内容：只支持 JSONL/JSON（或适配器模式）与 pcap/pcapng 抓包');
    }

    const parsed = this.parse(text, opts.adapter);
    const source = opts.source ?? (parsed.adapter ? `adapter:${parsed.adapter}` : 'import');

    const result = await this.ingest.ingestBatch(parsed.rows, {
      source,
      domain: opts.domain,
      persist: opts.persist,
      feed: opts.feed,
      maxEvents: opts.maxEvents ?? Number(process.env.SIME_IMPORT_MAX_EVENTS ?? 50_000),
      deadlineMs: opts.deadlineMs ?? Number(process.env.SIME_IMPORT_DEADLINE_MS ?? 60_000),
    });

    // 行级解析失败（JSON 坏行 / 适配器未命中）与归一化失败合并成一份错误清单
    const errors = [...parsed.errors, ...result.errors].slice(0, 20);
    const rejected = result.rejected + parsed.errors.length;

    this.logger.log(
      `import ${filename} (${parsed.format}) → 接收 ${result.accepted} / 拒绝 ${rejected} / 告警 ${result.alerts} (${result.ms}ms)`,
    );

    return {
      ...result,
      rejected,
      errors,
      file: filename,
      bytes: buf.length,
      format: parsed.format,
      adapter: parsed.adapter,
      source,
      stored: opts.persist !== false,
      fed: opts.feed !== false,
    };
  }

  /** 内存里的抓包（小文件 / 裸 body 路径） */
  private importPcapBuffer(buf: Buffer, filename: string, opts: ImportOptions): Promise<ImportReport> {
    const parser = new PcapParser({
      mode: opts.mode,
      maxFlows: opts.maxFlows,
      maxPackets: opts.maxPackets,
      file: filename,
    });
    parser.push(buf);
    parser.end();
    return this.finishPcap(parser, buf.length, filename, opts);
  }

  /**
   * 流式抓包：调用方在上传过程中边收边喂（multipart 大包走这条），
   * 这里只负责"解析结果 → events 表 → 规则引擎"。
   */
  async importPcapStream(
    parser: PcapParser,
    bytes: number,
    filename: string,
    opts: ImportOptions = {},
  ): Promise<ImportReport> {
    return this.finishPcap(parser, bytes, filename, opts);
  }

  private async finishPcap(
    parser: PcapParser,
    bytes: number,
    filename: string,
    opts: ImportOptions,
  ): Promise<ImportReport> {
    const stats = parser.stats;
    const events = parser.events();
    const source = opts.source ?? 'pcap';
    if (!events.length) {
      throw new BadRequestException(
        `抓包解析完成但没有可用事件：包 ${stats.packets} / 成功解码 ${stats.parsed}` +
          `（不支持的链路层 ${stats.unsupportedLink}、IP 分片 ${stats.fragments}）。` +
          '802.11/PPI 等链路类型请先用 `editcap -T ether` 转换；加密隧道需先解密。',
      );
    }

    const result = await this.ingest.ingestBatch(events.map((raw) => ({ raw })), {
      source,
      domain: opts.domain,
      persist: opts.persist,
      feed: opts.feed,
      maxEvents: opts.maxEvents ?? Number(process.env.SIME_IMPORT_MAX_EVENTS ?? 50_000),
      deadlineMs: opts.deadlineMs ?? Number(process.env.SIME_IMPORT_DEADLINE_MS ?? 60_000),
    });

    const span =
      stats.firstMs !== null && stats.lastMs !== null
        ? `${new Date(stats.firstMs).toISOString()} ~ ${new Date(stats.lastMs).toISOString()}`
        : '未知';
    this.logger.log(
      `pcap ${filename} (${stats.format}) → 包 ${stats.packets} / 流 ${stats.flows} → 事件 ${result.accepted} / 告警 ${result.alerts} (${result.ms}ms)`,
    );

    const pcapNote = `抓包时间跨度 ${span}，按五元组聚合为 ${stats.flows} 条 flow 事件（mode=${opts.mode ?? 'flow'}）`;
    return {
      ...result,
      errors: result.errors.slice(0, 20),
      warning: result.warning ? `${result.warning}（${pcapNote}）` : undefined,
      file: filename,
      bytes,
      format: stats.format,
      source,
      stored: opts.persist !== false,
      fed: opts.feed !== false,
      pcap: stats,
    };
  }
}
