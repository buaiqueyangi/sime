import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgProfileService } from '../common/pg-profile.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';

/** 资产核对默认黑名单：进程名/命令行、软件包名（大小写不敏感子串匹配）。
 *  可在 config 表覆盖：key=asset.banned_processes / asset.banned_software，值为 JSON 数组。 */
const DEFAULT_BANNED_PROCESSES = ['xmrig', 'cpuminer', 'minerd', 'cryptominer', 'stratum+tcp', 'kinsing', 'kdevtmpfsi'];
const DEFAULT_BANNED_SOFTWARE: string[] = [];

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

  constructor(
    private readonly pg: PgProfileService,
    private readonly engine: RuleEngineService,
  ) {}

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

  /** 上报入口（MQTT inventory 主题）：内存即写 + PG 覆盖 upsert + 平台侧核对。 */
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
    // 核对是平台自检（瘦 Agent 胖平台）：失败不影响清单入库
    try {
      await this.runChecks(deviceId, snap.assetId, body);
    } catch (e) {
      this.logger.warn(`inventory checks failed ${deviceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 平台侧资产核对：黑名单进程/软件 → 合成告警（走完整处置链路）。 */
  private async runChecks(deviceId: string, assetId: string, body: Record<string, unknown>): Promise<void> {
    const [procPatterns, swPatterns] = await Promise.all([this.configList('asset.banned_processes', DEFAULT_BANNED_PROCESSES), this.configList('asset.banned_software', DEFAULT_BANNED_SOFTWARE)]);
    const procs = (((body['processes'] as Record<string, unknown> | undefined)?.['top'] as Record<string, unknown>[]) ?? []);
    for (const p of procs) {
      const name = String(p['name'] ?? '').toLowerCase();
      const cmd = String(p['cmd'] ?? '').toLowerCase();
      const hit = procPatterns.find((pat) => name.includes(pat) || cmd.includes(pat));
      if (hit) {
        this.engine.raise({
          ruleId: 'rule.asset.cryptominer-process',
          severity: 'critical',
          groupKey: deviceId,
          summary: `资产清单核对发现疑似恶意进程：${p['name']}（PID ${p['pid']}，用户 ${p['user'] || '未知'}，命中特征 "${hit}"）`,
          // 与引擎 extractContext 同一扁平键约定：剧本 token（process.name/dst.asset_id）直接可解析
          context: {
            'process.name': p['name'],
            'process.pid': p['pid'],
            'process.command_line': p['cmd'],
            'user.name': p['user'],
            'dst.asset_id': assetId || deviceId,
            host: (body['host'] as Record<string, unknown>) ?? {},
          },
        });
        return; // 每设备每轮最多一条，避免刷屏
      }
    }
    const sw = (body['software'] as { name?: string }[]) ?? [];
    for (const s of sw) {
      const name = String(s['name'] ?? '').toLowerCase();
      if (swPatterns.find((pat) => name.includes(pat))) {
        this.engine.raise({
          ruleId: 'rule.asset.banned-software',
          severity: 'high',
          groupKey: deviceId,
          summary: `资产清单核对发现违禁软件：${s['name']}`,
          context: { 'dst.asset_id': assetId || deviceId, software: s },
        });
        return;
      }
    }
  }

  /** config 表黑名单（JSON 数组），未配置回落默认。 */
  private async configList(key: string, fallback: string[]): Promise<string[]> {
    const db = this.pg.database;
    if (!db) return fallback;
    try {
      const rows = (await db.selectFrom('config').select('value').where('key', '=', key).execute()) as { value: unknown }[];
      const v = rows[0]?.value;
      if (Array.isArray(v)) return v.map(String).map((s) => s.toLowerCase());
    } catch {
      /* 表未建/未配置：回落默认 */
    }
    return fallback;
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
