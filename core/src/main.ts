import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import * as path from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.enableShutdownHooks(); // Linux 生产：SIGTERM 优雅退出（compose/systemd 滚动重启零丢事件）

  // 控制台页面（vanilla 静态资源，构建期拷贝到 dist/ui）
  app.useStaticAssets(path.join(__dirname, 'ui'), { prefix: '/ui' });

  // API 契约文档（蓝图 §5.6）：代码即契约
  const doc = new DocumentBuilder()
    .setTitle('SIME Core API')
    .setDescription('开源智慧集成管理平台：物联运维 + 安全运营统一契约')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.SIME_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`[sime-core] listening on :${port} (console /ui, docs /docs, prefix /api/v1)`);
}

void bootstrap();
