/**
 * 事件归一化（ECS 基线 → events 表行）。
 *
 * 三条设计约束：
 *  1. **单一入口**：MQTT / HTTP 单条 / 文件导入 / 内置回放四条路径都先过这里，
 *     保证同一份日志无论从哪个口进来，落库结构与喂给规则引擎的结构完全一致。
 *  2. **不信任输入**：category/domain 一律收敛到白名单值，避免 events 表的
 *     check 约束在批量插入时整体失败（一行脏数据不该毁掉一批）。
 *  3. **保留原文**：payload 存完整原始事件，SIME QL 的 `payload->...` 与后续
 *     重新解析、取证追溯都依赖它，不能只留投影后的字段。
 */
import { getPath } from '../rule-engine/condition-evaluator';

export type SimeDomain = 'it' | 'ot' | 'merged';

export const SIME_DOMAINS: readonly SimeDomain[] = ['it', 'ot', 'merged'];

/** 落库行（列名对齐 storage/pg/init/01-schema.sql 的 events 表） */
export interface StoredEvent {
  ts: Date;
  domain: SimeDomain;
  category: string;
  name: string | null;
  source: string | null;
  src: Record<string, unknown> | null;
  dst: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  threat_id: string | null;
}

export interface NormalizeOptions {
  /** 采集通道标识（适配器 id / mqtt / import / replay），写入 events.source */
  source?: string;
  /** 强制域，覆盖事件自带与推断结果 */
  domain?: SimeDomain;
  /** 事件缺时间戳时的兜底（毫秒）；缺省取当前时间 */
  fallbackTs?: number;
}

export class EventFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventFormatError';
  }
}

const MAX_FUTURE_MS = 365 * 24 * 3600 * 1000;
const FIELD_CAP = 128;

/** OT 侧类别特征：命中即判 ot，否则 it（domain 只影响检索分区，不参与规则判定） */
const OT_CATEGORY = /^(ics|ot|scada|plc|modbus|opc|s7|iec|dnp3|profinet|bacnet|telemetry|process)/i;

export function inferDomain(category: string): SimeDomain {
  return OT_CATEGORY.test(category) ? 'ot' : 'it';
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** 数组取首个非空元素（ECS 允许 category 是数组，如 ["authentication","start"]） */
function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = asString(x);
      if (s) return s;
    }
    return undefined;
  }
  return asString(v);
}

function cap(s: string | undefined, n = FIELD_CAP): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 时间解析：数字（秒/毫秒自动判别）、数字字符串、ISO 字符串都收。
 * 解析不出来交给调用方兜底，不在这里静默取当前时间——批量导入时那会把
 * 整批历史数据的时间抹平，属于必须显式报告的坏数据。
 */
export function parseTs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) return parseTs(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  // 只给了裸 IP 字符串时补成 {ip}，让 src.ip 投影仍然可用
  if (typeof v === 'string' && v.trim()) return { ip: v.trim() };
  return null;
}

/**
 * ECS 标准端点（source/destination/client/server）的收口：
 * 对象直接收；字符串只有 IP / host:port 形状才算端点——否则会把
 * "source: firewall-a" 这类通道名误兜底成 {ip: 'firewall-a'}。
 */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
function endpointOf(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return asObject(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (IPV4.test(s)) return { ip: s };
    if (s && /[:.]/.test(s) && /\d/.test(s) && !/\s/.test(s)) return { ip: s };
  }
  return null;
}

const TS_PATHS = ['@timestamp', 'ts', 'timestamp', 'event.created', 'event.start', 'event.end', 'time'];

/** 适配器映射产出的是打平的点号键（`event.category`），规则引擎只认嵌套路径，这里展开。 */
export function expandDotted(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (v === undefined) continue;
    if (!k.includes('.') || k.startsWith('@')) {
      out[k] = v;
      continue;
    }
    const parts = k.split('.').filter(Boolean);
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      const next = cur[p];
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        cur = next as Record<string, unknown>;
      } else {
        const fresh: Record<string, unknown> = {};
        cur[p] = fresh;
        cur = fresh;
      }
    }
    cur[parts[parts.length - 1]!] = v;
  }
  return out;
}

