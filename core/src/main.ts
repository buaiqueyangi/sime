import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.enableShutdownHooks(); // Linux 生产：SIGTERM 优雅退出（compose/systemd 滚动重启零丢事件）

  // API 契约文档（蓝图 §5.6）：代码即契约
  const doc = new DocumentBuilder()
    .setTitle('SIME Core API')
    .setDescription('开源智慧集成管理平台：物联运维 + 安全运营统一契约')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.SIME_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`[sime-core] listening on :${port} (prefix /api/v1, docs /docs)`);
}

void bootstrap();
