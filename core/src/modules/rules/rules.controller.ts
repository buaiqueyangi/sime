import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';
import { PgProfileService } from '../../common/pg-profile.service';
import { RuleEngineService } from '../../rule-engine/rule-engine.service';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';

@ApiTags('rules')
@Controller('rules')
export class RulesController {
  constructor(
    private readonly registry: AssetRegistryService,
    private readonly pg: PgProfileService,
    private readonly engineSvc: RuleEngineService,
  ) {}

  private ruleValidator(): (d: unknown) => { ok: boolean; errors: string } {
    const schema = JSON.parse(
      fs.readFileSync(path.join(process.env.SIME_ASSET_ROOT ?? '..', 'rules', 'schema', 'rule.schema.json'), 'utf8'),
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const v = ajv.compile(schema);
    return (d: unknown) => {
      const ok = !!v(d);
      return { ok, errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ') };
    };
  }

  private flat(d: Record<string, unknown>) {
    const det = (d['detection'] ?? {}) as Record<string, unknown>;
    return {
      name: String(d['name'] ?? ''),
      version: String(d['version'] ?? '1.0'),
      domain: String(d['domain'] ?? 'it'),
      category: String(d['category'] ?? 'host-security'),
      severity: String(d['severity'] ?? 'medium'),
      tactics: (d['tactics'] as string[]) ?? [],
      techniques: (d['techniques'] as string[]) ?? [],
      definition: d,
      status: String(d['status'] ?? 'stable'),
    };
  }

  /** 新建自定义规则（Schema 校验 → PG → 全分片热生效）。 */
  @Post()
  @HttpCode(200)
  async create(@Body() body: Record<string, unknown>) {
    const v = this.ruleValidator()(body);
    if (!v.ok) throw new BadRequestException('规则不合规: ' + v.errors);
    const id = String(body['id'] ?? '');
    const db: any = this.pg.database;
    if (!db) throw new BadRequestException('需要 PostgreSQL');
    const exists = await db.selectFrom('rules').select('id').where('id', '=', id).execute();
    if (exists.length) throw new BadRequestException(`规则已存在: ${id}`);
    await db.insertInto('rules').values({ id, ...this.flat(body), source: 'custom', updated_at: new Date() }).execute();
    await this.engineSvc.bumpRulesVersion();
    return { ok: true, id, note: '已创建并热生效（全分片 ≤15s）' };
  }

  /** 编辑（custom 全量可改；builtin 仅允许改 status 走 PATCH）。 */
  @Put(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const db: any = this.pg.database;
    if (!db) throw new BadRequestException('需要 PostgreSQL');
    const row = (await db.selectFrom('rules').select(['id', 'source']).where('id', '=', id).execute())[0];
    if (!row) throw new NotFoundException(`规则不存在: ${id}`);
    if (row.source !== 'custom') throw new BadRequestException('内置规则不可编辑（可禁用）');
    const v = this.ruleValidator()(body);
    if (!v.ok) throw new BadRequestException('规则不合规: ' + v.errors);
    await db.updateTable('rules').set({ ...this.flat(body), source: 'custom', updated_at: new Date() }).where('id', '=', id).execute();
    await this.engineSvc.bumpRulesVersion();
    return { ok: true, id };
  }

  /** 启用/禁用（builtin 与 custom 均可）。 */
  @Patch(':id/status')
  @HttpCode(200)
  async setStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    const st = body?.status ?? '';
    if (!['stable', 'draft', 'disabled', 'deprecated'].includes(st)) throw new BadRequestException('status 须为 stable/draft/disabled/deprecated');
    const db: any = this.pg.database;
    if (!db) throw new BadRequestException('需要 PostgreSQL');
    const rows = await db.updateTable('rules').set({ status: st, updated_at: new Date() }).where('id', '=', id).returning('id').execute();
    if (!rows.length) throw new NotFoundException(`规则不存在: ${id}`);
    await this.engineSvc.bumpRulesVersion();
    return { ok: true, id, status: st };
  }

  /** 删除（仅 custom；builtin 走禁用）。 */
  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    const db: any = this.pg.database;
    if (!db) throw new BadRequestException('需要 PostgreSQL');
    const rows = await db.deleteFrom('rules').where('id', '=', id).where('source', '=', 'custom').returning('id').execute();
    if (!rows.length) throw new BadRequestException('内置规则不可删除（请用禁用）');
    await this.engineSvc.bumpRulesVersion();
    return { ok: true, id };
  }

  @Get()
  async list() {
    const builtin: any[] = this.registry.get('rules').entries.map(({ file, data }) => ({
      id: data['id'],
      name: data['name'],
      domain: data['domain'],
      category: data['category'],
      severity: data['severity'],
      tactics: data['tactics'],
      techniques: data['techniques'],
      status: data['status'],
      file,
      source: 'builtin' as const,
    }));
    const db: any = this.pg.database;
    if (!db) return builtin;
    // 合并 DB 视图：custom 追加；builtin 的禁用状态以 DB 为准（热操作反映）
    const rows = (await db.selectFrom('rules').select(['id', 'name', 'domain', 'category', 'severity', 'tactics', 'techniques', 'status', 'source']).execute()) as Record<string, unknown>[];
    const byId = new Map<string, Record<string, unknown>>(rows.map((r) => [String(r.id), r]));
    const merged = builtin.map((b) => {
      const row = byId.get(b.id);
      return row && row.status === 'disabled' && b.status !== 'disabled' ? { ...b, status: 'disabled' } : b;
    });
    for (const r of rows) {
      if (r.source === 'custom') {
        merged.push({
          id: String(r.id), name: String(r.name), domain: String(r.domain), category: String(r.category),
          severity: String(r.severity), tactics: r.tactics ?? [], techniques: r.techniques ?? [],
          status: String(r.status), file: '(DB)', source: 'custom',
        });
      }
    }
    return merged;
  }

  /** 规则全量定义（六要素）：控制台规则详情弹窗用。 */
  @Get(':id')
  detail(@Param('id') id: string) {
    const entry = this.registry.get('rules').entries.find(({ data }) => data['id'] === id);
    if (!entry) throw new NotFoundException(`规则不存在: ${id}`);
    return { ...entry.data, file: entry.file };
  }

  @Get('stats')
  stats() {
    const entries = this.registry.get('rules').entries;
    const by = (key: 'domain' | 'category' | 'severity') =>
      entries.reduce<Record<string, number>>((acc, { data }) => {
        const k = String(data[key] ?? 'unknown');
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
    return { total: entries.length, byDomain: by('domain'), byCategory: by('category'), bySeverity: by('severity') };
  }
}
