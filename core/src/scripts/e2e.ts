/**
 * SIME 端到端回归套件（E2E）：
 * 对运行中的平台逐项验证全部已上线能力，任一失败退出码 1。
 * 用法：node dist/scripts/e2e.js [--base http://127.0.0.1:3000] [--user admin] [--pass ...]
 * 环境变量：E2E_BASE / E2E_USER / E2E_PASS
 */
import WebSocket from 'ws';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return (i > 0 ? process.argv[i + 1] : null) ?? process.env.E2E_BASE ?? 'http://127.0.0.1:3000';
})();
const USER = (() => {
  const i = process.argv.indexOf('--user');
  return (i > 0 ? process.argv[i + 1] : null) ?? process.env.E2E_USER ?? 'admin';
})();
const PASS = (() => {
  const i = process.argv.indexOf('--pass');
  return (i > 0 ? process.argv[i + 1] : null) ?? process.env.E2E_PASS ?? 'sime123456';
})();

let token = '';
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function jget(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try {
    json = await r.json();
  } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

async function jpost(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

/** 取原始字节（.text() 会吞掉 BOM，验 BOM 必须看字节） */
async function rawBuf(
  path: string,
  init?: { method?: string; body?: string; contentType?: string },
): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const r = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    ...(init?.body === undefined ? {} : { body: init.body }),
  });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers };
}

