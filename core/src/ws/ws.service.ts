import { Injectable, Logger } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service';
import type { SimeAlert } from '../rule-engine/rule-engine';

/**
 * WebSocket 实时推送（M2）：/ws?token=<auth token>
 * 告警产生即广播（毫秒级），UI 轮询保留为一致性兜底。
 */
@Injectable()
export class WsService {
  private readonly logger = new Logger('Ws');
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private pingTimer?: NodeJS.Timeout;

  constructor(private readonly auth: AuthService) {}

  /** 在 main.ts listen 之后挂到 http server 上。 */
  attach(server: import('http').Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket: WebSocket, req: import('http').IncomingMessage) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const user = this.auth.verify(url.searchParams.get('token') ?? '');
      if (!user) {
        socket.close(4401, 'unauthorized');
        return;
      }
      this.clients.add(socket);
      socket.send(JSON.stringify({ type: 'hello', user: user.username }));
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    // 心跳：30s 清理死链
    this.pingTimer = setInterval(() => {
      for (const c of this.clients) {
        if (c.readyState === WebSocket.OPEN) c.ping();
        else this.clients.delete(c);
      }
    }, 30000);
    this.logger.log(`ws ready at /ws`);
  }

  broadcastAlert(alert: SimeAlert): void {
    const msg = JSON.stringify({ type: 'alert', alert });
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(msg);
        } catch {
          this.clients.delete(c);
        }
      }
    }
  }

  broadcastAlertState(pgId: number, state: string): void {
    const msg = JSON.stringify({ type: 'alert-state', pgId, state });
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(msg);
        } catch {
          this.clients.delete(c);
        }
      }
    }
  }

  /** 遥测实时推送：缓冲最新值，2s 批量广播一次（摊薄高频写入的推送成本）。 */
  pushTelemetry(points: { assetId: string; point: string; value: number; ts: number }[]): void {
    for (const p of points) {
      this.telBuffer.set(`${p.assetId}|${p.point}`, p);
    }
    if (!this.telTimer) {
      this.telTimer = setInterval(() => this.flushTelemetry(), 2000);
    }
  }

  private telBuffer = new Map<string, { assetId: string; point: string; value: number; ts: number }>();
  private telTimer?: NodeJS.Timeout;

  private flushTelemetry(): void {
    if (!this.telBuffer.size || !this.clients.size) return;
    const points = [...this.telBuffer.values()];
    this.telBuffer.clear();
    const msg = JSON.stringify({ type: 'telemetry', points });
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(msg);
        } catch {
          this.clients.delete(c);
        }
      }
    }
  }

  /** worker 统计上报（多分片模式）：主进程聚合后供 /health 展示。 */
  reportWorkerStats(pid: number, stats: Record<string, unknown>): void {
    this.workerStats.set(pid, { ...stats, ts: Date.now() });
  }

  private workerStats = new Map<number, Record<string, unknown>>();

  clusterStats(): { workers: number; shards: Record<string, unknown>[] } {
    const shards = [...this.workerStats.entries()].map(([pid, s]) => ({ pid, ...s }));
    // 清理 60s 未上报的死分片
    const now = Date.now();
    for (const [pid, s] of this.workerStats) {
      if (now - (s as { ts: number }).ts > 60000) this.workerStats.delete(pid);
    }
    return { workers: this.workerStats.size, shards };
  }

  clientCount(): number {
    return this.clients.size;
  }
}
