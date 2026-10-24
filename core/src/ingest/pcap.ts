/**
 * pcap / pcapng 解析（纯 JS，无外部依赖）。
 *
 * 现场给的最多的不是 JSONL，是一个 pcap。此前导入层把 pcap 当二进制直接拒掉，
 * "流量包导入"就只剩"自己拼 JSONL"这一种用法。这里补上真正的入口：
 *
 *   字节流 → 链路层/网络层/传输层解码 → 按五元组聚合成 flow → ECS 事件 → 同一摄入管道
 *
 * 三条设计取舍：
 *  1. **流式**：按 chunk 喂入、按记录消费，内存只与"未消费的残余 + 流表"有关，
 *     与文件大小无关（几百 MB 的包也不炸进程）。
 *  2. **默认按流聚合**：一个 pcap 动辄十万包，逐包入库既淹没有用信号又把
 *     events 表打爆。流聚合（packets/bytes/first/last）才是"流量"该有的粒度；
 *     需要逐包时用 mode=packet。
 *  3. **解析不了就计数，不抛异常**：链路层不支持、IP 分片、截断包各自计数，
 *     一个包里出现新协议不该让整次导入失败。
 */

export type PcapFormat = 'pcap' | 'pcapng';
export type Transport = 'tcp' | 'udp' | 'icmp' | 'icmpv6' | 'other';

/** 只认这几种链路层：以太网、原始 IP、Linux  cooked(SLL/SLL2)、NULL/loopback */
const LT_ETHERNET = 1;
const LT_RAW = 101;
const LT_NULL = 0;
const LT_LOOP = 108;
const LT_SLL = 113;
const LT_SLL2 = 276;

const ETH_VLAN = new Set([0x8100, 0x88a8, 0x9100, 0x9200]);

/** OT 协议端口：命中即把该事件判到 ot 域（检索分区用，不参与规则判定） */
const OT_PORTS = new Set<number>([
  102, // S7
  502, // Modbus
  789, 4840, // OPC UA
  1911, 4911, // Niagara Fox
  1962, // PCWorx
  2000, 20000, // DNP3 / Cisco SCCP 常见
  2404, // IEC 60870-5-104
  2455, // CODESYS
  4840,
  5006, 5007, 5008,
  9600, // OMRON FINS
  18245, 18246, // GE SRTP
  44818, 2222, // EtherNet/IP
  47808, // BACnet
]);

export interface PcapStats {
  format: PcapFormat;
  /** 文件里的链路层类型（多接口 pcapng 可能有多种） */
  linkTypes: number[];
  packets: number;
  /** 成功解出网络层/传输层信息的包 */
  parsed: number;
  /** IP 非首片分片（没有 L4 头，只能计数） */
  fragments: number;
  /** caplen < origlen：抓包时被 snaplen 截断 */
  truncated: number;
  /** 链路层不支持（如 802.11 未解密） */
  unsupportedLink: number;
  bytes: number;
  flows: number;
  /** 流表满后丢弃的新流（老流继续累加） */
  overflowFlows: number;
  firstMs: number | null;
  lastMs: number | null;
  pcapng: boolean;
}

export interface PcapFlow {
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  proto: Transport;
  packets: number;
  bytes: number;
  firstMs: number;
  lastMs: number;
}

export interface PcapOptions {
  /** flow（默认，按五元组聚合）| packet（逐包一条事件，受 maxEvents 约束） */
  mode?: 'flow' | 'packet';
  /** 流表上限，默认 200k；超出的新流只计数不建表 */
  maxFlows?: number;
  /** packet 模式下的产出上限，默认 20000 */
  maxPackets?: number;
  /** 文件名，写进事件的 sime.pcap.file 便于取证回溯 */
  file?: string;
}

function readU16(b: Buffer, o: number, be: boolean): number {
  return be ? b.readUInt16BE(o) : b.readUInt16LE(o);
}
function readU32(b: Buffer, o: number, be: boolean): number {
  return be ? b.readUInt32BE(o) : b.readUInt32LE(o);
}
function ipv4(b: Buffer, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}
function ipv6(b: Buffer, o: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(o + i).toString(16));
  // 压掉最长一段连续 0（RFC 5952 的简写，纯展示用）
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (parts[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && parts[j] === '0') j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return parts.join(':');
  return `${parts.slice(0, best).join(':')}::${parts.slice(best + bestLen).join(':')}`;
}

