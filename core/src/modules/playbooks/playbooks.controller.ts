import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlaybookService } from '../../soar/playbook.service';

@ApiTags('playbooks')
@Controller('playbooks')
export class PlaybooksController {
  constructor(private readonly soar: PlaybookService) {}

  /** SOAR 剧本清单 + 最近执行记录 */
  @Get()
  list() {
    return { playbooks: this.soar.list(), recentRuns: this.soar.recentRuns() };
  }
}
