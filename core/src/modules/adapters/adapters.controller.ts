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
        // 解析格式与原始样例：控制台"试一下"、流量包导入的 adapter 模式都要靠它自检
        format: (data['parse'] as { format?: string } | undefined)?.format,
        sample: String(data['sample'] ?? ''),
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

  /**
   * 自动识别（日志解析工作台）：贴一段原始日志，遍历全部 30 个适配器尝试解析，
   * 返回所有命中项（含完整 ECS 映射结果），按字段命中数排序——现场不用先知道
   * 日志属于哪家设备。
   */
  @Post('detect')
  detect(@Body() body: { raw?: string }) {
    const raw = (body?.raw ?? '').trim();
    if (!raw) throw new BadRequestException('请提供原始日志（raw）');
    if (raw.length > 65536) throw new BadRequestException('单次最多 64KB');
    const matches: {
      id: string;
      vendor: string;
      product: string;
      protocol: string;
      fieldCount: number;
      mapped: Record<string, unknown>;
    }[] = [];
    const lines = raw.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20); // 多行时逐行找首个可解析样本
    for (const { data } of this.registry.get('adapters').entries) {
      const def = data as unknown as AdapterDef;
      const candidates = lines.length ? lines : [def.sample];
      for (const line of candidates) {
        try {
          const mapped = getCompiled(def).map(line);
          const fieldCount = Object.keys(mapped).length;
          if (fieldCount >= 2) {
            matches.push({
              id: def.id,
              vendor: def.vendor,
              product: def.product,
              protocol: def.protocol,
              fieldCount,
              mapped,
            });
            break; // 该适配器任一行命中即收录
          }
        } catch {
          // 未命中换下一个适配器
        }
      }
    }
    matches.sort((a, b) => b.fieldCount - a.fieldCount);
    return { total: this.registry.get('adapters').entries.length, matched: matches.length, matches };
  }
}
