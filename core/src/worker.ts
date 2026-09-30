import { AssetRegistryService } from './common/asset-registry.service';
import { PgProfileService } from './common/pg-profile.service';
import { ResponseService } from './response/response.service';
import { RuleEngineService } from './rule-engine/rule-engine.service';
import { TelemetryService } from './telemetry/telemetry.service';
import { PlaybookService } from './soar/playbook.service';
import { MqttIngestService } from './ingest/mqtt-ingest.service';

/**
 * 分片 worker（M3 多核分片）：
 * 手工组装服务图（无 HTTP）——规则引擎窗口状态/遥测缓冲/PG 持久化/SOAR 全部
 * 分片内自治；告警经 process.send 上报主进程做 WS 广播。
 * 同设备事件由主进程哈希保证落同分片，聚合窗口正确性不牺牲。
 */
export class WorkerMain {
  async start(): Promise<void> {
    const pg = new PgProfileService();
    await pg.init();
    const registry = new AssetRegistryService();
    registry.onModuleInit();
    const response = new ResponseService(pg);
    const engineSvc = new RuleEngineService(registry, pg, response);
    engineSvc.onModuleInit();
    const tel = new TelemetryService(pg, registry, engineSvc);
    tel.onModuleInit();
    const playbook = new PlaybookService(pg, response, engineSvc);
    playbook.onModuleInit();

    engineSvc.onAlert((a) => {
      if (process.send) {
        try {
          process.send({ type: 'alert', alert: a });
        } catch { /* 主进程忙时丢弃，PG 已持久化 */ }
      }
    });

    // 统计上报（10s）：主进程聚合后供 /health 分片视图
    setInterval(() => {
      if (process.send) {
        try {
          process.send({
            type: 'stats',
            stats: {
              shard: process.env.SIME_SHARD ?? '-',
              rules: engineSvc.engine.rules.length,
              alerts: engineSvc.engine.alerts.length,
              telemetryBuffered: 0,
            },
          });
        } catch { /* 忽略 */ }
      }
    }, 10000);

    process.on('message', (m: { kind?: string; deviceId?: string; body?: Record<string, unknown>; ts?: number }) => {
      try {
        const ts = Number(m?.ts) || Date.now();
        if (m?.kind === 'tel' && m.deviceId && m.body) tel.ingest(m.deviceId, m.body, ts);
        else if (m?.kind === 'evt' && m.body) engineSvc.feed(m.body, ts);
      } catch (e) {
        console.warn(`[sime-worker ${process.pid}] message error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    // MQTT 订阅归主进程（单一消费者），worker 只消费主进程分发的消息
    void MqttIngestService;
    console.log(`[sime-worker ${process.pid}] shard ready (rules=${engineSvc.engine.rules.length})`);
  }
}
