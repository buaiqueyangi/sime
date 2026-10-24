import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlaybookService } from '../../soar/playbook.service';
import { PgProfileService } from '../../common/pg-profile.service';

@ApiTags('playbooks')
@Controller('playbooks')
export class PlaybooksController {
  constructor(private readonly soar: PlaybookService, private readonly pg: PgProfileService) {}

  /** SOAR 剧本清单 + 最近执行记录 */
  @Get()
  async list() {
    return { playbooks: await this.soar.listWithMeta(), recentRuns: this.soar.recentRuns() };
  }

  private validate(d: Record<string, unknown>): string | null {
    if (!d || typeof d !== 'object') return 'body 必须为对象';
    const id = String(d['id'] ?? '');
    if (!/^pb\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id)) return 'id 须形如 pb.xxx.yyy';
    const tr = d['trigger'] as { rules?: unknown } | undefined;
    if (!tr || !Array.isArray(tr.rules) || !tr.rules.length || !tr.rules.every((r) => typeof r === 'string' && r.startsWith('rule.'))) return 'trigger.rules 须为 rule.* 数组';
    const st = d['steps'];
    if (!Array.isArray(st) || !st.length || !st.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_.]*(\([^()]{0,200}\))?$/.test(x))) return 'steps 须为动作字符串数组';
    if (!d['name'] || String(d['name']).length < 4) return 'name 至少 4 字';
    return null;
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: Record<string, unknown>) {
    const err = this.validate(body);
    if (err) throw new BadRequestException(err);
    const db: any = (this.pg as any).database;
    if (!db) throw new BadRequestException('需要 PostgreSQL');
    const exists = await db.selectFrom('playbooks').select('id').where('id', '=', body['id']).execute();
    if (exists.length) throw new BadRequestException(`剧本已存在: ${body['id']}`);
    await db.insertInto('playbooks').values({
      id: body['id'], name: body['name'], version: String(body['version'] ?? '1.0'),
      status: String(body['status'] ?? 'stable'), trigger: JSON.stringify(body['trigger']), steps: JSON.stringify(body['steps']),
      source: 'custom', updated_at: new Date(),
    }).execute();
    await this.soar.bumpVersion();
    return { ok: true, id: body['id'], note: '已创建并热生效' };
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const err = this.validate(body);
    if (err) throw new BadRequestException(err);
    const db: any = (this.pg as any).database;
    const row = (await db.selectFrom('playbooks').select(['id', 'source']).where('id', '=', id).execute())[0];
    if (!row) throw new NotFoundException(`剧本不存在: ${id}`);
    if (row.source !== 'custom') throw new BadRequestException('内置剧本不可编辑（可禁用）');
    await db.updateTable('playbooks').set({
      name: body['name'], version: String(body['version'] ?? '1.0'), status: String(body['status'] ?? 'stable'),
      trigger: JSON.stringify(body['trigger']), steps: JSON.stringify(body['steps']), updated_at: new Date(),
    }).where('id', '=', id).execute();
    await this.soar.bumpVersion();
    return { ok: true, id };
  }

  @Patch(':id/status')
  @HttpCode(200)
  async setStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    const st = body?.status ?? '';
    if (!['stable', 'draft', 'disabled', 'deprecated'].includes(st)) throw new BadRequestException('status 非法');
    const db: any = (this.pg as any).database;
    const rows = await db.updateTable('playbooks').set({ status: st, updated_at: new Date() }).where('id', '=', id).returning('id').execute();
    if (!rows.length) throw new NotFoundException(`剧本不存在: ${id}`);
    await this.soar.bumpVersion();
    return { ok: true, id, status: st };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    const db: any = (this.pg as any).database;
    const rows = await db.deleteFrom('playbooks').where('id', '=', id).where('source', '=', 'custom').returning('id').execute();
    if (!rows.length) throw new BadRequestException('内置剧本不可删除（请用禁用）');
    await this.soar.bumpVersion();
    return { ok: true, id };
  }
}
