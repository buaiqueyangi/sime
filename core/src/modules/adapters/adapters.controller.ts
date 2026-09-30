import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';
import { AdapterDef, getCompiled } from '../../adapter-engine/adapter-engine';

@ApiTags('adapters')
@Controller('adapters')
export class AdaptersController {
  constructor(private readonly registry: AssetRegistryService) {}

  @Get()
  list() {
    return this.registry.get('adapters').entries.map(({ file, data }) => {
      const threatMap = (data['threat_map'] ?? {}) as Record<string, string>;
      return {
        id: data['id'],
        vendor: data['vendor'],
        product: data['product'],
        protocol: data['protocol'],
        threatCount: Object.keys(threatMap).length,
        file,
      };
    });
  }

  /** 在线调试：贴原始日志即时验证解析/映射/归一（现场实施与贡献者调试用）。 */
  @Post(':id/test')
  test(@Param('id') id: string, @Body() body: { raw?: string }) {
    const entry = this.registry.get('adapters').entries.find(({ data }) => data['id'] === id);
    if (!entry) throw new NotFoundException(`适配器不存在: ${id}`);
    const raw = body?.raw ?? (entry.data as unknown as AdapterDef).sample;
    try {
      const compiled = getCompiled(entry.data as unknown as AdapterDef);
      const mapped = compiled.map(raw);
      return { id, ok: true, mapped };
    } catch (e) {
      throw new BadRequestException(`解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
