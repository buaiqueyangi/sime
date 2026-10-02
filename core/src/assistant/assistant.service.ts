import { Injectable, Logger } from '@nestjs/common';
import { AssetRegistryService } from '../common/asset-registry.service';
import { PgProfileService } from '../common/pg-profile.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { LakeService } from '../lake/lake.service';
import { RuleEngineService } from '../rule-engine/rule-engine.service';
import { PlaybookService } from '../soar/playbook.service';
import { WsService } from '../ws/ws.service';

/**
 * LLM 运维助手（M3）：
 *   OpenAI 兼容端点（Ollama / vLLM / DeepSeek / Qwen...）+ 平台工具调用。
 *   SIME_LLM_BASEURL/SIME_LLM_APIKEY/SIME_LLM_MODEL 配置真实模型；
 *   SIME_LLM_STUB=1 时进入离线演示模式（确定性摘要，不依赖任何端点，标记 stub:true）。
 */
const SYSTEM_PROMPT = `你是 SIME 智慧集成管理平台的运维助手。用简洁中文回答运维与安全相关问题。
你可以调用工具查询平台实时数据（告警/遥测/设备/剧本/数据湖）。回答要给出具体数字与建议的下一步动作。`;

const TOOLS = [
  { type: 'function', function: { name: 'get_platform_health', description: '查询平台健康状态与资产统计', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_alerts', description: '查询最近告警（可按级别过滤）', parameters: { type: 'object', properties: { severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] }, limit: { type: 'number' } } } } },
  { type: 'function', function: { name: 'get_telemetry_latest', description: '查询设备遥测最新值', parameters: { type: 'object', properties: { assetId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_telemetry_series', description: '查询某测点历史曲线', parameters: { type: 'object', properties: { assetId: { type: 'string' }, point: { type: 'string' }, limit: { type: 'number' } }, required: ['assetId', 'point'] } } },
  { type: 'function', function: { name: 'get_devices', description: '查询已接入设备清单', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'lake_query', description: '数据湖只读分析 SQL（视图 telemetry/alerts，最多 200 行）', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } } },
  { type: 'function', function: { name: 'get_playbooks', description: '查询 SOAR 剧本清单与执行次数', parameters: { type: 'object', properties: {} } } },
];

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');

  constructor(
    private readonly pg: PgProfileService,
    private readonly registry: AssetRegistryService,
    private readonly engine: RuleEngineService,
    private readonly tel: TelemetryService,
    private readonly lake: LakeService,
    private readonly playbook: PlaybookService,
    private readonly ws: WsService,
  ) {}

  stubEnabled(): boolean {
    return process.env.SIME_LLM_STUB === '1' || !process.env.SIME_LLM_BASEURL;
  }

  /** 工具执行器：LLM 的"手"，全部直连平台内部服务。 */
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const db = this.pg.database;
    switch (name) {
      case 'get_platform_health':
        return {
          assets: this.registry.counts(),
          pg: this.pg.enabled ? 'active' : 'memory',
          workers: WORKERS(),
          lake: this.lake.status(),
          wsClients: this.ws.clientCount(),
        };
      case 'get_alerts': {
        if (db) {
          const limit = Math.min(Number(args.limit ?? 10), 50);
          const q = db.selectFrom('alerts').select(['id', 'rule_id', 'ts', 'severity', 'domain', 'state', 'summary']);
          const filtered = args.severity ? q.where('severity', '=', String(args.severity)) : q;
          const rows = await filtered.orderBy('ts', 'desc').limit(limit).execute();
          return rows.map((r) => ({ id: r.id, rule: r.rule_id, severity: r.severity, state: r.state, ts: new Date(r.ts).toISOString(), summary: r.summary }));
        }
        return this.engine.engine.alerts.slice(-10).map((a) => ({ rule: a.ruleId, severity: a.severity, ts: a.ts, summary: a.summary }));
      }
      case 'get_telemetry_latest': {
        const all = await this.tel.latest();
        return args.assetId ? all.filter((x) => x.assetId === args.assetId) : all.slice(0, 30);
      }
      case 'get_telemetry_series':
        return this.tel.series(String(args.assetId), String(args.point), Math.min(Number(args.limit ?? 60), 240));
      case 'get_devices':
        return this.tel.devices();
      case 'lake_query':
        return this.lake.query(String(args.sql));
      case 'get_playbooks':
        return this.playbook.list();
      default:
        throw new Error(`未知工具 ${name}`);
    }
  }

  /** 离线演示模式：确定性摘要（真实数据，无 LLM 参与）。 */
  async stubAnswer(message: string): Promise<string> {
    const counts = this.registry.counts();
    const alerts = await this.executeTool('get_alerts', { limit: 5 });
    const lines: string[] = [];
    lines.push(`【离线演示模式】当前平台：规则 ${counts.rules} 条 · 适配器 ${counts.adapters} 个 · 剧本 ${this.playbook.list().length} 个`);
    const alertsCount = (alerts as unknown[]).length;
    lines.push(`最近告警 ${alertsCount} 条（累计见 /health）：`);
    for (const a of alerts as { severity: string; rule: string; summary: string }[]) {
      lines.push(`  · [${a.severity}] ${a.rule} — ${a.summary?.slice(0, 60) ?? ''}`);
    }
    if (/设备|遥测|测点/.test(message)) {
      const dev = await this.executeTool('get_devices', {});
      lines.push(`已接入设备 ${(dev as unknown[]).length} 台（组态总览可看实时值）。`);
    }
    if (/剧本|soar/i.test(message)) {
      lines.push('SOAR 剧本见「处置闭环」视图，高危告警自动触发封禁/隔离动作。');
    }
    lines.push('提示：配置 SIME_LLM_BASEURL 后可接入真实大模型获得自然语言研判。');
    return lines.join('\n');
  }

  /** OpenAI 兼容 chat completions + 工具循环（最多 4 轮）。 */
  async chat(message: string, history: ChatTurn[]): Promise<{ answer: string; toolCalls: string[]; stub: boolean }> {
    if (this.stubEnabled()) {
      return { answer: await this.stubAnswer(message), toolCalls: [], stub: true };
    }
    const base = process.env.SIME_LLM_BASEURL!.replace(/\/$/, '');
    const model = process.env.SIME_LLM_MODEL ?? 'qwen2.5:7b';
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];
    const toolCalls: string[] = [];
    for (let round = 0; round < 4; round++) {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SIME_LLM_APIKEY ?? 'none'}`,
        },
        body: JSON.stringify({ model, messages, tools: TOOLS }),
      });
      if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { choices: { message: any }[] };
      const msg = j.choices[0]!.message;
      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const tc of msg.tool_calls) {
          const fn = tc.function.name as string;
          let result: unknown;
          try {
            result = await this.executeTool(fn, tc.function.arguments ? JSON.parse(tc.function.arguments) : {});
          } catch (e) {
            result = { error: e instanceof Error ? e.message : String(e) };
          }
          toolCalls.push(fn);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
        }
        continue;
      }
      return { answer: String(msg.content ?? ''), toolCalls, stub: false };
    }
    return { answer: '（达到工具调用轮次上限）', toolCalls, stub: false };
  }
}

function WORKERS(): number {
  return Number(process.env.SIME_WORKERS ?? 1);
}
