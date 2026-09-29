import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';

@ApiTags('rules')
@Controller('rules')
export class RulesController {
  constructor(private readonly registry: AssetRegistryService) {}

  @Get()
  list() {
    return this.registry.get('rules').entries.map(({ file, data }) => ({
      id: data['id'],
      name: data['name'],
      domain: data['domain'],
      category: data['category'],
      severity: data['severity'],
      tactics: data['tactics'],
      techniques: data['techniques'],
      status: data['status'],
      file,
    }));
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
