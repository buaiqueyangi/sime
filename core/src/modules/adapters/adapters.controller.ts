import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';

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
}