/**
 * 归一化单条事件。任何无法挽回的问题都抛 EventFormatError（消息即给用户看的原因），
 * 批量导入据此逐行统计失败行号，不会因为一行坏数据中断整批。
 */
export function normalizeEvent(raw: unknown, opts: NormalizeOptions = {}): StoredEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EventFormatError('事件必须是 JSON 对象');
  }
  const ev = raw as Record<string, unknown>;

  // 时间：先取标准位置，再退回任意候选路径
  let tsMs: number | undefined;
  for (const p of TS_PATHS) {
    tsMs = parseTs(getPath(ev, p));
    if (tsMs !== undefined) break;
  }
  if (tsMs === undefined) tsMs = opts.fallbackTs ?? Date.now();
  if (!Number.isFinite(tsMs) || tsMs < 0) throw new EventFormatError('时间戳无法解析');
  if (tsMs > Date.now() + MAX_FUTURE_MS) {
    throw new EventFormatError(`时间戳超出合理范围: ${new Date(tsMs).toISOString()}`);
  }

  const evObj = ev['event'];
  const evRec = evObj && typeof evObj === 'object' && !Array.isArray(evObj) ? (evObj as Record<string, unknown>) : undefined;

  const category =
    cap(
      firstString(evRec?.['category']) ??
        firstString(ev['category']) ??
        firstString(ev['event_type']) ??
        firstString(typeof evObj === 'string' ? evObj : undefined),
    ) ?? 'unknown';

  // 域：显式强制 > 事件自带（坑：sime.domain / sime: {domain}）> 按类别推断；
  // 非法值一律回落推断结果，避免撞 events.domain 的 check 约束把整批插入打挂
  const declared = firstString(opts.domain) ?? firstString(getPath(ev, 'sime.domain')) ?? firstString(ev['domain']);
  const domain: SimeDomain =
    declared && (SIME_DOMAINS as readonly string[]).includes(declared)
      ? (declared as SimeDomain)
      : inferDomain(category);

  const name =
    cap(
      firstString(evRec?.['name']) ??
        firstString(evRec?.['action']) ??
        firstString(ev['name']) ??
        firstString(ev['action']),
    ) ?? null;

  const threatId =
    cap(
      firstString(getPath(ev, 'sime.threat_id')) ??
        firstString(getPath(ev, 'threat.indicator.id')) ??
        firstString(getPath(ev, 'threat.id')) ??
        firstString(ev['threat_id']),
    ) ?? null;

  // 五元组：内部简写 src/dst 优先，其次 ECS 标准端点 source/destination（client/server 同理）。
  // 真实流量包几乎都是 ECS 键——缺这一步，导入事件的 src/dst 全为 null，
  // 检索的 q IP 过滤与 UI 的源/目的列随之失效（现网浏览器导入实测踩到）。
  const src = asObject(ev['src']) ?? endpointOf(ev['source']) ?? asObject(ev['client']);
  const dst = asObject(ev['dst']) ?? endpointOf(ev['destination']) ?? asObject(ev['server']);
  // source 的双重语义：ECS 里它是网络端点对象；只有字符串形式的 source 才是采集通道名。
  // 纯数字/点号/冒号形状的字符串（IP / host:port）不当作通道名，避免污染 events.source 列。
  const rawSource = firstString(ev['source']);
  const channel = rawSource && !/^[\d.:/]+$/.test(rawSource) ? rawSource : undefined;

  return {
    ts: new Date(tsMs),
    domain,
    category,
    name,
    source: cap(opts.source ?? channel),
    src,
    dst,
    payload: ev,
    threat_id: threatId,
  };
}

/** 归一化 + 失败时返回原因（批量路径用，避免到处 try/catch） */
export function tryNormalize(
  raw: unknown,
  opts: NormalizeOptions = {},
): { ok: true; event: StoredEvent } | { ok: false; reason: string } {
  try {
    return { ok: true, event: normalizeEvent(raw, opts) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