/** 取原始响应（导出是文件流，不能按 JSON 解） */
async function raw(
  path: string,
  init?: { method?: string; body?: string; contentType?: string },
): Promise<{ status: number; text: string; headers: Headers }> {
  const r = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    ...(init?.body === undefined ? {} : { body: init.body }),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

async function main(): Promise<void> {
  console.log(`E2E 目标: ${BASE}\n`);

  /* 1. 认证 */
  console.log('[1] 认证与访问控制');
  const bad = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'wrong-password' }),
  });
  check('错误密码被拒绝(401)', bad.status === 401);
  const login = await jpost('/api/v1/auth/login', { username: USER, password: PASS });
  check('正确凭据登录', login.status >= 200 && login.status < 300 && !!login.json?.token, `user=${login.json?.user ?? '-'}`);
  token = login.json?.token ?? '';
  if (!token) {
    // 后续每一项都依赖 token，继续跑只会刷一屏 401 和 TypeError，掩盖真正的原因
    console.error(
      `\n登录失败，提前终止。请检查 SIME_ADMIN_USER / SIME_ADMIN_PASSWORD（注意：compose 未定义该变量时会注入空串，` +
        `旧版本 \`?? 默认值\` 拦不住空串，会导致谁都登不进来）。当前尝试的用户名: ${USER}`,
    );
    process.exit(1);
  }
  const noAuth = await fetch(`${BASE}/api/v1/rules`);
  check('无 token 访问被拒(401)', noAuth.status === 401);
  const health = await jget('/api/v1/health');
  check('health 豁免且正常', health.status === 200 && health.json?.status === 'ok', `存储=${health.json?.pgProfile}`);
  const withAuth = await jget('/api/v1/rules');
  check('带 token 访问放行', withAuth.status === 200);

  /* 2. 资产库 */
  console.log('[2] 规则 / 适配器 / 物模型 / 剧本');
  const rules = await jget('/api/v1/rules');
  check('规则库规模 ≥ 45', (rules.json?.length ?? 0) >= 45, `实际 ${rules.json?.length ?? 0}`);
  check('规则全部挂 ATT&CK 技术', (rules.json ?? []).every((x: any) => (x.techniques ?? []).length > 0));
  const adapters = await jget('/api/v1/adapters');
  check('适配器规模 ≥ 28', (adapters.json?.length ?? 0) >= 28, `实际 ${adapters.json?.length ?? 0}`);
  const models = await jget('/api/v1/thing-models');
  check('物模型模板 ≥ 3', (models.json?.length ?? 0) >= 3);
  const pbs = await jget('/api/v1/playbooks');
  check('SOAR 剧本 = 20', (pbs.json?.playbooks?.length ?? 0) === 20, `实际 ${pbs.json?.playbooks?.length ?? 0}`);

  /* 3. 告警管道 */
  console.log('[3] 告警管道（模拟回放 → 检出 → 闭环）');
  // reset=true 让回放确定：否则同一窗口内的冷却去重会让"刚跑过一次 e2e"的第二轮拿到 0 条告警，
  // 测试就变成了"看距上次跑多久"的运气题
  const sim = await jpost('/api/v1/pipeline/simulate', { reset: true });
  check('模拟回放产出告警 ≥ 4', (sim.json?.newAlerts ?? 0) >= 4, `newAlerts=${sim.json?.newAlerts}`);
  const alerts = await jget('/api/v1/alerts');
  check('告警列表来自 PG', alerts.json?.pgActive === true);
  check('告警累计 ≥ 10', (alerts.json?.stats?.alerts ?? 0) >= 10, `实际 ${alerts.json?.stats?.alerts}`);
  const first = (alerts.json?.items ?? [])[0];
  check('告警含状态字段', !!first && ['open', 'ack', 'resolved'].includes(first.state));
  if (first?.pgId) {
    const ack = await jpost(`/api/v1/alerts/${first.pgId}/ack`);
    check('告警确认(ack)', ack.status >= 200 && ack.status < 300 && ack.json?.state === 'ack');
    const after = await jget('/api/v1/alerts');
    const row = (after.json?.items ?? []).find((x: any) => x.pgId === first.pgId);
    check('状态已落库', row?.state === 'ack');
  }
  const trend = await jget('/api/v1/alerts/trend');
  check('24h 趋势 24 个分桶', (trend.json?.hours?.length ?? 0) === 24);

  /* 4. 遥测与组态 */
  console.log('[4] 遥测与组态');
  const latest = await jget('/api/v1/telemetry/latest');
  check('遥测最新值非空（MQTT 接入）', (latest.json ?? []).length > 0, `${latest.json?.length ?? 0} 点`);
  const pairs = ([...new Set((latest.json ?? []).map((x: any) => `${x.assetId}|${x.point}`))] as string[]).slice(0, 5);
  let best = 0;
  for (const p of pairs) {
    const [a, pt] = p.split('|');
    const series = await jget(`/api/v1/telemetry/series?asset_id=${encodeURIComponent(a!)}&point=${encodeURIComponent(pt!)}&limit=50`);
    best = Math.max(best, series.json?.length ?? 0);
    if (best > 5) break;
  }
  check('遥测曲线有历史数据', best > 5, `最多 ${best} 点`);
  const layout0 = await jget('/api/v1/topology/layout');
  const save = await jpost('/api/v1/topology/layout', layout0.json);
  check('组态布局保存/回读', save.status >= 200 && save.status < 300);
  const layout1 = await jget('/api/v1/topology/layout');
  check('布局持久化一致', JSON.stringify(layout0.json) === JSON.stringify(layout1.json));

  /* 5. 处置闭环 */
  console.log('[5] 处置闭环（工单 / 通知 / 审计）');
  const resp = await jget('/api/v1/responses');
  check('工单已产生', (resp.json?.tickets?.length ?? 0) > 0, `${resp.json?.tickets?.length ?? 0} 张`);
  check('通知已产生', (resp.json?.notifications?.length ?? 0) > 0);
  check('响应审计已产生', (resp.json?.audit?.length ?? 0) > 0);

  /* 6. WebSocket */
  console.log('[6] WebSocket 实时推送');
  const wsOk = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(false); }, 4000);
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.type === 'hello') { clearTimeout(timer); ws.close(); resolve(true); }
      } catch { /* 忽略 */ }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  check('WS 握手 + hello', wsOk);

  /* 7. 数据湖 */
  console.log('[7] 数据湖（DuckDB + Parquet）');
  const status = await jget('/api/v1/lake/status');
  check('湖仓可用', status.json?.available === true);
  const hasParquet = (status.json?.files ?? []).some((f: any) => f.file === 'alerts.parquet');
  if (!hasParquet) {
    const snap = await jpost('/api/v1/lake/snapshot');
    check('湖仓快照生成', snap.status >= 200 && snap.status < 300 && (snap.json?.files?.length ?? 0) >= 2, `${snap.json?.tookMs ?? '-'}ms`);
  } else {
    check('湖仓已有快照', true);
  }
  const q1 = await jpost('/api/v1/lake/query', { sql: 'SELECT severity, count(*) AS c FROM alerts GROUP BY severity ORDER BY c DESC' });
  check('湖仓聚合查询', q1.status >= 200 && q1.status < 300 && (q1.json?.rows?.length ?? 0) >= 1, `${q1.json?.rows?.length ?? 0} 行`);
  const q2 = await jpost('/api/v1/lake/query', { sql: 'DELETE FROM alerts' });
  check('危险 SQL 被拦截(400)', q2.status === 400);

  /* 8. SIME QL 统一查询 */
  console.log('[8] SIME QL 统一查询');
  const cat = await jget('/api/v1/query/sources');
  check('QL 数据源目录', (cat.json?.sources?.length ?? 0) >= 10, `${cat.json?.sources?.length ?? 0} 个源`);
  const v = await jpost('/api/v1/query/validate', { q: 'alerts | where severity = "high" | limit 3' });
  check('QL 编译校验返回 sql', v.status === 200 && /^select /i.test(String(v.json?.sql ?? '')));
  const agg = await jpost('/api/v1/query', { q: 'alerts | stats count() as n by severity | sort n desc' });
  check('QL 聚合查询出数', agg.status === 200 && (agg.json?.rows?.length ?? 0) >= 1, `${agg.json?.rows?.length ?? 0} 行`);
  const inj = await jpost('/api/v1/query', { q: 'alerts | where 1 = 1; drop table alerts' });
  check('QL 拒绝非查询语法(400)', inj.status === 400);
  const nofield = await jpost('/api/v1/query', { q: 'alerts | where password = "x"' });
  check('QL 白名单外字段被拒(400)', nofield.status === 400);
  const clamp = await jpost('/api/v1/query', { q: 'alerts | limit 99999' });
  check('QL LIMIT 强制截断', clamp.status === 200 && (clamp.json?.limit ?? 0) <= 1000, `limit=${clamp.json?.limit ?? '-'}`);
  const auditQl = await jpost('/api/v1/query', { q: 'audit | stats count() as n by action | sort n desc | limit 3' });
  check('QL 跨源（审计聚合）', auditQl.status === 200 && (auditQl.json?.rows?.length ?? 0) >= 1);

  /* 9. 保留策略与导出 */
  console.log('[9] 保留策略 / 导出');
  const ret = await jget('/api/v1/retention');
  const policies: any[] = ret.json?.policies ?? [];
  check('保留策略已加载', policies.length >= 7, `${policies.length} 张表`);
  const tel = policies.find((p) => p.table === 'telemetry');
  check('telemetry 有保留期', (tel?.days ?? 0) > 0, `days=${tel?.days} rows≈${tel?.rows}`);
  check('业务单据不清洗', (policies.find((p) => p.table === 'tickets')?.days ?? -1) === 0);
  // 定时清理（每 60min）可能正持锁：locked 时等它释放再干跑，避免偶发误报
  // （现网踩过：容器刚重启 3 分钟后的首次定时清理与 E2E 撞上 → tables=[]）
  let dry: any = null;
  for (let i = 0; i < 3; i++) {
    dry = await jpost('/api/v1/retention/run', { dry_run: true, tables: ['telemetry'] });
    if (dry.status === 200 && !dry.json?.locked) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  check(
    '保留干跑只统计不删',
    dry.status === 200 && dry.json?.tables?.length === 1 && dry.json?.tables?.[0]?.deleted === 0,
    `matched=${dry.json?.tables?.[0]?.matched}${dry.json?.locked ? ' locked（已重试）' : ''}`,
  );

  const cat2 = await jget('/api/v1/export/catalog');
  check('导出目录含 csv/jsonl', (cat2.json?.formats ?? []).join(',') === 'csv,jsonl');
  const csv = await raw('/api/v1/export', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ q: 'alerts | fields ts, severity, rule_id, summary | limit 3', format: 'csv' }),
  });
  const csvLines = csv.text.replace(/^\ufeff/, '').trim().split('\r\n');
  const csvBytes = await rawBuf('/api/v1/export?q=' + encodeURIComponent('alerts | limit 2') + '&format=csv');
  const hasBom =
    csvBytes.bytes[0] === 0xef && csvBytes.bytes[1] === 0xbb && csvBytes.bytes[2] === 0xbf;
  check('导出 CSV 带 UTF-8 BOM', hasBom, Array.from(csvBytes.bytes.slice(0, 3)).map((b) => b.toString(16)).join(' '));
  check('导出 CSV 表头正确', csvLines[0] === 'ts,severity,rule_id,summary', csvLines[0]?.slice(0, 60));
  check('导出 CSV 行数匹配 limit', csvLines.length === 4, `${csvLines.length} 行（含表头）`);
  check('导出响应带 attachment 头', String(csv.headers.get('content-disposition') ?? '').includes('attachment'));

  const jl = await raw('/api/v1/export', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ q: 'alerts | fields ts, severity | limit 2', format: 'jsonl' }),
  });
  const jlLines = jl.text.trim().split('\n').filter(Boolean);
  let jlOk = jlLines.length === 2;
  for (const l of jlLines) {
    try {
      if (typeof JSON.parse(l) !== 'object') jlOk = false;
    } catch { jlOk = false; }
  }
  check('导出 JSONL 每行是合法 JSON', jlOk, `${jlLines.length} 行`);

  const csvGet = await raw(`/api/v1/export?q=${encodeURIComponent('alerts | limit 1')}&format=csv`);
  check('导出支持 GET 直下', csvGet.status === 200 && csvGet.text.split('\r\n').filter(Boolean).length === 2);
  // measure_points 是唯一没有时间列的源：验证"无 order by 时补 order by 1"没有拼到 limit 之后
  const mp = await raw('/api/v1/export?q=' + encodeURIComponent('measure_points | fields device_id, point_id, unit') + '&format=csv');
  check('导出无排序列的源', mp.status === 200 && mp.text.replace(/^\ufeff/, '').startsWith('device_id,point_id,unit'));
  const capped = await raw('/api/v1/export', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ q: 'alerts | fields ts', format: 'csv', max_rows: 2 }),
  });
  check('导出 max_rows 生效', capped.text.replace(/^\ufeff/, '').trim().split('\r\n').length === 3);
  const badExport = await raw('/api/v1/export?q=' + encodeURIComponent('alerts | where password = "x"'));
  check('导出沿用白名单校验(400)', badExport.status === 400);
  const noQ = await raw('/api/v1/export');
  check('导出缺少 q 返回 400', noQ.status === 400);

  /* 10. 事件落库 / 检索 / 流量包导入 */
  console.log('[10] 事件落库 / 检索 / 流量包导入');
  const stamp = Date.now();
  const marker = `e2e-${stamp}`;
  const iso = new Date().toISOString();

  const push1 = await jpost('/api/v1/ingest/events', {
    source: 'e2e',
    event: {
      '@timestamp': iso,
      event: { category: 'authentication', outcome: 'failure', name: marker },
      sime: { domain: 'it' },
      src: { ip: '198.51.100.77', asset_id: marker },
      dst: { ip: '10.9.9.9' },
      user: { name: 'e2e' },
    },
  });
  check('事件直推 200', push1.status === 200 && push1.json?.accepted === 1, `alerts=${push1.json?.alerts ?? '-'}`);

  const evList = await jget(`/api/v1/events?q=${encodeURIComponent(marker)}&limit=5`);
  const evRows: any[] = evList.json?.rows ?? [];
  check('事件列表可检索（走 events 表）', evList.status === 200 && evRows.length >= 1, `${evRows.length} 行`);
  check('列表默认带 24h 窗口', typeof evList.json?.window?.from === 'string' && typeof evList.json?.window?.to === 'string');
  const evId = evRows[0]?.id;
  check('事件行含 domain/category/src', evRows[0]?.domain === 'it' && evRows[0]?.category === 'authentication' && !!evRows[0]?.src?.ip);

  const evOne = evId ? await jget(`/api/v1/events/${evId}`) : { status: 0, json: null as any };
  check('事件详情含完整 payload', evOne.status === 200 && evOne.json?.payload?.event?.name === marker);
  const evMiss = await jget('/api/v1/events/999999999');
  check('不存在的事件返回 404', evMiss.status === 404);

  const evStats = await jget('/api/v1/events/stats?interval=1%20hour');
  check(
    '事件分布聚合',
    evStats.status === 200 && (evStats.json?.total ?? 0) >= 1 && (evStats.json?.byCategory?.length ?? 0) >= 1,
    `total=${evStats.json?.total} 类别=${evStats.json?.byCategory?.length}`,
  );

  const qlEvents = await jpost('/api/v1/query', { q: 'events | stats count() as n' });
  check('SIME QL 的 events 源已有数据', Number(qlEvents.json?.rows?.[0]?.n ?? 0) >= 1, `n=${qlEvents.json?.rows?.[0]?.n}`);

  // 10.4 multipart 流量包导入（ECS JSONL）
  const jsonl = [
    { '@timestamp': iso, event: { category: 'network-connection', outcome: 'success', name: `${marker}-imp1` }, src: { ip: '203.0.113.61' }, dst: { ip: '10.9.9.10' } },
    { '@timestamp': iso, event: { category: 'network-connection', outcome: 'success', name: `${marker}-imp2` }, src: { ip: '203.0.113.62' }, dst: { ip: '10.9.9.11' } },
    { '@timestamp': iso, event: { category: 'ics-command', outcome: 'success', name: `${marker}-imp3` }, src: { ip: '10.233.9.70' }, dst: { ip: '10.233.9.3' } },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n');

  async function upload(
    body: BodyInit,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any }> {
    const r = await fetch(`${BASE}/api/v1/ingest/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
    });
    let json: any = null;
    try {
      json = await r.json();
    } catch { /* 非 JSON */ }
    return { status: r.status, json };
  }

  const fd = new FormData();
  fd.append('file', new Blob([jsonl], { type: 'application/x-ndjson' }), 'e2e.jsonl');
  fd.append('source', 'e2e-import');
  const imp = await upload(fd);
  check(
    'multipart 导入 3 条全部入库',
    imp.status === 200 && imp.json?.accepted === 3 && imp.json?.rejected === 0,
    `accepted=${imp.json?.accepted} rejected=${imp.json?.rejected} alerts=${imp.json?.alerts}`,
  );
  check('导入记录来源通道', imp.json?.source === 'e2e-import' && imp.json?.format === 'jsonl');
  const impList = await jget(`/api/v1/events?source=e2e-import&q=${encodeURIComponent(marker)}&limit=10`);
  check('导入的事件可立即查到', (impList.json?.rows?.length ?? 0) === 3, `${impList.json?.rows?.length ?? 0} 行`);
  check('导入事件按域自动分区', (impList.json?.rows ?? []).some((r: any) => r.domain === 'ot'));

  // 坏行隔离：1 条正常 + 1 条坏 JSON → 部分成功而不是整包失败
  const mixed = JSON.stringify({ '@timestamp': iso, event: { category: 'web', name: `${marker}-ok` } }) + '\n{ 这不是 JSON\n';
  const impMixed = await upload(new Blob([mixed], { type: 'application/x-ndjson' }), { 'X-Sime-Filename': 'mixed.jsonl' });
  check(
    '坏行只拒绝该行不中断整批',
    impMixed.status === 200 && impMixed.json?.accepted === 1 && impMixed.json?.rejected === 1,
    `accepted=${impMixed.json?.accepted} rejected=${impMixed.json?.rejected}`,
  );
  check('拒绝原因带行号', impMixed.json?.errors?.[0]?.line === 2, `line=${impMixed.json?.errors?.[0]?.line ?? '-'}`);

  // 裸 ndjson 流（curl --data-binary 的等价形态）
  const rawImp = await upload(new Blob([jsonl], { type: 'application/x-ndjson' }) as unknown as BodyInit, {
    'X-Sime-Filename': 'raw.ndjson',
  });
  check(
    '裸 ndjson 流导入',
    rawImp.status === 200 && rawImp.json?.accepted === 3 && rawImp.json?.file === 'raw.ndjson',
    `file=${rawImp.json?.file ?? '-'}`,
  );

  // adapter 模式：厂商原始日志 → 适配器映射 → 入库
  // 取第一个"样例能解析成功"的适配器（不同版本里可能有适配器样例本身就不通，不该让 e2e 陪绑）
  const cands = (adapters.json ?? []).filter(
    (a: any) => ['regex', 'json', 'kv'].includes(String(a.format)) && a.sample && !String(a.sample).includes('\n'),
  );
  let picked: any = null;
  for (const a of cands.slice(0, 12)) {
    const probe = await jpost(`/api/v1/adapters/${encodeURIComponent(a.id)}/test`, { raw: a.sample });
    // Nest 的 POST 默认是 201，判 2xx 而不是 200（这里踩过一次：把 201 当成失败）
    if (probe.status >= 200 && probe.status < 300 && probe.json?.ok) {
      picked = a;
      break;
    }
  }
  if (picked?.id) {
    const fdA = new FormData();
    fdA.append('file', new Blob([picked.sample], { type: 'text/plain' }), 'vendor.log');
    fdA.append('adapter', String(picked.id));
    const impA = await upload(fdA);
    check(
      '适配器模式导入（厂商日志→ECS）',
      impA.status === 200 && impA.json?.accepted === 1 && impA.json?.format === 'adapter-lines',
      `adapter=${picked.id} accepted=${impA.json?.accepted} rejected=${impA.json?.rejected}`,
    );
    check('适配器导入的来源带 adapter 前缀', String(impA.json?.source ?? '').startsWith('adapter:'));
  } else {
    check('适配器模式导入（厂商日志→ECS）', false, `无可用单行样例适配器（候选 ${cands.length} 个）`);
  }

  // 异常输入
  const emptyImp = await upload(new Blob([''], { type: 'application/x-ndjson' }) as unknown as BodyInit);
  check('空文件被拒(400)', emptyImp.status === 400);
  const badAdapter = new FormData();
  badAdapter.append('file', new Blob([jsonl], { type: 'application/x-ndjson' }), 'x.jsonl');
  badAdapter.append('adapter', 'no-such-adapter');
  const badA = await upload(badAdapter);
  check('未知适配器被拒(400)', badA.status === 400);
  const csvImp = await upload(new Blob(['time,src,dst\n1,2,3\n'], { type: 'text/csv' }) as unknown as BodyInit, {
    'X-Sime-Filename': 'x.csv',
  });
  check('CSV 被明确拒绝(400)', csvImp.status === 400);

  const ingStats = await jget('/api/v1/ingest/stats');
  check('摄入计数可见', (ingStats.json?.store?.received ?? 0) >= 8, `received=${ingStats.json?.store?.received}`);

  const retEvents = await jget('/api/v1/retention');
  const evPolicy = (retEvents.json?.policies ?? []).find((p: any) => p.table === 'events');
  check('events 已纳入保留期', (evPolicy?.days ?? 0) > 0, `days=${evPolicy?.days}`);

  /* 汇总 */
  console.log(`\n===== E2E 结果: ${passed} 通过 / ${failed} 失败 =====`);
  if (failures.length) {
    console.error('失败项:', failures.join(' | '));
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main().catch((e) => {
  console.error('E2E 异常终止:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
