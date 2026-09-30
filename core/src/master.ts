import 'reflect-metadata';
import cluster from 'node:cluster';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import * as path from 'path';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { WsService } from './ws/ws.service';
import { WorkerMain } from './worker';

const WORKERS = Number(process.env.SIME_WORKERS ?? 1);

/** 主进程引导：API/WS/MQTT 接入 + 多 worker 分发（SIME_WORKERS > 1 时）。 */
export async function bootstrapMaster(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 内网 HTTP 部署：禁用 helmet 默认的 upgrade-insecure-requests（否则所有子资源被强升 https 而加载失败）
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.enableShutdownHooks();

  // 认证守卫：/api/v1 全保护，豁免 login 与 health（健康检查/登录前状态）
  const auth = app.get(AuthService);
  app.use('/api/v1', (req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    if (p === '/auth/login' || p === '/health') return next();
    const user = auth.verify(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!user) return res.status(401).json({ message: 'unauthorized' });
    (req as unknown as { user: unknown }).user = user;
    next();
  });

  // 控制台页面（vanilla 静态资源，构建期拷贝到 dist/ui）
  app.useStaticAssets(path.join(__dirname, 'ui'), { prefix: '/ui' });

  // API 契约文档：代码即契约
  const doc = new DocumentBuilder()
    .setTitle('SIME Core API')
    .setDescription('开源智慧集成管理平台：物联运维 + 安全运营统一契约')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.SIME_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  const wsSvc = app.get(WsService);
  wsSvc.attach(app.getHttpServer());

  // 多 worker 分片：主进程接入 → 哈希分发；worker 告警回传 → WS 广播
  if (WORKERS > 1) {
    for (let i = 0; i < WORKERS; i++) cluster.fork({ SIME_SHARD: String(i) });
    cluster.on('message', (_worker, msg: { type?: string; alert?: unknown; stats?: Record<string, unknown> }) => {
      if (msg?.type === 'alert' && msg.alert) wsSvc.broadcastAlert(msg.alert as never);
      if (msg?.type === 'stats' && msg.stats) {
        const pid = _worker.process.pid;
        if (pid !== undefined) wsSvc.reportWorkerStats(pid, msg.stats);
      }
    });
    cluster.on('exit', (w) => {
      console.log(`[sime-master] worker ${w.process.pid} exited, reforking...`);
      cluster.fork({ SIME_SHARD: String(Date.now() % 1000) });
    });
    console.log(`[sime-master] listening on :${port} · workers=${WORKERS} (console /ui, docs /docs)`);
  } else {
    console.log(`[sime-core] listening on :${port} (console /ui, docs /docs, prefix /api/v1 · auth on · ws on)`);
  }
}
