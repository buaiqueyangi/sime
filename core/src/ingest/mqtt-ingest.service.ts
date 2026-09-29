import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import mqtt, { MqttClient } from 'mqtt';
import { TelemetryService, TelemetryPoint } from '../telemetry/telemetry.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';

/**
 * MQTT 设备接入服务（M1，蓝图 §5.6 南向契约）：
 *   sime/v1/{deviceId}/telemetry  payload: {asset_id?, kind?, ts?, points:{...}} 或 {point, value}
 *   sime/v1/{deviceId}/event      payload: ECS 基线事件 → 规则引擎
 * 设备首次上报自动注册资产/设备台账；未设置 SIME_MQTT_URL 时服务关闭（开箱内存态）。
 */
@Injectable()
export class MqttIngestService implements OnModuleInit {
  private readonly logger = new Logger('MqttIngest');
  private client?: MqttClient;
  private received = 0;
  private alerts = 0;

  constructor(
    private readonly tel: TelemetryService,
    private readonly engine: RuleEngineService,
  ) {}

  onModuleInit(): void {
    const url = process.env.SIME_MQTT_URL;
    if (!url) {
      this.logger.log('SIME_MQTT_URL 未设置，MQTT 接入关闭（演示/内存模式）');
      return;
    }
    this.client = mqtt.connect(url, { clientId: `sime-core-${Date.now() % 100000}`, reconnectPeriod: 3000 });
    this.client.on('connect', () => {
      this.logger.log(`mqtt connected: ${url}`);
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
      if (kind === 'telemetry') {
        const assetId = String(body['asset_id'] ?? deviceId);
        const rawTs = body['ts'] ? Date.parse(String(body['ts'])) : NaN;
        const ts = Number.isNaN(rawTs) ? Date.now() : rawTs;
        this.tel.registerDevice(deviceId, assetId, String(body['kind'] ?? 'device'));
        const pts: TelemetryPoint[] = [];
        const points = body['points'] as Record<string, unknown> | undefined;
        if (points && typeof points === 'object') {
          for (const [point, value] of Object.entries(points)) {
            const num = Number(value);
            if (Number.isFinite(num)) pts.push({ assetId, point, value: num, ts });
          }
        } else if (body['point'] !== undefined && Number.isFinite(Number(body['value']))) {
          pts.push({ assetId, point: String(body['point']), value: Number(body['value']), ts });
        }
        if (pts.length) this.tel.record(pts);
      } else if (kind === 'event') {
        const rawTs = body['@timestamp'] ? Date.parse(String(body['@timestamp'])) : NaN;
        const produced = this.engine.feed(body, Number.isNaN(rawTs) ? Date.now() : rawTs);
        this.alerts += produced.length;
      }
    } catch (e) {
      this.logger.warn(`bad message ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stats() {
    return { enabled: !!process.env.SIME_MQTT_URL, connected: !!this.client?.connected, received: this.received, alertsFromEvents: this.alerts };
  }
}