/** 魔数判定：只看前 4 字节，不读整文件 */
export function detectPcap(head: Buffer): { format: PcapFormat; be: boolean; nano: boolean } | null {
  if (head.length < 4) return null;
  const [a, b, c, d] = [head[0]!, head[1]!, head[2]!, head[3]!];
  if (a === 0x0a && b === 0x0d && c === 0x0d && d === 0x0a) return { format: 'pcapng', be: false, nano: false };
  if (a === 0xd4 && b === 0xc3 && c === 0xb2 && d === 0xa1) return { format: 'pcap', be: false, nano: false };
  if (a === 0xa1 && b === 0xb2 && c === 0xc3 && d === 0xd4) return { format: 'pcap', be: true, nano: false };
  if (a === 0x4d && b === 0x3c && c === 0xb2 && d === 0xa1) return { format: 'pcap', be: false, nano: true };
  if (a === 0xa1 && b === 0xb2 && c === 0x3c && d === 0x4d) return { format: 'pcap', be: true, nano: true };
  return null;
}

interface Decoded {
  tsMs: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  proto: Transport;
  bytes: number;
}

export class PcapParser {
  private readonly mode: 'flow' | 'packet';
  private readonly maxFlows: number;
  private readonly maxPackets: number;
  private readonly file: string;

  private pending: Buffer = Buffer.alloc(0);
  private head: { format: PcapFormat; be: boolean; nano: boolean } | null = null;

  /** pcap：全局头只解析一次 */
  private globalOk = false;
  private linkType = LT_ETHERNET;
  private nano = false;

  /** pcapng：每个接口的链路层与时间精度 */
  private ifaces: { linkType: number; tsResol: number }[] = [];
  private ngBe = false;
  private sectionSeen = false;

  private readonly flowMap = new Map<string, PcapFlow>();
  private readonly packetEvents: Decoded[] = [];

  readonly stats: PcapStats = {
    format: 'pcap',
    linkTypes: [],
    packets: 0,
    parsed: 0,
    fragments: 0,
    truncated: 0,
    unsupportedLink: 0,
    bytes: 0,
    flows: 0,
    overflowFlows: 0,
    firstMs: null,
    lastMs: null,
    pcapng: false,
  };

  constructor(opts: PcapOptions = {}) {
    this.mode = opts.mode === 'packet' ? 'packet' : 'flow';
    this.maxFlows = Math.max(Math.trunc(opts.maxFlows ?? 200_000), 1);
    this.maxPackets = Math.max(Math.trunc(opts.maxPackets ?? 20_000), 1);
    this.file = opts.file ?? '';
  }

