import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetRegistryService } from '../../common/asset-registry.service';

@ApiTags('thing-models')
@Controller('thing-models')
export class ThingModelsController {
  constructor(private readonly registry: AssetRegistryService) {}

  @Get()
  list() {
    return this.registry.get('thing-models').entries.map(({ file, data }) => ({
      id: data['id'],
      category: data['category'],
      label: data['label'],
      propertyCount: Array.isArray(data['properties']) ? (data['properties'] as unknown[]).length : 0,
      eventCount: Array.isArray(data['events']) ? (data['events'] as unknown[]).length : 0,
      security: data['security'],
      file,
    }));
  }
}
