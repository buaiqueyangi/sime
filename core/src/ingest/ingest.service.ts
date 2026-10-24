import { Injectable, Logger } from '@nestjs/common';
import { RuleEngineService } from '../rule-engine/rule-engine.service';
import { SimeAlert } from '../rule-engine/rule-engine';
import { EventStoreService } from './event-store.service';
import { normalizeEvent, NormalizeOptions, SimeDomain, StoredEvent, tryNormalize } from './event-normalizer';

/**
 * 统一摄入管道（P1 的核心）：**归一 → 落库 → 规则引擎**，四条入口共用。
 *
 *   MQTT `sime/v1/+/event`   ┐
 *   POST /ingest/events      ├─→ IngestService.ingest ─→ events 表 + RuleEngine
 *   POST /ingest/import      │
 *   POST /pipeline/simulate  ┘
 *
 * 落库与研判解耦：`persist=false` 只研判（在线试算），`feed=false` 只入库
 * （历史补录，不想触发一堆历史告警时用）。
 */
export interface IngestOptions extends NormalizeOptions {
  /** 写 events 表，默认 true */
  persist?: boolean;
  /** 喂规则引擎，默认 true */
  feed?: boolean;
}

export interface IngestIssue {
  line?: number;
  reason: string;
}

export interface IngestBatchResult {
  accepted: number;
  rejected: number;
  alerts: number;
  events: number;
  errors: IngestIssue[];
  /** 超过 maxEvents / deadline 被丢弃的条数 */
  skipped: number;
  truncated: boolean;
  ms: number;
  /** 数据形态提示（如"历史数据仍开了研判"），不影响结果，只影响怎么用 */
  warning?: string;
}

const MAX_ERRORS = 20;
/** 每处理这么多条让出一次事件循环：导入 5 万条时 HTTP 端口不能被独占 */
const YIELD_EVERY = 2000;

@Injectable()
export class IngestService {
  private readonly logger = new Logger('Ingest');
  private totals = { events: 0, alerts: 0, rejected: 0 };

  constructor(
    private readonly store: EventStoreService,
    private readonly engine: RuleEngineService,
  ) {}

  /** 单条事件入库 + 研判，返回本次新产生的告警。格式错误抛 EventFormatError。 */
  ingest(raw: unknown, opts: IngestOptions = {}): SimeAlert[] {
    const stored = normalizeEvent(raw, opts);
    return this.accept(stored, opts);
  }

  private accept(stored: StoredEvent, opts: IngestOptions): SimeAlert[] {
    this.totals.events++;
    if (opts.persist !== false) this.store.add(stored);
    if (opts.feed === false) return [];
    // 引擎要求时间单调不回退：乱序事件由批量路径先排序，单条路径按到达顺序处理
    const alerts = this.engine.feed(stored.payload, stored.ts.getTime());
    this.totals.alerts += alerts.length;
    return alerts;
  }

  /**
   * 批量摄入（文件导入 / 回放）：先整批归一化并按时间排序，再顺序喂引擎。
   *
   * 排序不是锦上添花：规则引擎的滑动窗口按 ts 前推，时间回退会把已聚合的
   * 桶剪掉，导入一份乱序的历史日志会系统性少报。这里用内存换正确性，
   * 上限由 maxEvents 兜住（默认 5 万条）。
   */
  async ingestBatch(
    rows: { raw: unknown; line?: number }[],
    opts: IngestOptions & { maxEvents?: number; deadlineMs?: number } = {},
  ): Promise<IngestBatchResult> {
    const t0 = Date.now();
    const maxEvents = Math.max(Math.trunc(opts.maxEvents ?? 50_000), 1);
    const deadlineMs = Math.max(Math.trunc(opts.deadlineMs ?? 60_000), 1000);
    const errors: IngestIssue[] = [];
    const accepted: StoredEvent[] = [];
    let rejected = 0;
    let skipped = 0;
    let truncated = false;

    for (const { raw, line } of rows) {
      const r = tryNormalize(raw, opts);
      if (!r.ok) {
        rejected++;
        this.totals.rejected++;
        if (errors.length < MAX_ERRORS) errors.push({ line, reason: r.reason });
        continue;
      }
      if (accepted.length >= maxEvents) {
        skipped++;
        truncated = true;
        continue;
      }
      accepted.push(r.event);
    }

    accepted.sort((a, b) => a.ts.getTime() - b.ts.getTime());

    let alerts = 0;
    let processed = 0;
    for (const ev of accepted) {
      if (Date.now() - t0 > deadlineMs) {
        skipped += accepted.length - processed;
        truncated = true;
        break;
      }
      alerts += this.accept(ev, opts).length;
      processed++;
      if (processed % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    }

    if (opts.persist !== false) await this.store.drain();

    // 历史数据 + 开研判 = 引擎时间水位被拉回过去，实时规则的窗口会被清空重来。
    // 不擅自关掉 feed（有人确实要"按历史数据重算一遍"），但必须把代价说清楚。
    let warning: string | undefined;
    const newest = accepted.length ? accepted[accepted.length - 1]!.ts.getTime() : 0;
    if (opts.feed !== false && processed > 0 && newest > 0 && Date.now() - newest > 3600_000) {
      const mins = Math.round((Date.now() - newest) / 60_000);
      warning =
        `导入数据最新一条比当前时间早 ${mins} 分钟：研判会把规则引擎的时间水位回退，` +
        `实时规则的滑窗会被清空。历史补录建议用 feed=false（只入库不研判）。`;
    }

    return {
      accepted: processed,
      rejected,
      alerts,
      events: rows.length,
      errors,
      skipped,
      truncated,
      ms: Date.now() - t0,
      ...(warning ? { warning } : {}),
    };
  }

  stats() {
    return { ...this.totals, store: this.store.stats(), engine: this.engineStats() };
  }

  /** 落库通道是否可用：内存模式下导入会"接收成功但什么都没留下"，必须提前拒绝 */
  get persistenceReady(): boolean {
    return this.store.ready;
  }

  /**
   * 把写缓冲排干。
   * HTTP 摄入路径返回前必须调用：接口语义是"返回即已可查"，否则调用方紧接着
   * `GET /events` 会读不到刚推的事件（300ms 缓冲窗口）。MQTT 路径不调，吞吐优先。
   */
  async flush(): Promise<void> {
    await this.store.drain();
  }

  private engineStats(): unknown {
    try {
      return this.engine.engine.stats();
    } catch {
      return null;
    }
  }

  /** 域参数解析：接口层传上来的字符串收敛到白名单，非法值当作未指定。 */
  static domain(v: unknown): SimeDomain | undefined {
    return v === 'it' || v === 'ot' || v === 'merged' ? v : undefined;
  }

  /** 布尔参数解析：multipart/query 里全是字符串，"false"/"0" 必须当成 false。 */
  static flag(v: unknown, dflt: boolean): boolean {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    return dflt;
  }
}
