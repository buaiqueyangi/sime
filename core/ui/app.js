/* SIME 控制台 v2 —— 视图化 NOC 风格；vanilla JS，CSP 安全（无内联脚本/处理器） */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (n) => Number(n ?? 0).toLocaleString('en-US');
const rel = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return `${Math.round(s / 86400)}d 前`;
};
const hhmmss = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

async function jget(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') } });
  if (r.status === 401) {
    showLogin(true);
    throw new Error('未登录或会话已过期');
  }
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/* ===== 登录 ===== */
function showLogin(show) {
  $('loginView').classList.toggle('hidden', !show);
}

$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  try {
    const r = await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }),
    });
    if (!r.ok) throw new Error((await r.json()).message || '登录失败');
    const j = await r.json();
    localStorage.setItem('sime_token', j.token);
    showLogin(false);
    lastAlertCount = -1;
    toast(`欢迎回来，${j.user}`);
    wsConnect();
    refreshHealth(); refreshAlerts(); refreshRules(); refreshCatalog(); refreshTelemetry();
  } catch (e) {
    $('loginErr').textContent = e.message;
  }
};
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ===== 视图切换 ===== */
const TITLES = { overview: '概览', alerts: '实时告警', telemetry: '设备遥测', topology: '组态总览', rules: '检测规则库', catalog: '适配与物模型', response: '处置闭环', lake: '数据湖', assistant: 'AI 助手' };
let currentView = 'overview';

