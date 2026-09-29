import { HttpCode,Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TopologyLayout, TopologyService } from './topology.service';

@ApiTags('topology')
@Controller('topology')
export class TopologyController {
  constructor(private readonly topo: TopologyService) {}

  @Get('layout')
  layout() {
    return this.topo.getLayout();
  }

  @HttpCode(200)

  @Post('layout')
  save(@Body() layout: TopologyLayout) {
    return this.topo.saveLayout(layout);
  }
}
