import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PgProfileService } from '../common/pg-profile.service';

/**
 * 组态服务（M2，编辑器 v1）：布局以 KV（config 表）持久化，运行态按布局渲染。
 * 布局未保存的设备由前端自动排布（开箱即有画面，编辑后持久）。
 */
export interface TopologyItem {
  assetId: string;
  x: number;
  y: number;
}

export interface TopologyLayout {
  items: TopologyItem[];
}

@Injectable()
export class TopologyService {
  constructor(private readonly pg: PgProfileService) {}

  async getLayout(): Promise<TopologyLayout> {
    const db = this.pg.database;
    if (!db) return { items: [] };
    const rows = await db
      .selectFrom('config')
      .select('value')
      .where('key', '=', 'topology.layout')
      .execute();
    return (rows[0]?.value as TopologyLayout) ?? { items: [] };
  }

  async saveLayout(layout: TopologyLayout): Promise<void> {
    const db = this.pg.database;
    if (!db) throw new Error('组态布局持久化需要 PostgreSQL');
    const items = (layout?.items ?? [])
      .filter((i) => i && typeof i.assetId === 'string' && Number.isFinite(i.x) && Number.isFinite(i.y))
      .slice(0, 2000)
      .map((i) => ({ assetId: String(i.assetId).slice(0, 128), x: Math.round(i.x), y: Math.round(i.y) }));
    await db
      .insertInto('config')
      .values({ key: 'topology.layout', value: { items } })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: { items }, updated_at: sql`now()` }),
      )
      .execute();
  }
}
