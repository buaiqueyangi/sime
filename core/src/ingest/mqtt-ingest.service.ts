import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import cluster from 'node:cluster';
import { hostname } from 'node:os';
import mqtt, { MqttClient } from 'mqtt';
import { TelemetryService } from '../telemetry/telemetry.service';
import { IngestService } from './ingest.service';
import { WsService } from '../ws/ws.service';

/**
 * MQTT 设备接入服务（M1/M3）：
 *   sime/v1/{deviceId}/telemetry  payload: {asset_id?, kind?, ts?, points:{...}} 或 {point, value}
 *   sime/v1/{deviceId}/event      payload: ECS 基线事件 → 统一摄入管道（events 表 + 规则引擎）
 * 单进程模式（SIME_WORKERS=1）：本服务内联处理（登记/遥测/规则）。
 * 多分片模式（SIME_WORKERS>1）：主进程只做接收与哈希分发（同设备必落同分片），
 * 计算与持久化在 worker 内自治。
 */
@Injectable()
export class MqttIngestService implements OnModuleInit {
  private readonly logger = new Logger('MqttIngest');
  private client?: MqttClient;
  private received = 0;
  private dispatched = 0;
  private alerts = 0;
  private readonly sharded = Number(process.env.SIME_WORKERS ?? 1) > 1;

  constructor(
    private readonly tel: TelemetryService,
    private readonly ingest: IngestService,
    private readonly ws: WsService,
  ) {}

  onModuleInit(): void {
    const url = process.env.SIME_MQTT_URL;
    if (!url || process.env.SIME_MQTT_INGEST === '0') {
      this.logger.log(`MQTT 接入关闭（url=${url ?? '未设置'}, ingest=${process.env.SIME_MQTT_INGEST ?? '1'}）`);
      return;
    }
    // clientId 必须可预测：随机/带时间戳的 clientId 会让每次重启都留下一个游离会话，
    // broker 侧看到的"设备"越积越多，排障时根本分不清哪个是活的（现网踩过）。
    const clientId = process.env.SIME_MQTT_CLIENT_ID ?? `sime-core-${hostname().slice(0, 16)}`;
    this.client = mqtt.connect(url, { clientId, reconnectPeriod: 3000, clean: true });
    this.client.on('connect', () => {
      this.logger.log(`mqtt connected: ${url} clientId=${clientId}${this.sharded ? ` (sharded → ${WORKERS()} workers)` : ' (inline)'}`);
      this.client!.subscribe(['sime/v1/+/telemetry', 'sime/v1/+/event'], { qos: 0 }, (err, granted) => {
        if (err) {
          this.logger.error(`mqtt subscribe failed: ${err.message}`);
          return;
        }
        // 订阅被 broker 拒绝时 granted.qos = 128，连接看着是好的但一条消息都收不到
        const denied = (granted ?? []).filter((g) => g.qos === 128).map((g) => g.topic);
        if (denied.length) this.logger.error(`mqtt subscribe denied: ${denied.join(', ')}（ACL 或 broker 配置问题）`);
        else this.logger.log(`mqtt subscribed: ${(granted ?? []).map((g) => g.topic).join(', ')}`);
      });
    });
    this.client.on('reconnect', () => this.logger.warn('mqtt reconnecting...'));
    this.client.on('offline', () => this.logger.warn('mqtt offline'));
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.client.on('error', (e) => this.logger.warn(`mqtt: ${e.message}`));
  }

  private onMessage(topic: string, payload: Buffer): void {
    try {
      const parts = topic.split('/'); // sime/v1/{deviceId}/{kind}
      const deviceId = parts[2]!;
      const kind = parts[3]!;
      const body = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      this.received++;
      const rawTs = body['ts'] ?? body['@timestamp'];
      const parsed = rawTs ? Date.parse(String(rawTs)) : NaN;
      const ts = Number.isNaN(parsed) ? Date.now() : parsed;

      if (kind === 'telemetry') {
        this.dispatchOrRun(deviceId, deviceId, ts, { kind: 'tel', deviceId, body, ts });
      } else if (kind === 'event') {
        const key = String(body['src'] && (body['src'] as Record<string, unknown>)['asset'] ? JSON.stringify((body['src'] as Record<string, unknown>)['asset']) : deviceId);
        this.dispatchOrRun(key, deviceId, ts, { kind: 'evt', body, ts });
      }
      // WS 遥测批播（主进程侧解析完成后即可推送，单/分片模式一致）
      const assetId = String(body['asset_id'] ?? deviceId);
      const points = body['points'] as Record<string, unknown> | undefined;
      const wpts: { assetId: string; point: string; value: number; ts: number }[] = [];
      if (points && typeof points === 'object') {
        for (const [point, value] of Object.entries(points)) {
          const num = Number(value);
          if (Number.isFinite(num)) wpts.push({ assetId, point, value: num, ts });
        }
      } else if (body['point'] !== undefined && Number.isFinite(Number(body['value']))) {
        wpts.push({ assetId, point: String(body['point']), value: Number(body['value']), ts });
      }
      if (wpts.length) this.ws.pushTelemetry(wpts);
    } catch (e) {
      this.logger.warn(`bad message ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 哈希分发：同 key 必落同 worker（窗口状态一致性）；无 worker 时主进程内联处理。 */
  private dispatchOrRun(key: string, deviceId: string, ts: number, msg: { kind: string; deviceId?: string; body: Record<string, unknown>; ts: number } | { kind: 'evt'; body: Record<string, unknown>; ts: number }): void {
    if (this.sharded) {
      const workers = Object.values(cluster.workers ?? {}).filter((w) => w?.isConnected());
      if (workers.length) {
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
        const target = workers[Math.abs(h) % workers.length]!;
        if (target.send(msg)) {
          this.dispatched++;
          return;
        }
      }
      // 无可用 worker：主进程兜底内联
    }
    if ('points' in msg || (msg as { kind: string }).kind === 'tel') {
      const m = msg as { deviceId: string; body: Record<string, unknown>; ts: number };
      this.tel.ingest(m.deviceId, m.body, m.ts);
    } else {
      const m = msg as { body: Record<string, unknown>; ts: number };
      // 事件走统一摄入管道：归一 → events 表 → 规则引擎（与 HTTP 导入同一条链）
      if (this.ingest.ingest(m.body, { source: 'mqtt', fallbackTs: m.ts }).length) this.alerts++;
    }
  }

  stats() {
    return {
      enabled: !!process.env.SIME_MQTT_URL && process.env.SIME_MQTT_INGEST !== '0',
      connected: !!this.client?.connected,
      received: this.received,
      dispatched: this.dispatched,
      alertsFromEvents: this.alerts,
      sharded: this.sharded,
      eventStore: this.ingest.stats().store,
    };
  }
}

function WORKERS(): number {
  return Number(process.env.SIME_WORKERS ?? 1);
}