  /** 喂一个 chunk；内部按记录消费，残余留到下次 */
  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.consume(false);
  }

  end(): void {
    this.consume(true);
  }

  private consume(final: boolean): void {
    let off = 0;
    for (;;) {
      if (!this.head) {
        if (this.pending.length - off < 4) break;
        const d = detectPcap(this.pending.subarray(off, off + 4));
        if (!d) throw new Error('不是 pcap / pcapng 文件（魔数不匹配）');
        this.head = d;
        this.stats.format = d.format;
        this.stats.pcapng = d.format === 'pcapng';
        if (d.format === 'pcap') { this.nano = d.nano; } else { this.ngBe = false; }
      }
      const used = this.head.format === 'pcap' ? this.consumePcap(off, final) : this.consumeNg(off, final);
      if (used === 0) break;
      off += used;
    }
    if (off > 0) this.pending = this.pending.subarray(off);
    // 收尾：残余不足以构成一条记录时到此为止（截断文件不报错，计数即可）
    if (final && this.pending.length && this.pending.length < 16) this.pending = Buffer.alloc(0);
  }

  /** 返回消费掉的字节数；0 表示数据不够，等下一个 chunk */
  private consumePcap(off: number, final: boolean): number {
    const b = this.pending;
    if (!this.globalOk) {
      if (b.length - off < 24) return 0;
      const be = this.head!.be;
      this.linkType = readU32(b, off + 20, be);
      this.stats.linkTypes = [...new Set([...this.stats.linkTypes, this.linkType])];
      this.globalOk = true;
      return 24;
    }
    if (b.length - off < 16) return 0;
    const be = this.head!.be;
    const sec = readU32(b, off, be);
    const frac = readU32(b, off + 4, be);
    const incl = readU32(b, off + 8, be);
    const orig = readU32(b, off + 12, be);
    if (incl > 0x7fffffff) return b.length - off; // 脏数据，别在坏记录上无限等
    if (b.length - off - 16 < incl) return 0;
    const tsMs = sec * 1000 + (this.nano ? frac / 1e6 : frac / 1e3);
    this.account(tsMs, orig, incl);
    this.decodePacket(b.subarray(off + 16, off + 16 + incl), this.linkType, tsMs, orig, incl);
    return 16 + incl;
  }

  private consumeNg(off: number, _final: boolean): number {
    const b = this.pending;
    if (b.length - off < 12) return 0;
    // SHB 的 type 与字节序无关，先用 0x0A0D0D0A 判定
    const typeBE = b.readUInt32BE(off);
    if (typeBE === 0x0a0d0d0a) {
      // 读 byte-order magic（body 前 4 字节）判本节字节序
      if (b.length - off < 28) return 0;
      const bomBE = b.readUInt32BE(off + 8);
      this.ngBe = bomBE === 0x1a2b3c4d;
      const total = this.ngBe ? b.readUInt32BE(off + 4) : b.readUInt32LE(off + 4);
      if (total < 28 || total > 1 << 24) return b.length - off;
      if (b.length - off < total) return 0;
      this.ifaces = [];
      this.sectionSeen = true;
      return total;
    }
    const be = this.ngBe;
    const type = readU32(b, off, be);
    const total = readU32(b, off + 4, be);
    if (total < 12 || total > 1 << 24) return b.length - off; // 坏块：跳掉剩余，避免死循环
    if (b.length - off < total) return 0;
    const body = b.subarray(off + 8, off + total - 4);
    if (!this.sectionSeen) return total; // 没见到 SHB 的块（异常文件）

    if (type === 1 && body.length >= 8) {
      // IDB
      let tsResol = 6; // 默认微秒
      let p = 8;
      while (p + 4 <= body.length) {
        const code = readU16(body, p, be);
        const len = readU16(body, p + 2, be);
        if (code === 0) break;
        if (code === 9 && len >= 1) {
          const v = body[p + 4]!;
          tsResol = v & 0x80 ? -(v & 0x7f) : v;
        }
        p += 4 + len + ((4 - (len % 4)) % 4);
      }
      this.ifaces.push({ linkType: readU16(body, 0, be), tsResol });
      this.stats.linkTypes = [...new Set([...this.stats.linkTypes, readU16(body, 0, be)])];
    } else if (type === 6 && body.length >= 20) {
      // EPB
      const ifId = readU32(body, 0, be);
      const tsHigh = readU32(body, 4, be);
      const tsLow = readU32(body, 8, be);
      const capLen = readU32(body, 12, be);
      const origLen = readU32(body, 16, be);
      const iface = this.ifaces[ifId] ?? { linkType: LT_ETHERNET, tsResol: 6 };
      const denom = iface.tsResol >= 0 ? 10 ** iface.tsResol : 2 ** -iface.tsResol;
      const tsMs = (tsHigh * 0x100000000 + tsLow) / denom * 1000;
      const data = body.subarray(20, 20 + Math.min(capLen, body.length - 20));
      this.account(tsMs, origLen, data.length);
      this.decodePacket(data, iface.linkType, tsMs, origLen, data.length);
    } else if (type === 3 && body.length >= 4) {
      // SPB（老式简化块，无时间戳，用上一包时间或当前时间）
      const origLen = readU32(body, 0, be);
      const iface = this.ifaces[0] ?? { linkType: LT_ETHERNET, tsResol: 6 };
      const data = body.subarray(4, Math.min(body.length, 4 + origLen));
      const tsMs = this.stats.lastMs ?? Date.now();
      this.account(tsMs, origLen, data.length);
      this.decodePacket(data, iface.linkType, tsMs, origLen, data.length);
    }
    return total;
  }

  private account(tsMs: number, orig: number, incl: number): void {
    this.stats.packets++;
    this.stats.bytes += orig;
    if (orig > incl) this.stats.truncated++;
    if (this.stats.firstMs === null || tsMs < this.stats.firstMs) this.stats.firstMs = tsMs;
    if (this.stats.lastMs === null || tsMs > this.stats.lastMs) this.stats.lastMs = tsMs;
  }

  private decodePacket(data: Buffer, linkType: number, tsMs: number, orig: number, incl: number): void {
    const net = this.linkToNet(data, linkType);
    if (!net) { this.stats.unsupportedLink++; return; }
    const dec = this.netToFlow(net.buf, net.etherType, tsMs, orig);
    if (!dec) return;
    this.stats.parsed++;
    if (this.mode === 'packet') {
      if (this.packetEvents.length < this.maxPackets) this.packetEvents.push(dec);
      return;
    }
    const key = `${dec.proto}|${dec.srcIp}:${dec.srcPort}|${dec.dstIp}:${dec.dstPort}`;
    const hit = this.flowMap.get(key);
    if (!hit) {
      if (this.flowMap.size >= this.maxFlows) { this.stats.overflowFlows++; return; }
      this.flowMap.set(key, {
        srcIp: dec.srcIp, srcPort: dec.srcPort, dstIp: dec.dstIp, dstPort: dec.dstPort,
        proto: dec.proto, packets: 1, bytes: orig, firstMs: tsMs, lastMs: tsMs,
      });
      this.stats.flows = this.flowMap.size;
      return;
    }
    hit.packets++;
    hit.bytes += orig;
    if (tsMs < hit.firstMs) hit.firstMs = tsMs;
    if (tsMs > hit.lastMs) hit.lastMs = tsMs;
  }

  /** 链路层 → (网络层起始, ethertype) */
  private linkToNet(data: Buffer, linkType: number): { buf: Buffer; etherType: number } | null {
    if (linkType === LT_ETHERNET) {
      if (data.length < 14) return null;
      let off = 12;
      let type = data.readUInt16BE(off);
      off += 2;
      let guard = 0;
      while (ETH_VLAN.has(type) && guard++ < 4) {
        if (data.length < off + 4) return null;
        type = data.readUInt16BE(off + 2);
        off += 4;
      }
      return { buf: data.subarray(off), etherType: type };
    }
    if (linkType === LT_RAW) {
      if (!data.length) return null;
      const v = data[0]! >> 4;
      return { buf: data, etherType: v === 4 ? 0x0800 : v === 6 ? 0x86dd : 0 };
    }
    if (linkType === LT_SLL) {
      if (data.length < 16) return null;
      return { buf: data.subarray(16), etherType: data.readUInt16BE(14) };
    }
    if (linkType === LT_SLL2) {
      if (data.length < 20) return null;
      return { buf: data.subarray(20), etherType: data.readUInt16BE(0) };
    }
    if (linkType === LT_NULL || linkType === LT_LOOP) {
      if (data.length < 4) return null;
      const fam = linkType === LT_NULL ? data.readUInt32LE(0) : data.readUInt32BE(0);
      return { buf: data.subarray(4), etherType: fam === 2 ? 0x0800 : fam === 10 || fam === 24 || fam === 28 ? 0x86dd : 0 };
    }
    return null;
  }

  private netToFlow(buf: Buffer, etherType: number, tsMs: number, bytes: number): Decoded | null {
    if (etherType === 0x0800) return this.ipv4(buf, tsMs, bytes);
    if (etherType === 0x86dd) return this.ipv6(buf, tsMs, bytes);
    return null;
  }

  private ipv4(b: Buffer, tsMs: number, bytes: number): Decoded | null {
    if (b.length < 20 || (b[0]! >> 4) !== 4) return null;
    const ihl = (b[0]! & 0x0f) * 4;
    if (ihl < 20 || b.length < ihl) return null;
    const totalLen = b.readUInt16BE(2);
    const proto = b[9]!;
    const fragWord = b.readUInt16BE(6);
    const fragOffset = (fragWord & 0x1fff) * 8;
    const src = ipv4(b, 12);
    const dst = ipv4(b, 16);
    const l4 = b.subarray(ihl);
    if (fragOffset > 0) { this.stats.fragments++; return null; }
    const t = this.transport(proto, l4, src, dst, tsMs, bytes, totalLen);
    return t;
  }

  private ipv6(b: Buffer, tsMs: number, bytes: number): Decoded | null {
    if (b.length < 40 || (b[0]! >> 4) !== 6) return null;
    let next = b[6]!;
    const src = ipv6(b, 8);
    const dst = ipv6(b, 24);
    let off = 40;
    const payloadLen = b.readUInt16BE(4);
    let guard = 0;
    while (guard++ < 8) {
      if (next === 0 || next === 43 || next === 60) {
        if (b.length < off + 2) return null;
        next = b[off]!;
        off += (b[off + 1]! + 1) * 8;
        continue;
      }
      if (next === 44) {
        if (b.length < off + 8) return null;
        const fragWord = b.readUInt16BE(off + 2);
        if ((fragWord & 0xfff8) !== 0) { this.stats.fragments++; return null; }
        next = b[off]!;
        off += 8;
        continue;
      }
      if (next === 51) {
        if (b.length < off + 2) return null;
        next = b[off]!;
        off += (b[off + 1]! + 2) * 4;
        continue;
      }
      break;
    }
    if (b.length < off) return null;
    return this.transport(next, b.subarray(off), src, dst, tsMs, bytes, payloadLen);
  }

  private transport(proto: number, l4: Buffer, src: string, dst: string, tsMs: number, bytes: number, _len: number): Decoded | null {
    if (proto === 6) {
      if (l4.length < 4) return null;
      return { tsMs, srcIp: src, srcPort: l4.readUInt16BE(0), dstIp: dst, dstPort: l4.readUInt16BE(2), proto: 'tcp', bytes };
    }
    if (proto === 17) {
      if (l4.length < 4) return null;
      return { tsMs, srcIp: src, srcPort: l4.readUInt16BE(0), dstIp: dst, dstPort: l4.readUInt16BE(2), proto: 'udp', bytes };
    }
    if (proto === 1) return { tsMs, srcIp: src, srcPort: 0, dstIp: dst, dstPort: 0, proto: 'icmp', bytes };
    if (proto === 58) return { tsMs, srcIp: src, srcPort: 0, dstIp: dst, dstPort: 0, proto: 'icmpv6', bytes };
    if (proto === 47) return { tsMs, srcIp: src, srcPort: 0, dstIp: dst, dstPort: 0, proto: 'other', bytes };
    return { tsMs, srcIp: src, srcPort: 0, dstIp: dst, dstPort: 0, proto: 'other', bytes };
  }

  /** 产出 ECS 事件（flow 模式按流，packet 模式按包） */
  events(): Record<string, unknown>[] {
    if (this.mode === 'packet') {
      return this.packetEvents.map((d) => this.toEcs(d, 1, d.bytes, d.tsMs, d.tsMs, 'packet'));
    }
    const out: Record<string, unknown>[] = [];
    for (const f of this.flowMap.values()) {
      out.push(this.toEcs(f, f.packets, f.bytes, f.firstMs, f.lastMs, 'flow'));
    }
    out.sort((a, b) => Date.parse(String(a['@timestamp'])) - Date.parse(String(b['@timestamp'])));
    return out;
  }

  private toEcs(
    d: { srcIp: string; srcPort: number; dstIp: string; dstPort: number; proto: Transport },
    packets: number,
    bytes: number,
    firstMs: number,
    lastMs: number,
    kind: 'flow' | 'packet',
  ): Record<string, unknown> {
    const ot = isOtPair(d.srcPort, d.dstPort) || isOtPair(d.dstPort, d.srcPort);
    const durationNs = Math.max(0, Math.round((lastMs - firstMs) * 1e6));
    const eps = [`${d.srcIp}:${d.srcPort}`, `${d.dstIp}:${d.dstPort}`];
    const ev: Record<string, unknown> = {
      '@timestamp': new Date(firstMs).toISOString(),
      event: {
        category: 'network',
        action: kind === 'flow' ? 'flow_end' : 'packet',
        kind: 'event',
        start: new Date(firstMs).toISOString(),
        end: new Date(lastMs).toISOString(),
        duration: durationNs,
      },
      network: {
        transport: d.proto === 'icmpv6' ? 'icmp' : d.proto,
        bytes,
        packets,
        protocol: d.proto,
      },
      source: { ip: d.srcIp, port: d.srcPort },
      destination: { ip: d.dstIp, port: d.dstPort },
      message: `${d.proto.toUpperCase()} ${eps[0]} → ${eps[1]} · ${packets} 包 / ${formatBytes(bytes)}`,
      sime: {
        ...(ot ? { domain: 'ot' } : {}),
        pcap: { file: this.file, mode: kind, format: this.stats.format },
      },
      tags: ['pcap', `network-${d.proto}`],
    };
    return ev;
  }
}

function isOtPair(a: number, _b: number): boolean {
  return OT_PORTS.has(a);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 便捷入口：一次性解析整个 buffer（测试与小文件用） */
export function parsePcapBuffer(buf: Buffer, opts: PcapOptions = {}): { events: Record<string, unknown>[]; stats: PcapStats } {
  const p = new PcapParser(opts);
  p.push(buf);
  p.end();
  return { events: p.events(), stats: p.stats };
}