function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  $('viewTitle').textContent = TITLES[v] ?? v;
  if (v === 'telemetry') setTimeout(() => { if (chart) chart.resize(); refreshTelemetry(); }, 30);
  if (v === 'response') refreshResponses();
  if (v === 'lake') refreshLake();
  if (v === 'topology') refreshTopology();
  if (v === 'assistant') initAssistant();
  if (v === 'alerts') refreshAlerts();
}
document.querySelectorAll('#nav a').forEach((a) => (a.onclick = () => showView(a.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((a) => (a.onclick = () => showView(a.dataset.goto)));

/* ===== 健康与概览 ===== */
let health = null;

async function refreshHealth() {
  try {
    health = await jget('/api/v1/health');
    const pill = $('health');
    pill.innerHTML = `<span class="pulse"></span><span class="status-text">运行中 · 告警 ${fmtN(health.ruleEngine.alerts)} · 存储 ${health.pgProfile === 'active' ? 'PostgreSQL' : '内存'}</span>`;
    pill.classList.remove('err');
    if (currentView === 'overview') renderOverview();
    if (currentView === 'overview') refreshTrend();
    return health;
  } catch (e) {
    $('health').classList.add('err');
    $('health').innerHTML = `<span class="pulse"></span><span class="status-text">连接失败</span>`;
  }
}

const ICONS = {
  rules: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/></svg>',
  adapters: '<svg viewBox="0 0 24 24"><path d="M7 2v6H5v4a2 2 0 0 0 2 2h2v6h2v-6h2a2 2 0 0 0 2-2V8h-2V2z"/></svg>',
  models: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
  alerts: '<svg viewBox="0 0 24 24"><path d="M12 2a6 6 0 0 0-6 6v4l-2 4h16l-2-4V8a6 6 0 0 0-6-6z"/></svg>',
  store: '<svg viewBox="0 0 24 24"><path d="M4 4h16v5H4zM4 11h16v5H4zM4 18h16v2H4z"/></svg>',
  engine: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 6.2L21 9l-5 4.4L17.5 21 12 17.3 6.5 21 8 13.4 3 9l6.6-.8z"/></svg>',
};

function renderOverview() {
  $('cards').innerHTML = [
    { k: '检测规则', v: fmtN(health.assets.rules), ic: ICONS.rules },
    { k: '日志源适配器', v: fmtN(health.assets.adapters), ic: ICONS.adapters },
    { k: '物模型模板', v: fmtN(health.assets['thing-models']), ic: ICONS.models },
    { k: '累计告警', v: fmtN(health.ruleEngine.alerts), ic: ICONS.alerts },
    { k: '告警存储', v: health.pgProfile === 'active' ? 'PostgreSQL' : '内存', ic: ICONS.store },
    { k: '规则引擎', v: 'v2 增量聚合', ic: ICONS.engine },
  ].map((c) => `<div class="card"><div class="ic">${c.ic}</div><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div></div>`).join('');
}

async function refreshOverviewAlerts() {
  if (currentView !== 'overview') return;
  const a = await jget('/api/v1/alerts');
  const rows = (a.items || []).slice(0, 6);
  $('ovAlerts').innerHTML = rows.length
    ? rows.map((x) => `<tr>
        <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
        <td>${esc(x.ruleName)}<div class="dim mono">${esc(x.ruleId)}</div></td>
        <td class="dim">${rel(Date.parse(x.ts))}</td></tr>`).join('')
    : '<tr><td class="empty">暂无告警</td></tr>';
  $('ovComponents').innerHTML = [
    ['MQTT 接入', health ? (health.pgProfile ? 'EMQX · sime/v1/#' : '未启用') : '-'],
    ['规则引擎', `v2 增量聚合 · ${health ? health.ruleEngine.compiled : '-'} 条已编译`],
    ['适配器执行引擎', 'compile-once · 样例回归'],
    ['处置闭环', '工单 / 通知 / 响应审计'],
    ['API 契约', '/docs（Swagger）'],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="dim">${esc(v)}</td></tr>`).join('');
}

/* ===== 实时告警 ===== */
let sevFilter = 'all';
let lastAlertCount = -1;

async function refreshAlerts() {
  try {
    const a = await jget('/api/v1/alerts');
    const items = a.items || [];
    const filtered = sevFilter === 'all' ? items : items.filter((x) => x.severity === sevFilter);
    $('alertNote').textContent = `累计 ${fmtN(a.stats.alerts)} · 当前显示 ${filtered.length}${a.pgActive ? ' · PG 持久化（可闭环操作）' : ' · 内存态'}`;
    $('alerts').innerHTML = filtered.length
      ? filtered.map((x) => `<tr>
          <td class="mono" title="${esc(x.ts)}">${hhmmss(Date.parse(x.ts))}</td>
          <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
          <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
          <td>${esc(x.ruleName)}<div class="dim mono">${esc(x.ruleId)}</div></td>
          <td class="mono">${esc(x.groupKey)}</td>
          <td><span class="tag ${x.state === 'resolved' ? 'low' : x.state === 'ack' ? 'info' : 'high'}">${esc(x.state || 'open')}</span></td>
          <td>${x.pgId ? `<button class="mini" data-act="ack" data-id="${x.pgId}">确认</button><button class="mini resolve" data-act="resolve" data-id="${x.pgId}">解决</button>` : '<span class="dim">-</span>'}</td>
          <td>${esc(x.summary)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">该级别暂无告警</td></tr>';
    document.querySelectorAll('#alerts [data-act]').forEach((b) => {
      b.onclick = () => alertAction(b.dataset.act, b.dataset.id);
    });
    if (items.length !== lastAlertCount) {
      lastAlertCount = items.length;
      if (currentView !== 'alerts' && items.length) $('navAlertDot').classList.remove('hidden');
    }
    if (currentView === 'overview') refreshOverviewAlerts();
  } catch (e) { /* 静默重试 */ }
}

async function alertAction(act, pgId) {
  try {
    await jget(`/api/v1/alerts/${pgId}/${act}`, { method: 'POST' });
    toast(`告警 #${pgId} 已${act === 'ack' ? '确认' : '解决'}`);
    refreshAlerts();
  } catch (e) {
    toast('操作失败: ' + e.message, true);
  }
}

document.querySelectorAll('#sevChips .chip').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('#sevChips .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    sevFilter = c.dataset.sev;
    refreshAlerts();
  };
});

/* ===== 模拟攻击 ===== */
async function simulate(reset) {
  const btn = $('simulate');
  btn.disabled = true;
  try {
    const j = await jget('/api/v1/pipeline/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: !!reset }),
    });
    toast(`回放 ${j.events} 条事件 → 新增 ${j.newAlerts} 条告警（累计 ${j.stats.alerts}）`);
  } catch (e) {
    toast('回放失败: ' + e.message, true);
  }
  btn.disabled = false;
  lastAlertCount = -1;
  await refreshAlerts();
  await refreshHealth();
}
$('simulate').onclick = () => simulate(false);
$('reset').onclick = () => simulate(true);

/* ===== 设备遥测 ===== */
let chart = null;
const telSel = { assetId: null, point: null };
const telSeriesBuf = [];

async function refreshTelemetry() {
  if (currentView !== 'telemetry') return;
  try {
    const latest = await jget('/api/v1/telemetry/latest');
    const rows = (latest || []).slice(0, 50);
    $('telLatest').innerHTML = rows.length
      ? rows.map((x) => `<tr><td class="mono">${esc(x.assetId)}</td><td class="mono">${esc(x.point)}</td><td>${fmtN(Math.round(x.value * 100) / 100)}</td><td class="dim mono">${rel(x.ts)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">等待设备接入 —— MQTT 发布到 sime/v1/{deviceId}/telemetry，或启用 compose sim profile</td></tr>';
    fillSelectors([...new Set((latest || []).map((x) => `${x.assetId}|${x.point}`))]);
    if (telSel.assetId && telSel.point) {
      const s = await jget(`/api/v1/telemetry/series?asset_id=${encodeURIComponent(telSel.assetId)}&point=${encodeURIComponent(telSel.point)}&limit=180`);
      telSeriesBuf.length = 0;
      telSeriesBuf.push(...s.map((p) => [p.ts, p.value]));
      drawChart(s);
    }
  } catch (e) { /* 静默重试 */ }
}

function fillSelectors(pairs) {
  if (!pairs.length) return;
  if (!telSel.assetId || !pairs.includes(`${telSel.assetId}|${telSel.point}`)) {
    const [a, p] = pairs[0].split('|');
    telSel.assetId = a;
    telSel.point = p;
  }
  const assets = [...new Set(pairs.map((p) => p.split('|')[0]))];
  $('telAsset').innerHTML = assets.map((a) => `<option value="${esc(a)}" ${a === telSel.assetId ? 'selected' : ''}>${esc(a)}</option>`).join('');
  $('telPoint').innerHTML = pairs
    .filter((p) => p.split('|')[0] === telSel.assetId)
    .map((p) => p.split('|')[1])
    .map((p) => `<option value="${esc(p)}" ${p === telSel.point ? 'selected' : ''}>${esc(p)}</option>`)
    .join('');
}

$('telAsset').onchange = (e) => { telSel.assetId = e.target.value; telSel.point = null; refreshTelemetry(); };
$('telPoint').onchange = (e) => { telSel.point = e.target.value; refreshTelemetry(); };

function drawChart(series) {
  if (!window.echarts || !series.length) return;
  if (!chart) chart = window.echarts.init($('chart'));
  chart.setOption({
    grid: { left: 56, right: 20, top: 18, bottom: 42 },
    tooltip: { trigger: 'axis', backgroundColor: '#101c33', borderColor: 'rgba(122,150,205,.3)', textStyle: { color: '#dce5f7' } },
    xAxis: { type: 'time', axisLabel: { color: '#7e8fb3' }, axisLine: { lineStyle: { color: '#1e2a44' } } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#7e8fb3' }, splitLine: { lineStyle: { color: 'rgba(122,150,205,.12)' } } },
    series: [{
      type: 'line', showSymbol: false, smooth: true,
      lineStyle: { color: '#4f8cff', width: 2 },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(79,140,255,.28)' }, { offset: 1, color: 'rgba(79,140,255,0)' }] } },
      data: series.map((p) => [p.ts, p.value]),
    }],
  });
}

/* ===== 规则 / 适配 / 物模型 ===== */
let ruleDomain = 'all';
let allRules = [];

async function refreshRules() {
  allRules = await jget('/api/v1/rules');
  renderRules();
  $('ruleCount').textContent = `共 ${allRules.length} 条（ATT&CK 全映射 · 目标 3000+）`;
}

function renderRules() {
  const list = ruleDomain === 'all' ? allRules : allRules.filter((x) => x.domain === ruleDomain);
  $('rules').innerHTML = list.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.name)}</td>
    <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
    <td class="dim">${esc(x.category)}</td>
    <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
    <td class="mono">${esc((x.techniques || []).join(' '))}</td></tr>`).join('');
}

document.querySelectorAll('#ruleDomainChips .chip').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('#ruleDomainChips .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    ruleDomain = c.dataset.domain;
    renderRules();
  };
});

