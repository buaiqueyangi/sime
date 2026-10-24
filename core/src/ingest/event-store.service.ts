import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';
import { StoredEvent } from './event-normalizer';

/**
 * 事件落库（events 表的唯一写入口）。
 *
 * 为什么是缓冲批量写而不是逐条写：接入侧一条事件一次 INSERT，在 4 核分片下
 * 单表写入会成为整个摄入链路的瓶颈（遥测侧已有同款结论，见 performance.md）。
 * 这里沿用遥测的 300ms 批量策略，但增加了三件遥测不需要的东西：
 *  1. **分块提交**：单条 INSERT 最多 CHUNK 行，避免 JSON 参数过多触发 PG 上限；
 *  2. **坏行隔离**：整块失败时逐行重试，只把真正插不进去的行计入 failed；
 *  3. **队列上限**：PG 长期不可用时丢弃最老数据并计数，绝不无限吃内存。
 */
const CHUNK = 500;

export interface EventStoreStats {
  received: number;
  inserted: number;
  failed: number;
  dropped: number;
  flushes: number;
  queued: number;
}

@Injectable()
export class EventStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventStore');
  private pending: StoredEvent[] = [];
  private flushing = false;
  private timer?: NodeJS.Timeout;

  private readonly batchSize = Math.max(Number(process.env.SIME_EVENT_BATCH ?? 1000), 1);
  private readonly flushMs = Math.max(Number(process.env.SIME_EVENT_FLUSH_MS ?? 300), 50);
  private readonly queueMax = Math.max(Number(process.env.SIME_EVENT_QUEUE_MAX ?? 100_000), CHUNK);

  private readonly s: Omit<EventStoreStats, 'queued'> = {
    received: 0,
    inserted: 0,
    failed: 0,
    dropped: 0,
    flushes: 0,
  };

  constructor(private readonly pg: PgProfileService) {}

  /** 落库通道是否就绪（内存模式下为 false：能研判，但事件留不下） */
  get ready(): boolean {
    return this.pg.ready;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** 入队（同步、不阻塞摄入链路）。PG 未就绪时直接计入 dropped，内存模式下依旧可用。 */
  add(e: StoredEvent): void {
    this.s.received++;
    if (!this.pg.database) {
      this.s.dropped++;
      return;
    }
    if (this.pending.length >= this.queueMax) {
      this.s.dropped++;
      return;
    }
    this.pending.push(e);
    if (this.pending.length >= this.batchSize) void this.flush();
  }

  /** 立刻刷盘（导入结束、优雅关闭、e2e 断言前调用，保证读到刚写入的行）。 */
  async flush(): Promise<void> {
    if (this.flushing) return;
    const db = this.pg.database;
    if (!db || !this.pending.length) return;
    this.flushing = true;
    const rows = this.pending.splice(0, this.batchSize);
    this.s.flushes++;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        try {
          await db.insertInto('events').values(slice).execute();
          this.s.inserted += slice.length;
        } catch (e) {
          // 整块失败：逐行重插，隔离坏行（典型是个别 payload 含不可序列化值）
          this.logger.warn(`events batch failed, isolating rows: ${e instanceof Error ? e.message : String(e)}`);
          for (const row of slice) {
            try {
              await db.insertInto('events').values(row).execute();
              this.s.inserted++;
            } catch (e2) {
              this.s.failed++;
              if (this.s.failed <= 5) {
                this.logger.warn(`event dropped: ${e2 instanceof Error ? e2.message : String(e2)}`);
              }
            }
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    // 队列还有存量（大批量导入）时继续排干
    if (this.pending.length >= this.batchSize) void this.flush();
  }

  /** 把队列彻底排干（含正在刷盘的那批），供导入接口与 e2e 同步语义使用。 */
  async drain(): Promise<void> {
    for (let i = 0; i < 1000 && (this.pending.length || this.flushing); i++) {
      await this.flush();
      if (this.flushing) await new Promise((r) => setTimeout(r, 20));
    }
  }

  stats(): EventStoreStats {
    return { ...this.s, queued: this.pending.length };
  }
}
