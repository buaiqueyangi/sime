import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { PgProfileService } from '../common/pg-profile.service';
import { AssetRegistryService } from '../common/asset-registry.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';

/**
 * 遥测服务（M1）：内存实时档 + PG 持久档双轨。
 * 查询永远先走内存（实时性），重启后内存为空时回源 PG；
 * 写入路径做物模型量程检查，越限自动产生 range_breach 事件进规则引擎（遥测越限告警）。
 * 规模上来后此接口平移时序库 profile（蓝图 §6.1），上层不动。
 */
export interface TelemetryPoint {
  assetId: string;
  point: string;
  value: number;
  ts: number;
}

const SERIES_CAP = 1200;

interface PointRange {
  min: number;
  max: number;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger('Telemetry');
  private latestMap = new Map<string, { ts: number; value: number }>();
  private seriesMap = new Map<string, { ts: number; value: number }[]>();
  private deviceMap = new Map<string, { assetId: string; kind: string; firstSeen: number; lastSeen: number }>();
  private rangeMap = new Map<string, PointRange>();

  constructor(
    private readonly pg: PgProfileService,
    private readonly registry: AssetRegistryService,
    private readonly engine: RuleEngineService,
  ) {}

  /** PG 写入缓冲：300ms 批量刷盘（多行 INSERT + 单语句多行 upsert），解决逐行写瓶颈（M1 压测结论）。 */
  private pending: { asset_id: string; point: string; ts: Date; value: number }[] = [];
  private flushing = false;
  private flushTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    this.flushTimer = setInterval(() => void this.flush(), 300);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const rows = this.pending.splice(0, this.pending.length);
    try {
      const db = this.pg.database;
      if (db && rows.length) {
        await db.insertInto('telemetry').values(rows).execute();
        // point_latest 同键多行去重（保留最新），单语句多行 upsert
        const latestByKey = new Map<string, (typeof rows)[number]>();
        for (const r of rows) latestByKey.set(`${r.asset_id}|${r.point}`, r);
        await db
          .insertInto('point_latest')
          .values([...latestByKey.values()])
          .onConflict((oc) =>
            oc.columns(['asset_id', 'point']).doUpdateSet({ ts: sql`excluded.ts`, value: sql`excluded.value` }),
          )
          .execute();
      }
    } catch (e) {
      // 失败回灌队首（限流防爆炸）
      this.pending.unshift(...rows.slice(0, 20000));
      this.logger.warn(`telemetry flush failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.flushing = false;
    }
  }

  /** 从物模型模板聚合各测点量程（点名唯一时生效），供越限检查。 */
  private buildRangeMap(): void {
    for (const { data } of this.registry.get('thing-models').entries) {
      const props = (data['properties'] as { id?: string; range?: number[] }[]) ?? [];
      for (const p of props) {
        if (p.id && Array.isArray(p.range) && p.range.length === 2 && !this.rangeMap.has(p.id)) {
          this.rangeMap.set(p.id, { min: p.range[0]!, max: p.range[1]! });
        }
      }
    }
  }

  registerDevice(deviceId: string, assetId: string, kind = 'device'): void {
    const prev = this.deviceMap.get(deviceId);
    this.deviceMap.set(deviceId, {
      assetId,
      kind,
      firstSeen: prev?.firstSeen ?? Date.now(),
      lastSeen: Date.now(),
    });
    const db = this.pg.database;
    if (db) {
      void db
        .insertInto('assets')
        .values({ id: assetId, name: assetId, type: kind, domain: 'ot' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
        .catch(() => undefined);
      void db
        .insertInto('devices')
        .values({ id: deviceId, asset_id: assetId })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
        .catch(() => undefined);
    }
  }

  private welford = new Map<string, { n: number; mean: number; m2: number; lastAnomaly: number }>();

  record(points: TelemetryPoint[]): void {
    if (!this.rangeMap.size) this.buildRangeMap();
    const db = this.pg.database;
    const rows: { asset_id: string; point: string; ts: Date; value: number }[] = [];
    for (const p of points) {
      const key = `${p.assetId}|${p.point}`;
      this.latestMap.set(key, { ts: p.ts, value: p.value });
      let s = this.seriesMap.get(key);
      if (!s) {
        s = [];
        this.seriesMap.set(key, s);
      }
      s.push({ ts: p.ts, value: p.value });
      if (s.length > SERIES_CAP) s.splice(0, s.length - SERIES_CAP);
      if (db) rows.push({ asset_id: p.assetId, point: p.point, ts: new Date(p.ts), value: p.value });
    // 压测结论：逐行 upsert 是瓶颈 —— 统一进缓冲，300ms 批量刷盘
    if (db) {
      this.pending.push(rows[rows.length - 1]!);
      if (this.pending.length >= 20000) void this.flush();
    }

      // 物模型量程越限 → range_breach 事件 → 规则引擎（遥测越限告警）
      const range = this.rangeMap.get(p.point);
      if (range && (p.value < range.min || p.value > range.max)) {
        this.engine.feed(
          {
            event: { category: 'telemetry', name: 'range_breach', outcome: 'failure' },
            src: { asset: { id: p.assetId } },
            sime: { domain: 'ot' },
            telemetry: { point: p.point, value: p.value, range: [range.min, range.max] },
            '@timestamp': new Date(p.ts).toISOString(),
          },
          p.ts,
        );
      }

      // UEBA：Welford 增量基线 + 3σ 统计异常（每测点独立，60s 限频）
      const w = this.welford.get(key) ?? { n: 0, mean: 0, m2: 0, lastAnomaly: 0 };
      w.n++;
      const delta = p.value - w.mean;
      w.mean += delta / w.n;
      w.m2 += delta * (p.value - w.mean);
      if (w.n >= 30 && p.ts - w.lastAnomaly > 60000) {
        const std = Math.sqrt(w.m2 / (w.n - 1));
        if (std > 0 && Math.abs(p.value - w.mean) > 3 * std) {
          w.lastAnomaly = p.ts;
          this.engine.feed(
            {
              event: { category: 'telemetry', name: 'statistical_anomaly', outcome: 'failure' },
              src: { asset: { id: p.assetId } },
              sime: { domain: 'ot' },
              telemetry: {
                point: p.point,
                value: p.value,
                mean: Math.round(w.mean * 100) / 100,
                std: Math.round(std * 100) / 100,
                score: Math.round((Math.abs(p.value - w.mean) / std) * 100) / 100,
              },
              '@timestamp': new Date(p.ts).toISOString(),
            },
            p.ts,
          );
        }
      }
      this.welford.set(key, w);
    }
    if (db && rows.length) {
      void db
        .insertInto('telemetry')
        .values(rows)
        .execute()
        .catch((e) => this.logger.warn(`telemetry insert: ${e instanceof Error ? e.message : String(e)}`));
      for (const r of rows) {
        void db
          .insertInto('point_latest')
          .values(r)
          .onConflict((oc) => oc.columns(['asset_id', 'point']).doUpdateSet({ ts: r.ts, value: r.value }))
          .execute()
          .catch(() => undefined);
      }
    }
  }

  async latest(): Promise<{ assetId: string; point: string; ts: number; value: number }[]> {
    if (this.latestMap.size) {
      return [...this.latestMap.entries()]
        .map(([k, v]) => {
          const [assetId, point] = k.split('|');
          return { assetId: assetId!, point: point!, ts: v.ts, value: v.value };
        })
        .sort((a, b) => b.ts - a.ts);
    }
    const db = this.pg.database;
    if (!db) return [];
    const rows = await db.selectFrom('point_latest').selectAll().orderBy('ts', 'desc').limit(200).execute();
    return rows.map((r) => ({ assetId: r.asset_id, point: r.point, ts: new Date(r.ts).getTime(), value: r.value }));
  }

  async series(assetId: string, point: string, limit = 240): Promise<{ ts: number; value: number }[]> {
    const mem = this.seriesMap.get(`${assetId}|${point}`);
    if (mem && mem.length) return mem.slice(-limit).map((x) => ({ ts: x.ts, value: x.value }));
    const db = this.pg.database;
    if (!db) return [];
    const rows = await db
      .selectFrom('telemetry')
      .select(['ts', 'value'])
      .where('asset_id', '=', assetId)
      .where('point', '=', point)
      .orderBy('ts', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({ ts: new Date(r.ts).getTime(), value: r.value })).reverse();
  }

  devices(): { deviceId: string; assetId: string; kind: string; lastSeen: number }[] {
    return [...this.deviceMap.entries()]
      .map(([deviceId, d]) => ({ deviceId, assetId: d.assetId, kind: d.kind, lastSeen: d.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
