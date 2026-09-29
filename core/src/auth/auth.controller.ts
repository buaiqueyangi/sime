import { Body, Controller, Post, Req, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    return this.auth.login(body?.username ?? '', body?.password ?? '');
  }

  @Get('me')
  me(@Req() req: { user?: { username: string; exp: number } }) {
    return { user: req.user ?? null };
  }
}
