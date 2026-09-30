import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import cluster from 'node:cluster';
import mqtt, { MqttClient } from 'mqtt';
import { TelemetryService, TelemetryPoint } from '../telemetry/telemetry.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';

/**
 * MQTT 设备接入服务（M1/M3）：
 *   sime/v1/{deviceId}/telemetry  payload: {asset_id?, kind?, ts?, points:{...}} 或 {point, value}
 *   sime/v1/{deviceId}/event      payload: ECS 基线事件 → 规则引擎
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
    private readonly engine: RuleEngineService,
  ) {}

  onModuleInit(): void {
    const url = process.env.SIME_MQTT_URL;
    if (!url || process.env.SIME_MQTT_INGEST === '0') {
      this.logger.log(`MQTT 接入关闭（url=${url ?? '未设置'}, ingest=${process.env.SIME_MQTT_INGEST ?? '1'}）`);
      return;
    }
    this.client = mqtt.connect(url, { clientId: `sime-core-${Date.now() % 100000}`, reconnectPeriod: 3000 });
    this.client.on('connect', () => {
      this.logger.log(`mqtt connected: ${url}${this.sharded ? ` (sharded → ${WORKERS()} workers)` : ' (inline)'}`);
      this.client!.subscribe(['sime/v1/+/telemetry', 'sime/v1/+/event']);
    });
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
    } catch (e) {
      this.logger.warn(`bad message ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 哈希分发：同 key 必落同 worker（窗口状态一致性）；无 worker 时主进程内联处理。 */
  private dispatchOrRun(key: string, deviceId: string, ts: number, msg: { kind: string; deviceId: string; body: Record<string, unknown>; ts: number } | { kind: 'evt'; body: Record<string, unknown>; ts: number }): void {
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
      if (this.engine.feed(m.body, m.ts).length) this.alerts++;
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
    };
  }
}

function WORKERS(): number {
  return Number(process.env.SIME_WORKERS ?? 1);
}