async function refreshCatalog() {
  const adapters = await jget('/api/v1/adapters');
  $('adapters').innerHTML = adapters.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.vendor)} / ${esc(x.product)}</td>
    <td class="dim">${esc(x.protocol)}</td><td>${x.threatCount} 条</td></tr>`).join('');
  const models = await jget('/api/v1/thing-models');
  $('models').innerHTML = models.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.label)}</td>
    <td>${x.propertyCount} / ${x.eventCount}</td>
    <td class="dim">关键性 ${esc(x.security?.asset_criticality ?? '-')} · ${esc(x.security?.exposure ?? '-')}</td></tr>`).join('');
}

/* ===== 处置闭环 ===== */
async function refreshResponses() {
  try {
    const [r, pb] = await Promise.all([jget('/api/v1/responses'), jget('/api/v1/playbooks')]);
    $('playbooks').innerHTML = (pb.playbooks || []).length
      ? pb.playbooks.map((p) => `<tr>
          <td>${esc(p.name)}<div class="dim mono">${esc(p.id)}</div></td>
          <td class="mono">${esc(p.rules.join('<br>'))}</td>
          <td class="dim mono">${esc(p.steps.join(' → '))}</td>
          <td>${p.runs}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">无剧本</td></tr>';
    $('rTickets').innerHTML = (r.tickets || []).length
      ? r.tickets.map((t) => `<tr><td>${esc(t.title)}</td>
          <td><span class="tag ${t.state === 'closed' ? 'low' : 'medium'}">${esc(t.state)}</span></td>
          <td class="dim">${rel(t.ts)}</td>
          <td>${t.state !== 'closed' && t.id ? `<button class="mini resolve" data-ticket="${t.id}">关闭</button>` : ''}</td></tr>`).join('')
      : '<tr><td class="empty">暂无工单</td></tr>';
    document.querySelectorAll('#rTickets [data-ticket]').forEach((b) => {
      b.onclick = async () => {
        try {
          await jget(`/api/v1/responses/tickets/${b.dataset.ticket}/close`, { method: 'POST' });
          toast(`工单 #${b.dataset.ticket} 已关闭`);
          refreshResponses();
        } catch (e) { toast('关闭失败: ' + e.message, true); }
      };
    });
    $('rNotify').innerHTML = (r.notifications || []).length
      ? r.notifications.map((n) => `<tr><td class="mono">notify.${esc(n.channel)}</td><td class="mono">${esc(n.groupKey)}</td><td class="dim">${rel(n.ts)}</td></tr>`).join('')
      : '<tr><td class="empty">暂无通知</td></tr>';
    $('rAudit').innerHTML = (r.audit || []).length
      ? r.audit.map((a) => `<tr><td class="dim mono">${hhmmss(a.ts)}</td><td class="mono">${esc(a.action)}</td><td class="mono">${esc(a.target)}</td><td><span class="tag low">${esc(a.status)}</span></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">暂无响应动作</td></tr>';
  } catch (e) { /* 静默重试 */ }
}

/* ===== 告警趋势（24h） ===== */
let trendChart = null;

async function refreshTrend() {
  try {
    const t = await jget('/api/v1/alerts/trend');
    $('trendNote').textContent = `24h 合计 ${t.total} 条`;
    if (!window.echarts) return;
    if (!trendChart) trendChart = window.echarts.init($('trend'));
    trendChart.setOption({
      grid: { left: 40, right: 16, top: 14, bottom: 36 },
      tooltip: { trigger: 'axis', backgroundColor: '#101c33', borderColor: 'rgba(122,150,205,.3)', textStyle: { color: '#dce5f7' } },
      xAxis: { type: 'category', data: t.hours.map((x) => new Date(x.ts).getHours() + '时'), axisLabel: { color: '#7e8fb3' }, axisLine: { lineStyle: { color: '#1e2a44' } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#7e8fb3' }, splitLine: { lineStyle: { color: 'rgba(122,150,205,.12)' } } },
      series: [{ type: 'bar', barWidth: '55%', itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#4f8cff' }, { offset: 1, color: 'rgba(124,92,255,.35)' }] } }, data: t.hours.map((x) => x.count) }],
    });
  } catch (e) { /* 静默重试 */ }
}

/* ===== WebSocket 实时推送（轮询兜底） ===== */
let ws = null;
function wsConnect() {
  const t = localStorage.getItem('sime_token');
  if (!t || (ws && ws.readyState <= 1)) { setTimeout(wsConnect, 3000); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(t)}`);
  } catch { setTimeout(wsConnect, 3000); return; }
  ws.onopen = () => { $('wsState').textContent = 'WebSocket 已连接 · 告警毫秒级推送'; };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'alert') {
        toast(`[${m.alert.severity}] ${m.alert.ruleName}`, m.alert.severity === 'critical');
        lastAlertCount = -1;
        refreshAlerts(); refreshHealth();
      } else if (m.type === 'alert-state') {
        refreshAlerts();
      } else if (m.type === 'telemetry') {
        for (const p of m.points || []) {
          if (!topoValues.has(p.assetId)) topoValues.set(p.assetId, []);
          const arr = topoValues.get(p.assetId);
          const idx = arr.findIndex((x) => x.point === p.point);
          if (idx >= 0) arr[idx] = p;
          else arr.push(p);
        }
        if (currentView === 'topology') updateTopoValues(new Map());
        if (currentView === 'telemetry' && telSel.assetId && chart) {
          const hit = (m.points || []).find((p) => p.assetId === telSel.assetId && p.point === telSel.point);
          if (hit) {
            telSeriesBuf.push([hit.ts, hit.value]);
            if (telSeriesBuf.length > 180) telSeriesBuf.shift();
            chart.setOption({ series: [{ data: telSeriesBuf }] });
          }
        }
      }
    } catch { /* 忽略坏帧 */ }
  };
  ws.onclose = () => { $('wsState').textContent = 'WebSocket 断开（轮询兜底中）'; setTimeout(wsConnect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}
wsConnect();

/* ===== 组态总览 v1：运行态渲染 + 拖拽编辑器（布局持久化到 config 表） ===== */
let topoLayout = new Map(); // assetId -> {x,y}
let topoEdit = false;
let topoSel = null;
let topoDrag = null;
let topoValues = new Map(); // assetId -> 最新测点

async function refreshTopology() {
  if (currentView !== 'topology' || topoDrag) return;
  try {
    const [layout, latest, devices] = await Promise.all([
      jget('/api/v1/topology/layout'),
      jget('/api/v1/telemetry/latest'),
      jget('/api/v1/telemetry/devices'),
    ]);
    topoLayout = new Map((layout.items || []).map((i) => [i.assetId, { x: i.x, y: i.y }]));
    topoValues = new Map();
    for (const x of latest || []) {
      if (!topoValues.has(x.assetId)) topoValues.set(x.assetId, []);
      topoValues.get(x.assetId).push(x);
    }
    const devInfo = new Map((devices || []).map((d) => [d.assetId, d]));
    const allAssets = [...new Set([...topoValues.keys(), ...(devices || []).map((d) => d.assetId)])];
    // 自动排布未布置设备
    let auto = 0;
    for (const a of allAssets) {
      if (!topoLayout.has(a)) {
        topoLayout.set(a, { x: 20 + (auto % 6) * 192, y: 16 + Math.floor(auto / 6) * 118 });
        auto++;
      }
    }
    if (!topoEdit && !$('topoCanvas').children.length) renderTopo(devInfo);
    if (topoEdit && !$('topoCanvas').children.length) renderTopo(devInfo);
    updateTopoValues(devInfo);
    if (topoEdit) fillTopoAdd(devInfo, allAssets);
  } catch (e) { /* 静默重试 */ }
}

function renderTopo(devInfo) {
  const canvas = $('topoCanvas');
  const maxY = Math.max(560, ...[...topoLayout.values()].map((p) => p.y + 130));
  canvas.style.height = `${maxY}px`;
  canvas.innerHTML = '';
  for (const [assetId, pos] of topoLayout) {
    const tile = document.createElement('div');
    tile.className = 'topo-tile';
    tile.dataset.asset = assetId;
    tile.style.left = `${pos.x}px`;
    tile.style.top = `${pos.y}px`;
    const kind = devInfo.get(assetId)?.kind ?? 'device';
    tile.innerHTML = `<div class="t-name">${esc(assetId)}</div><div class="t-kind">${esc(kind)}</div><div class="t-vals"></div>${topoEdit ? '<button class="topo-del" title="移除">✕</button>' : ''}`;
    canvas.appendChild(tile);
    if (topoEdit) {
      tile.addEventListener('pointerdown', (e) => startTopoDrag(e, tile, assetId));
      tile.querySelector('.topo-del').onclick = (e) => {
        e.stopPropagation();
        topoLayout.delete(assetId);
        tile.remove();
      };
    } else {
      tile.onclick = () => {
        const vals = topoValues.get(assetId) || [];
        telSel.assetId = assetId;
        telSel.point = vals[0]?.point ?? null;
        showView('telemetry');
      };
    }
  }
  updateTopoValues(devInfo);
}

function updateTopoValues(devInfo) {
  for (const [assetId, tile] of [...$('topoCanvas').children].map((el) => [el.dataset.asset, el])) {
    const vals = (topoValues.get(assetId) || []).slice(0, 3);
    const box = tile.querySelector('.t-vals');
    if (box) {
      box.innerHTML = vals.length
        ? vals.map((p) => `<div class="t-val"><span>${esc(p.point)}</span><b>${fmtN(Math.round(p.value * 100) / 100)}</b></div>`).join('')
        : '<div class="t-val dim">等待数据…</div>';
    }
  }
}

function startTopoDrag(e, tile, assetId) {
  e.preventDefault();
  topoSel = assetId;
  const canvas = $('topoCanvas');
  const rect = tile.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  topoDrag = { tile, assetId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  const move = (ev) => {
    if (!topoDrag) return;
    const x = Math.max(0, Math.min(ev.clientX - cRect.left - topoDrag.dx, cRect.width - 180));
    const y = Math.max(0, ev.clientY - cRect.top - 2);
    tile.style.left = `${x}px`;
    tile.style.top = `${y}px`;
  };
  const up = () => {
    if (topoDrag) {
      topoLayout.set(assetId, {
        x: parseInt(tile.style.left, 10) || 0,
        y: parseInt(tile.style.top, 10) || 0,
      });
    }
    topoDrag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

$('topoEdit').onclick = () => {
  topoEdit = !topoEdit;
  $('topoEdit').textContent = topoEdit ? '✓ 完成编辑' : '✎ 编辑布局';
  $('topoEdit').classList.toggle('primary', topoEdit);
  $('topoEdit').classList.toggle('ghost', !topoEdit);
  ['topoAddSel', 'topoAdd', 'topoSave', 'topoDel'].forEach((id) => $(id).classList.toggle('hidden', !topoEdit));
  $('topoNote').textContent = topoEdit ? '编辑态：拖拽设备 · 添加/删除 · 保存布局' : '运行态 · 点击设备查看曲线 · 2s 刷新值';
  refreshTopology();
};

function fillTopoAdd(devInfo, allAssets) {
  const unplaced = allAssets.filter((a) => !topoLayout.has(a));
  $('topoAddSel').innerHTML = unplaced.length
    ? unplaced.map((a) => `<option value="${esc(a)}">${esc(a)}（${esc(devInfo.get(a)?.kind ?? 'device')}）</option>`).join('')
    : '<option value="">画布已包含全部设备</option>';
}

$('topoAdd').onclick = () => {
  const a = $('topoAddSel').value;
  if (!a) { toast('没有可添加的设备', true); return; }
  const canvas = $('topoCanvas');
  topoLayout.set(a, { x: Math.round(canvas.scrollLeft + 40 + Math.random() * 120), y: Math.round(canvas.scrollTop + 40 + Math.random() * 80) });
  topoSel = a;
  refreshTopology();
};

$('topoDel').onclick = () => {
  if (!topoSel) { toast('先在画布上点击选中一个设备', true); return; }
  topoLayout.delete(topoSel);
  topoSel = null;
  refreshTopology();
};

$('topoSave').onclick = async () => {
  try {
    await jget('/api/v1/topology/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [...topoLayout.entries()].map(([assetId, p]) => ({ assetId, ...p })) }),
    });
    toast('布局已保存（重载后仍生效）');
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  }
};

/* ===== 数据湖（DuckDB + Parquet） ===== */
async function refreshLake() {
  if (currentView !== 'lake') return;
  try {
    const s = await jget('/api/v1/lake/status');
    $('lakeFiles').innerHTML = (s.files || []).length
      ? s.files.map((f) => `<tr><td class="mono">${esc(f.file)}</td><td>${(f.bytes / 1024).toFixed(1)} KB</td></tr>`).join('')
      : '<tr><td colspan="2" class="empty">尚未生成快照</td></tr>';
    if (s.lastSnapshot) $('lakeNote').textContent = `上次快照 ${s.lastSnapshot.sid} · ${s.lastSnapshot.tookMs}ms · 存储目录 ${s.lakeDir}`;
  } catch (e) {
    $('lakeNote').textContent = e.message;
  }
}

$('lakeSnap').onclick = async () => {
  $('lakeSnap').disabled = true;
  $('lakeNote').textContent = '快照生成中…';
  try {
    const r = await jget('/api/v1/lake/snapshot', { method: 'POST' });
    toast(`快照完成：${r.files.map((f) => `${f.file} ${f.rows} 行`).join('，')}（${r.tookMs}ms）`);
  } catch (e) {
    toast('快照失败: ' + e.message, true);
  }
  $('lakeSnap').disabled = false;
  refreshLake();
};

$('lakeRun').onclick = async () => {
  try {
    const r = await jget('/api/v1/lake/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: $('lakeSql').value }),
    });
    if (!r.rows.length) {
      $('lakeOut').innerHTML = '<p class="dim" style="padding: 8px 4px">查询成功：0 行</p>';
      return;
    }
    const cols = r.columns;
    $('lakeOut').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows
      .map((row) => `<tr>${cols.map((c) => `<td class="mono">${esc(row[c])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  } catch (e) {
    $('lakeOut').innerHTML = `<p class="note" style="color: var(--crit); padding: 8px 4px">${esc(e.message)}</p>`;
  }
};

/* ===== 启动 ===== */
if (!localStorage.getItem('sime_token')) showLogin(true);
refreshRules().then(() => { if (currentView === 'rules') renderRules(); });
refreshCatalog();
refreshHealth();
refreshAlerts();
refreshTelemetry();
setInterval(refreshHealth, 3000);
setInterval(refreshAlerts, 3000);
setInterval(refreshTelemetry, 2000);
setInterval(refreshTopology, 2000);
setInterval(refreshTrend, 30000);

/* ===== AI 运维助手 ===== */
let aiBooted = false;
const chatHist = [];

async function initAssistant() {
  if (aiBooted) return;
  aiBooted = true;
  try {
    const s = await jget('/api/v1/assistant/status');
    $('aiMode').textContent = `模式：${s.mode} · 工具 ${s.tools} 个`;
  } catch (e) {
    $('aiMode').textContent = '状态获取失败';
  }
}

async function sendChat() {
  const box = $('chatText');
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  const log = $('chatLog');
  const u = document.createElement('div');
  u.className = 'chat-msg user';
  u.textContent = text;
  log.appendChild(u);
  const a = document.createElement('div');
  a.className = 'chat-msg ai';
  a.textContent = '思考中…';
  log.appendChild(a);
  log.scrollTop = log.scrollHeight;
  try {
    const j = await jget('/api/v1/assistant/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: chatHist.slice(-8) }),
    });
    a.textContent = j.answer + (j.stub ? '\n（离线演示模式 — 配置 SIME_LLM_BASEURL 接入真实大模型）' : '');
    chatHist.push({ role: 'user', content: text });
    chatHist.push({ role: 'assistant', content: j.answer });
  } catch (e) {
    a.textContent = '出错了：' + e.message;
  }
  log.scrollTop = log.scrollHeight;
}
$('chatSend').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
