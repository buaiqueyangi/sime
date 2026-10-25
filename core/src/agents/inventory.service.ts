import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';

export interface InventorySnapshot {
  deviceId: string;
  assetId: string;
  data: Record<string, unknown>;
  collectedAt: string | null;
  updatedAt: number;
}

/**
 * Agent 资产清单（inventory 主题）：每设备最新快照，内存优先 + PG 回源。
 * 低频（每设备 10 分钟一条）、覆盖式写入——CMDB 语义，不做历史留存（events 表才有追溯需求）。
 */
@Injectable()
export class InventoryService implements OnModuleInit {
  private readonly logger = new Logger('Inventory');
  private mem = new Map<string, InventorySnapshot>();

  constructor(private readonly pg: PgProfileService) {}

  onModuleInit() {
    this.pg
      .init()
      .then(async (ok) => {
        if (ok) await this.loadAll();
      })
      .catch((e) => this.logger.warn(`inventory pg init skipped: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async loadAll(): Promise<void> {
    const db = this.pg.database;
    if (!db) return;
    try {
      const rows = (await db
        .selectFrom('agent_inventory')
        .selectAll()
        .execute()) as { device_id: string; asset_id: string | null; data: unknown; collected_at: string | Date | null; updated_at: Date }[];
      for (const r of rows) {
        this.mem.set(r.device_id, {
          deviceId: r.device_id,
          assetId: r.asset_id ?? '',
          data: (r.data ?? {}) as Record<string, unknown>,
          collectedAt: r.collected_at ? new Date(r.collected_at).toISOString() : null,
          updatedAt: new Date(r.updated_at).getTime(),
        });
      }
      this.logger.log(`inventory loaded: ${this.mem.size} device(s)`);
    } catch (e) {
      this.logger.warn(`inventory load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 上报入口（MQTT inventory 主题）：内存即写 + PG 覆盖 upsert。 */
  async store(deviceId: string, body: Record<string, unknown>): Promise<void> {
    const snap: InventorySnapshot = {
      deviceId,
      assetId: String(body['asset_id'] ?? ''),
      data: body,
      collectedAt: body['collected_at'] ? String(body['collected_at']) : new Date().toISOString(),
      updatedAt: Date.now(),
    };
    this.mem.set(deviceId, snap);
    const db = this.pg.database;
    if (!db) return;
    try {
      await db
        .insertInto('agent_inventory')
        .values({
          device_id: deviceId,
          asset_id: snap.assetId,
          data: JSON.stringify(snap.data),
          collected_at: new Date(snap.collectedAt ?? Date.now()),
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column('device_id').doUpdateSet({
          asset_id: snap.assetId,
          data: JSON.stringify(snap.data),
          collected_at: new Date(snap.collectedAt ?? Date.now()),
          updated_at: new Date(),
        }))
        .execute();
    } catch (e) {
      this.logger.warn(`inventory store failed ${deviceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 台账侧摘要：设备 → 是否有清单 + 采集时间。 */
  list(): { deviceId: string; assetId: string; collectedAt: string | null; os: string; processes: number; software: number }[] {
    return [...this.mem.values()]
      .map((s) => ({
        deviceId: s.deviceId,
        assetId: s.assetId,
        collectedAt: s.collectedAt,
        os: String((s.data['host'] as Record<string, unknown> | undefined)?.['os'] ?? ''),
        processes: Number((s.data['processes'] as Record<string, unknown> | undefined)?.['count'] ?? 0),
        software: Array.isArray(s.data['software']) ? (s.data['software'] as unknown[]).length : 0,
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  get(deviceId: string): InventorySnapshot | undefined {
    return this.mem.get(deviceId);
  }

  count(): number {
    return this.mem.size;
  }
}
