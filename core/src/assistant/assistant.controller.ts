import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssistantService, ChatTurn } from './assistant.service';

@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('status')
  status() {
    return { mode: this.assistant.stubEnabled() ? 'offline-demo (stub)' : 'llm', tools: 7 };
  }

  @Post('chat')
  async chat(@Body() body: { message?: string; history?: ChatTurn[] }) {
    return this.assistant.chat(body?.message ?? '', body?.history ?? []);
  }
}
