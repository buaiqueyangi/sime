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
  const noAuth = await fetch(`${BASE}/api/v1/rules`);
  check('无 token 访问被拒(401)', noAuth.status === 401);
  const health = await jget('/api/v1/health');
  check('health 豁免且正常', health.status === 200 && health.json?.status === 'ok', `存储=${health.json?.pgProfile}`);
  const withAuth = await jget('/api/v1/rules');
  check('带 token 访问放行', withAuth.status === 200);

  /* 2. 资产库 */
  console.log('[2] 规则 / 适配器 / 物模型 / 剧本');
  const rules = await jget('/api/v1/rules');
  check('规则库规模 ≥ 30', (rules.json?.length ?? 0) >= 30, `实际 ${rules.json?.length ?? 0}`);
  check('规则全部挂 ATT&CK 技术', (rules.json ?? []).every((x: any) => (x.techniques ?? []).length > 0));
  const adapters = await jget('/api/v1/adapters');
  check('适配器规模 ≥ 15', (adapters.json?.length ?? 0) >= 15, `实际 ${adapters.json?.length ?? 0}`);
  const models = await jget('/api/v1/thing-models');
  check('物模型模板 ≥ 3', (models.json?.length ?? 0) >= 3);
  const pbs = await jget('/api/v1/playbooks');
  check('SOAR 剧本 = 20', (pbs.json?.playbooks?.length ?? 0) === 20, `实际 ${pbs.json?.playbooks?.length ?? 0}`);

  /* 3. 告警管道 */
  console.log('[3] 告警管道（模拟回放 → 检出 → 闭环）');
  const sim = await jpost('/api/v1/pipeline/simulate', {});
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
