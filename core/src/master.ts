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
import { envStr } from './common/env';
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

  // 根路径直达控制台：直接输 http://host:port 不该吃 404（现网最常见的"页面打不开"）
  const http_ = app.getHttpAdapter().getInstance();
  http_.get('/', (_req: Request, res: Response) => res.redirect('/ui/'));

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

  // 控制台页面（vanilla 静态资源，构建期拷贝到 dist/ui）。
  // index.html 必须 no-cache：它带着 app.js 的版本戳，缓存了旧 index 就永远
  // 加载不到新脚本（生产教训：发版后用户浏览器仍跑旧 app.js）。
  // app.js 等资源带短 max-age + 版本戳查询串，发版即失效。
  app.useStaticAssets(path.join(__dirname, 'ui'), {
    prefix: '/ui',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  // API 契约文档：代码即契约
  const doc = new DocumentBuilder()
    .setTitle('SIME Core API')
    .setDescription('开源智慧集成管理平台：物联运维 + 安全运营统一契约')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  // 启动即把"会在生产咬人"的配置缺口喊出来：这两项没设置时平台能跑，
  // 但一个是默认口令、一个是重启即全端下线，不能静默。
  if (!envStr('SIME_ADMIN_PASSWORD')) {
    console.warn('[sime] 警告：SIME_ADMIN_PASSWORD 未设置，正在使用默认管理员口令，生产环境必须覆盖');
  }
  if (!envStr('SIME_AUTH_SECRET')) {
    console.warn('[sime] 警告：SIME_AUTH_SECRET 未设置，本次启动将随机生成，重启后所有登录会话失效');
  }

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
