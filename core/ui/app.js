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

/* 会话失效：清坏 token、回登录页、只提示一次（后台轮询每 2-3 秒触发一次 401，不能连着弹） */
let authExpired = false;
function handle401() {
  showLogin(true);
  if (!authExpired) {
    authExpired = true;
    localStorage.removeItem('sime_token');
    const err = $('loginErr');
    if (err) err.textContent = '登录已过期（服务可能重启过），请重新登录';
  }
  throw new Error('未登录或会话已过期');
}

async function jget(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') } });
  if (r.status === 401) return handle401();
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
    authExpired = false;
    $('loginErr').textContent = '';
    showLogin(false);
    lastAlertCount = -1;
    toast(`欢迎回来，${j.user}`);
    wsConnect();
    startConsole();
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
const TITLES = { overview: '概览', alerts: '实时告警', events: '事件检索', query: '安全查询', telemetry: '设备遥测', topology: '组态总览', rules: '检测规则库', agents: 'Agent 管理', catalog: '适配与物模型', response: '处置闭环', lake: '数据湖', assistant: 'AI 助手' };
let currentView = 'overview';

function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  $('viewTitle').textContent = TITLES[v] ?? v;
  if (v === 'telemetry') setTimeout(() => { if (chart) chart.resize(); refreshTelemetry(); }, 30);
  if (v === 'events') { refreshEvents(); refreshEventStats(); }
  if (v === 'query') initQuery();
  if (v === 'response') refreshResponses();
  if (v === 'rules') refreshHitStats(); // 启动时不在规则页会跳过，切进来时补拉
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
    ? rows.map((x) => `<tr class="alert-row" data-key="${esc(x.pgId ?? x.id)}" title="点击查看详情">
        <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
        <td>${esc(x.ruleName)}<div class="dim mono">${esc(x.ruleId)}</div></td>
        <td class="dim">${rel(Date.parse(x.ts))}</td></tr>`).join('')
    : '<tr><td class="empty">暂无告警</td></tr>';
  document.querySelectorAll('#ovAlerts tr.alert-row').forEach((tr) => {
    tr.onclick = () => openAlertDetail(tr.dataset.key);
  });
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
      ? filtered.map((x) => `<tr class="alert-row" data-key="${esc(x.pgId ?? x.id)}" title="点击查看详情：规则逻辑 / 处置建议 / 关联工单">
          <td class="mono" title="${esc(x.ts)}">${hhmmss(Date.parse(x.ts))}</td>
          <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
          <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
          <td>${esc(x.ruleName)}<div class="dim mono">${esc(x.ruleId)}</div></td>
          <td class="mono">${esc(x.groupKey)}${x.hits ? `<div class="dim">${fmtN(x.hits)} 次</div>` : ''}</td>
          <td><span class="tag ${x.state === 'resolved' ? 'low' : x.state === 'ack' ? 'info' : 'high'}">${esc(x.state || 'open')}</span></td>
          <td>${x.pgId ? `<button class="mini" data-act="ack" data-id="${x.pgId}">确认</button><button class="mini resolve" data-act="resolve" data-id="${x.pgId}">解决</button>` : '<span class="dim">-</span>'}</td>
          <td>${esc(x.summary)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">该级别暂无告警</td></tr>';
    document.querySelectorAll('#alerts [data-act]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        alertAction(b.dataset.act, b.dataset.id);
      };
    });
    document.querySelectorAll('#alerts tr.alert-row').forEach((tr) => {
      tr.onclick = () => openAlertDetail(tr.dataset.key);
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
    if (modalAlert && String(modalAlert.key) === String(pgId)) openAlertDetail(pgId);
  } catch (e) {
    toast('操作失败: ' + e.message, true);
  }
}

/* ===== 告警详情（点开一条告警：为什么报、该怎么办、关联了什么） ===== */
let modalAlert = null;

function closeAlertModal() {
  $('alertModal').classList.add('hidden');
  modalAlert = null;
}

async function openAlertDetail(key) {
  modalAlert = { key };
  const modal = $('alertModal');
  modal.classList.remove('hidden');
  $('alertModalTitle').textContent = '告警详情';
  $('alertModalTags').innerHTML = '';
  $('alertModalBody').innerHTML = '<p class="dim">加载中…</p>';
  $('alertAck').classList.add('hidden');
  $('alertResolve').classList.add('hidden');
  try {
    const d = await jget('/api/v1/alerts/' + encodeURIComponent(key));
    modalAlert = { key, data: d };
    $('alertModalTitle').textContent = d.rule?.name || d.ruleId;
    $('alertModalTags').innerHTML = [
      `<span class="tag ${esc(d.severity)}">${esc(d.severity)}</span>`,
      `<span class="tag ${esc(d.domain)}">${esc(d.domain)}</span>`,
      `<span class="tag ${d.state === 'resolved' ? 'low' : d.state === 'ack' ? 'info' : 'high'}">${esc(d.state)}</span>`,
      `<span class="note mono">${esc(d.ruleId)}</span>`,
    ].join('');
    if (d.pgId) {
      $('alertAck').classList.remove('hidden');
      $('alertResolve').classList.remove('hidden');
      $('alertAck').onclick = () => alertAction('ack', d.pgId);
      $('alertResolve').onclick = () => alertAction('resolve', d.pgId);
    }
    $('alertModalBody').innerHTML = renderAlertDetail(d);
    // 关联告警行点击 → 弹窗内直接切换到那条告警（不下钻关闭）
    document.querySelectorAll('.rel-row').forEach((r) => {
      r.onclick = () => openAlertDetail(r.dataset.rel);
    });
    const go = $('alertGoEvents');
    go.onclick = () => {
      closeAlertModal();
      showView('events');
      $('evtQ').value = d.groupKey && d.groupKey !== '-' ? d.groupKey : '';
      evtState.q = $('evtQ').value;
      refreshEvents();
      refreshEventStats();
    };
  } catch (e) {
    $('alertModalBody').innerHTML = `<p class="note" style="color:var(--crit)">${esc(e.message)}</p>`;
  }
}

function renderAlertDetail(d) {
  const det = d.rule && d.rule.detection ? d.rule.detection : null;
  const kv = `<dl class="kv">
      <dt>时间</dt><dd class="mono">${esc(d.ts)} <span class="dim">(${rel(Date.parse(d.ts))})</span></dd>
      <dt>命中主体</dt><dd class="mono">${esc(d.groupKey)}</dd>
      <dt>命中次数</dt><dd>${fmtN(d.hits)}</dd>
      <dt>规则</dt><dd>${esc(d.rule?.name || d.ruleId)} <span class="dim mono">${esc(d.ruleId)}${d.rule ? ' · v' + esc(d.rule.version) : ''}</span></dd>
      <dt>摘要</dt><dd>${esc(d.summary || '—')}</dd>
    </dl>`;

  const cond = det
    ? `<div class="jsonbox">${esc(
        [
          det['source'] ? `source:     ${det['source']}` : '',
          det['window'] ? `window:     ${det['window']}` : '',
          Array.isArray(det['group_by']) && det['group_by'].length ? `group_by:   ${det['group_by'].join(', ')}` : '',
          det['condition'] ? `condition:  ${det['condition']}` : '',
          det['threshold'] ? `threshold:  ${JSON.stringify(det['threshold'])}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )}</div>`
    : '<p class="dim">规则定义不可用（规则文件可能已下线）</p>';

  const atk = d.rule
    ? [...(d.rule.tactics || []), ...(d.rule.techniques || [])]
    : [];

  const tickets = (d.tickets || []).length
    ? `<table><thead><tr><th>#</th><th>标题</th><th>状态</th><th>创建</th></tr></thead><tbody>${d.tickets
        .map(
          (t) =>
            `<tr><td class="mono">${esc(t.id)}</td><td>${esc(t.title)}</td>
             <td><span class="tag ${t.state === 'closed' ? 'low' : 'medium'}">${esc(t.state)}</span></td>
             <td class="dim mono">${hhmmss(Date.parse(t.createdAt))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="dim">无关联工单（该规则未配置 ticket.create，或工单已归档）</p>';

  const refs = (d.rule?.references || [])
    .map((r) => {
      const s = String(r);
      const url = /^https?:\/\//.test(s) ? s : '';
      return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(s)}</a>` : esc(s)}</li>`;
    })
    .join('');

  // 关联告警：同主体近 24h 的其他告警（可点击下钻）
  const relatedAlerts = (d.related || []).length
    ? `<table><thead><tr><th>时间</th><th>级别</th><th>规则</th><th>状态</th><th>摘要</th></tr></thead><tbody>${d.related
        .map(
          (r) =>
            `<tr class="rel-row" data-rel="${r.pgId}" title="点击查看该告警详情" style="cursor:pointer">
             <td class="mono">${hhmmss(Date.parse(r.ts))}</td>
             <td><span class="tag ${esc(r.severity)}">${esc(r.severity)}</span></td>
             <td class="mono">${esc(r.ruleId)}</td>
             <td><span class="tag ${r.state === 'resolved' ? 'low' : r.state === 'ack' ? 'info' : 'high'}">${esc(r.state)}</span></td>
             <td class="dim">${esc(r.summary)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="dim">近 24h 无同主体其他告警</p>';

  return `
    ${kv}
    <div class="sec"><h3 class="sec-title">关联告警（同主体 · 近 24h）</h3>${relatedAlerts}</div>
    <div class="sec"><h3 class="sec-title">检测逻辑</h3>${cond}</div>
    ${d.rule?.triage ? `<div class="sec"><h3 class="sec-title">处置建议</h3><p>${esc(d.rule.triage)}</p></div>` : ''}
    ${
      (d.rule?.response || []).length
        ? `<div class="sec"><h3 class="sec-title">触发动作</h3><div class="taglist">${d.rule.response
            .map((r) => `<span class="tag info mono">${esc(r)}</span>`)
            .join('')}</div></div>`
        : ''
    }
    ${atk.length ? `<div class="sec"><h3 class="sec-title">ATT&amp;CK</h3><div class="taglist">${atk.map((t) => `<span class="tag medium">${esc(t)}</span>`).join('')}</div></div>` : ''}
    <div class="sec"><h3 class="sec-title">关联工单</h3>${tickets}</div>
    ${refs ? `<div class="sec"><h3 class="sec-title">参考</h3><ul class="reflist">${refs}</ul></div>` : ''}
    ${d.rule?.file ? `<p class="note mono">规则文件：${esc(d.rule.file)}</p>` : ''}`;
}

$('alertModalClose').onclick = closeAlertModal;
$('alertModal').onclick = (e) => { if (e.target === $('alertModal')) closeAlertModal(); };

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
  refreshHitStats();
  $('ruleCount').textContent = `共 ${allRules.length} 条（ATT&CK 全映射 · 目标 3000+）`;
}

function renderRules() {
  const list = ruleDomain === 'all' ? allRules : allRules.filter((x) => x.domain === ruleDomain);
  $('rules').innerHTML = list.map((x) => `<tr class="rule-row" data-ruleid="${esc(x.id)}" style="cursor:pointer" title="点击查看完整定义">
    <td class="mono">${esc(x.id)}</td><td>${esc(x.name)}</td>
    <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
    <td class="dim">${esc(x.category)}</td>
    <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
    <td class="mono">${esc((x.techniques || []).join(' '))}</td>
    <td><span class="tag ${x.source === 'custom' ? 'merged' : 'info'}">${esc(x.source || 'builtin')}</span>${x.status === 'disabled' ? ' <span class="tag critical">已禁用</span>' : ''}</td>
    <td>
      <button class="mini" data-ract="toggle" data-rid="${esc(x.id)}" data-st="${x.status === 'disabled' ? 'stable' : 'disabled'}">${x.status === 'disabled' ? '启用' : '禁用'}</button>
      ${x.source === 'custom' ? `<button class="mini" data-ract="edit" data-rid="${esc(x.id)}">编辑</button><button class="mini resolve" data-ract="del" data-rid="${esc(x.id)}">删除</button>` : ''}
    </td></tr>`).join('');
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
          <td>${p.runs}</td>
          <td><span class="tag ${p.source === 'custom' ? 'merged' : 'info'}">${esc(p.source)}</span>${p.status === 'disabled' ? ' <span class="tag critical">禁用</span>' : ''}</td>
          <td>
            <button class="mini" data-pact="toggle" data-pid="${esc(p.id)}" data-st="${p.status === 'disabled' ? 'stable' : 'disabled'}">${p.status === 'disabled' ? '启用' : '禁用'}</button>
            ${p.source === 'custom' ? `<button class="mini" data-pact="edit" data-pid="${esc(p.id)}">编辑</button><button class="mini resolve" data-pact="del" data-pid="${esc(p.id)}">删除</button>` : ''}
          </td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">无剧本</td></tr>';
    document.querySelectorAll('[data-pact]').forEach((b) => {
      b.onclick = async () => {
        const pid = b.dataset.pid;
        try {
          if (b.dataset.pact === 'toggle') {
            await jget(`/api/v1/playbooks/${pid}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.st }) });
            toast(`剧本 ${pid} 已${b.dataset.st === 'disabled' ? '禁用' : '启用'}（热生效）`);
          } else if (b.dataset.pact === 'edit') {
            openPbEditor(b.dataset.pid);
          } else if (b.dataset.pact === 'del') {
            if (!confirm(`删除自定义剧本 ${pid}？`)) return;
            await jget(`/api/v1/playbooks/${pid}`, { method: 'DELETE' });
            toast(`剧本 ${pid} 已删除`);
          }
          refreshResponses();
        } catch (e) { toast('操作失败: ' + e.message, true); }
      };
    });
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
    const stTag = (st) => st === 'executed' ? 'low' : st === 'skipped' ? 'medium' : (st === 'failed' || st === 'timeout') ? 'critical' : st === 'sent' ? 'info' : 'low';
    $('rAudit').innerHTML = (r.audit || []).length
      ? r.audit.map((a) => `<tr><td class="dim mono">${hhmmss(a.ts)}</td><td class="mono">${esc(a.action)}</td><td class="mono">${esc(a.target)}</td><td><span class="tag ${stTag(a.status)}">${esc(a.status)}</span></td><td class="dim" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.detail || '')}">${esc(a.detail || (a.cmdId ? '等待回执…' : ''))}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">暂无响应动作</td></tr>';
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

/* ===== 事件检索（events 表：检索 / 聚合 / 流量包导入） =====
   后端三条端点：GET /events（列表+计数）、GET /events/stats（分布+时间桶）、
   POST /ingest/import（multipart 流量包）。三者的时间窗口必须一致，
   否则"总数 500 条但趋势图只有 3 根柱"这类不一致会把人带偏，故统一走 evtQs()。 */
const evtState = {
  hours: 24, domain: 'all', category: '', source: '', q: '', limit: 200, total: null,
  srcIp: '', dstIp: '', user: '', process: '', file: '', host: '', action: '', outcome: '',
};
const evtSources = new Set();
const evtNotes = { list: '', stats: '' };
let evtChart = null;

const pad2 = (n) => String(n).padStart(2, '0');

/** 事件时间展示：7 天窗口下只显示时分秒会丢掉日期，一律带 MM-DD */
function evtTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? '');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 端点展示：ip:port 优先，退到 asset_id / asset.id / host（不同适配器填的字段不一样） */
function evtEnd(o) {
  if (!o || typeof o !== 'object') return '';
  const ip = o.ip ?? o.asset_id ?? o['asset']?.id ?? o.host ?? '';
  const port = o.port ? `:${o.port}` : '';
  return ip ? `${ip}${port}` : '';
}

function evtQs(extra) {
  const p = new URLSearchParams();
  p.set('from', new Date(Date.now() - evtState.hours * 3600_000).toISOString());
  p.set('limit', String(evtState.limit));
  if (evtState.domain !== 'all') p.set('domain', evtState.domain);
  if (evtState.category) p.set('category', evtState.category);
  if (evtState.source) p.set('source', evtState.source);
  if (evtState.q) p.set('q', evtState.q);
  if (evtState.srcIp) p.set('src_ip', evtState.srcIp);
  if (evtState.dstIp) p.set('dst_ip', evtState.dstIp);
  if (evtState.user) p.set('user', evtState.user);
  if (evtState.process) p.set('process', evtState.process);
  if (evtState.file) p.set('file', evtState.file);
  if (evtState.host) p.set('host', evtState.host);
  if (evtState.action) p.set('action', evtState.action);
  if (evtState.outcome) p.set('outcome', evtState.outcome);
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, String(v));
  return p.toString();
}

function paintEvtNote() {
  $('evtNote').textContent = [evtNotes.list, evtNotes.stats].filter(Boolean).join(' · ');
}

async function refreshEvents() {
  if (currentView !== 'events') return;
  try {
    const r = await jget('/api/v1/events?' + evtQs({ count: 1 }));
    const rows = r.rows || [];
    evtState.total = typeof r.total === 'number' ? r.total : rows.length;
    const more = evtState.total > rows.length;
    $('evtCount').textContent = `共 ${fmtN(evtState.total)} 条${more ? ` · 显示前 ${rows.length} 条` : ''}`;
    for (const x of rows) if (x.source) evtSources.add(x.source);
    fillEvtSources();
    $('evtRows').innerHTML = rows.length
      ? rows.map(evtRowHtml).join('')
      : '<tr><td colspan="10" class="empty">该条件下没有事件 —— 换个时间范围，或先用「导入流量包」灌一批数据</td></tr>';
    evtNotes.list = `窗口 ${evtTime(r.window.from)} ~ ${evtTime(r.window.to)} · 查询 ${r.ms}ms${more ? ' · 缩小范围或加关键词看全部' : ''}`;
    paintEvtNote();
  } catch (e) {
    $('evtRows').innerHTML = `<tr><td colspan="10" class="empty">${esc(e.message)}</td></tr>`;
    evtNotes.list = '';
    paintEvtNote();
  }
}

function evtRowHtml(x) {
  const asset = x.src?.asset_id ?? x.src?.['asset']?.id ?? x.dst?.asset_id ?? x.dst?.['asset']?.id ?? '';
  const user = x.payload?.user?.name ?? x.src?.user?.name ?? '';
  const action = x.payload?.event?.action ?? '';
  const outcome = x.payload?.event?.outcome ?? '';
  const fv = (fk, v) => (v ? `<span class="fval" data-fk="${esc(fk)}" data-fv="${esc(v)}" title="点击：筛选 / 排除 / 可选值">${esc(v)}</span>` : '<span class="dim">—</span>');
  return `<tr class="evt-row" data-id="${esc(x.id)}" title="点击行查看完整 payload">
    <td class="mono">${esc(evtTime(x.ts))}</td>
    <td>${fv('domain', x.domain)}</td>
    <td class="dim">${fv('category', x.category)}</td>
    <td>${esc(x.name || '—')}${x.threat_id ? `<div class="dim mono">${esc(x.threat_id)}</div>` : ''}${action ? `<div class="dim">${esc(action)}${outcome ? ' · ' + esc(outcome) : ''}</div>` : ''}</td>
    <td class="mono">${fv('source', x.source)}</td>
    <td class="evt-io">${fv('src', evtEnd(x.src))}</td>
    <td class="evt-io">${fv('dst', evtEnd(x.dst))}</td>
    <td class="mono">${fv('user', user)}</td>
    <td class="mono">${fv('asset', asset)}</td>
    <td><button class="mini" data-detail="${esc(x.id)}">详情</button></td>
  </tr>`;
}

function fillEvtSources() {
  const list = [...evtSources].sort();
  const cur = evtState.source;
  $('evtSource').innerHTML =
    '<option value="">全部来源</option>' +
    list.map((s) => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

function fillEvtCategories(s) {
  const cur = evtState.category;
  const cats = [...new Set((s.byCategory || []).map((x) => x.category))].sort();
  $('evtCategory').innerHTML =
    '<option value="">全部类别</option>' +
    cats.map((c) => `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

/* ===== 字段点选菜单：点值 → 筛选 / 排除 / 复制 / 可选值分布 ===== */
const FVAL_FACETABLE = new Set(['domain', 'category', 'source', 'src', 'dst', 'user', 'asset', 'process', 'file', 'host', 'action', 'outcome']);

/** 值含空格时用引号包成单个 token（后端 parseQ 支持引号值）。 */
function tokVal(v) {
  return /\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

/** 替换 q 里同字段 token（换值/换极性），避免叠加同字段条件。 */
function setQToken(fk, fv, not) {
  const tok = `${not ? '-' : ''}${fk}:${tokVal(fv)}`;
  const re = new RegExp(`(^|\\s)-?${fk}:"[^"]*"|-?${fk}:\\S+`, 'g');
  const cur = $('evtQ').value.trim();
  const next = (cur.replace(re, '').trim() + ' ' + tok).trim();
  $('evtQ').value = next;
  evtState.q = next;
  refreshEvents();
  refreshEventStats();
}

/** 请求分面前先剥掉同字段 token/参数，否则可选值列表只剩当前选中值。 */
function facetQs(fk) {
  const re = new RegExp(`(^|\\s)-?${fk}:"[^"]*"|-?${fk}:\\S+`, 'g');
  const p = new URLSearchParams(evtQs({}));
  const q = (p.get('q') || '').replace(re, ' ').replace(/\s+/g, ' ').trim();
  if (q) p.set('q', q); else p.delete('q');
  const pair = { src: 'src_ip', dst: 'dst_ip', user: 'user', process: 'process', file: 'file', host: 'host', action: 'action', outcome: 'outcome', asset: 'asset_id' };
  if (pair[fk]) p.delete(pair[fk]);
  return p.toString();
}

let fmenuEl = null;
function fmenu() {
  if (!fmenuEl) {
    fmenuEl = document.createElement('div');
    fmenuEl.id = 'fmenu';
    document.body.appendChild(fmenuEl);
    document.addEventListener('click', (e) => {
      if (fmenuEl && !fmenuEl.contains(e.target) && !e.target.closest('.fval') && !e.target.closest('th[data-facet]') && !e.target.closest('.ft-row')) fmenuEl.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fmenuEl) fmenuEl.style.display = 'none'; });
  }
  return fmenuEl;
}

function showFMenu(px, py, headHtml, actionsHtml) {
  const m = fmenu();
  m.innerHTML = `<div class="fm-head">${headHtml}</div>${actionsHtml}`;
  m.style.display = 'block';
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(px, window.innerWidth - r.width - 10)}px`;
  m.style.top = `${Math.min(py, window.innerHeight - r.height - 10)}px`;
}

function openFvalMenu(x, y, fk, fv) {
  const acts = [];
  if (FVAL_FACETABLE.has(fk)) {
    acts.push(`<button class="fm-act" data-m="f">✚ 按 ${esc(fk)} = "${esc(fv)}" 筛选</button>`);
    acts.push(`<button class="fm-act" data-m="x">－ 排除 ${esc(fk)} = "${esc(fv)}"</button>`);
    acts.push(`<button class="fm-act" data-m="v">☰ 查看该字段可选值…</button>`);
  } else {
    acts.push(`<button class="fm-act" data-m="k">🔎 全文搜索 "${esc(fv)}"</button>`);
  }
  acts.push(`<button class="fm-act" data-m="c">⧉ 复制值</button>`);
  showFMenu(x, y, `字段 <b>${esc(fk)}</b> = "${esc(fv)}"`, acts.join(''));
  fmenu().onclick = (e) => {
    const act = e.target.closest('.fm-act')?.dataset.m;
    if (!act) return;
    fmenu().style.display = 'none';
    if (act === 'f') setQToken(fk, fv, false);
    else if (act === 'x') setQToken(fk, fv, true);
    else if (act === 'v') openFacetList(x, y, fk);
    else if (act === 'k') { $('evtQ').value = tokVal(fv); evtState.q = tokVal(fv); refreshEvents(); refreshEventStats(); }
    else if (act === 'c') navigator.clipboard?.writeText(fv).then(() => toast('已复制'));
  };
}

async function openFacetList(x, y, fk) {
  showFMenu(x, y, `字段 <b>${esc(fk)}</b> 可选值（当前过滤下 Top 8）`, '<div class="fm-facets"><div class="fm-facet">加载中…</div></div>');
  try {
    const r = await jget('/api/v1/events/facets?' + facetQs(fk) + `&field=${encodeURIComponent(fk)}&facet_limit=8`);
    const rows = (r.rows || []);
    const list = rows.length
      ? rows.map((row) => `<div class="fm-facet" data-v="${esc(row.value ?? '')}"><span class="v" title="${esc(row.value ?? '')}">${esc(row.value || '(空)')}</span><span class="n">${fmtN(row.n)}</span></div>`).join('')
      : '<div class="fm-facet">该窗口内无值</div>';
    showFMenu(x, y, `字段 <b>${esc(fk)}</b> 可选值（当前过滤下 Top 8）`, `<div class="fm-facets">${list}</div>`);
    fmenu().onclick = (e) => {
      const v = e.target.closest('.fm-facet')?.dataset.v;
      if (v === undefined) return;
      fmenu().style.display = 'none';
      if (v !== '') setQToken(fk, v, false);
    };
  } catch (err) {
    showFMenu(x, y, `字段 <b>${esc(fk)}</b> 可选值`, `<div class="fm-facet">${esc(err.message)}</div>`);
  }
}

// 结果表：字段值点击 → 菜单；行点击 → 详情（fval 冒泡拦截）
$('evtRows').addEventListener('click', (e) => {
  const fval = e.target.closest('.fval');
  if (fval && fval.dataset.fv) {
    e.stopPropagation();
    openFvalMenu(e.clientX, e.clientY, fval.dataset.fk, fval.dataset.fv);
    return;
  }
  const tr = e.target.closest('tr.evt-row');
  if (tr) openEventDetail(tr.dataset.id);
});

// 列头点击 → 该字段可选值分布（ Splunk 式钻取 ）
function bindFacetHeaders() {
  document.querySelectorAll('#view-events th[data-facet]').forEach((th) => {
    th.onclick = (e) => openFacetList(e.clientX, e.clientY, th.dataset.facet);
  });
}
bindFacetHeaders();

// 详情弹窗字段树：叶子点击 → 全文搜索 / 复制
$('evtModalBody').addEventListener('click', (e) => {
  const leaf = e.target.closest('.ft-row');
  if (!leaf) return;
  const k = leaf.querySelector('.ft-k')?.textContent || '';
  const v = leaf.querySelector('.ft-v')?.textContent || '';
  if (!v || v === 'null') return;
  showFMenu(e.clientX, e.clientY, `字段 <b>${esc(k)}</b> = "${esc(v.slice(0, 60))}"`, `
    <button class="fm-act" data-m="k">🔎 全文搜索该值</button>
    <button class="fm-act" data-m="c">⧉ 复制值</button>`);
  fmenu().onclick = (ev) => {
    const act = ev.target.closest('.fm-act')?.dataset.m;
    if (!act) return;
    fmenu().style.display = 'none';
    if (act === 'k') {
      $('evtQ').value = tokVal(v);
      evtState.q = tokVal(v);
      closeEvtModal();
      showView('events');
      refreshEvents();
      refreshEventStats();
    } else if (act === 'c') navigator.clipboard?.writeText(v).then(() => toast('已复制'));
  };
});

async function refreshEventStats() {
  if (currentView !== 'events') return;
  try {
    // 桶宽跟着窗口走：1h/24h 用 1 小时桶，7d 用 6 小时桶，30d 用 1 天桶，否则柱子全挤成一坨
    const interval = evtState.hours <= 24 ? '1 hour' : evtState.hours <= 168 ? '6 hour' : '1 day';
    const s = await jget('/api/v1/events/stats?' + evtQs({ interval }));
    fillEvtCategories(s);
    drawEventChart(s);
    const byDom = (s.byDomain || []).map((d) => `${d.domain} ${fmtN(d.n)}`).join(' / ');
    evtNotes.stats = `全窗口 ${fmtN(s.total)} 条${byDom ? ` · ${byDom}` : ''} · 桶宽 ${esc(s.interval)}`;
    paintEvtNote();
  } catch (e) {
    evtNotes.stats = `聚合失败：${e.message}`;
    paintEvtNote();
  }
}

function drawEventChart(s) {
  if (!window.echarts) return;
  const el = $('evtChart');
  // 视图隐藏时宽度为 0，此时 init 会得到一张 0px 的画布且不再自适应
  if (!el.clientWidth) return;
  if (!evtChart) evtChart = window.echarts.init(el);
  else evtChart.resize();
  const buckets = s.byBucket || [];
  evtChart.setOption(
    {
      grid: { left: 44, right: 16, top: 14, bottom: 30 },
      tooltip: { trigger: 'axis', backgroundColor: '#101c33', borderColor: 'rgba(122,150,205,.3)', textStyle: { color: '#dce5f7' } },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => evtTime(b.bucket).slice(6)),
        axisLabel: { color: '#7e8fb3', fontSize: 10, interval: Math.max(Math.ceil(buckets.length / 12) - 1, 0) },
        axisLine: { lineStyle: { color: '#1e2a44' } },
      },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#7e8fb3' }, splitLine: { lineStyle: { color: 'rgba(122,150,205,.12)' } } },
      series: [
        {
          type: 'bar',
          barWidth: buckets.length > 40 ? '70%' : '52%',
          itemStyle: { borderRadius: [3, 3, 0, 0], color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#4f8cff' }, { offset: 1, color: 'rgba(124,92,255,.35)' }] } },
          data: buckets.map((b) => b.n),
        },
      ],
    },
    true,
  );
}

/** 全字段树：任意深度 ECS payload 逐叶子展开（details/summary 纯 CSS，无内联脚本）。 */
function fieldTreeHtml(v, key, depth = 0) {
  const label = esc(key);
  if (v === null || typeof v !== 'object') {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return `<div class="ft-row"><span class="ft-k" title="${label}">${label}</span><span class="ft-v">${esc(val ?? 'null')}</span></div>`;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  const hint = Array.isArray(v) ? `数组 · ${entries.length} 项` : `${entries.length} 个字段`;
  const kids = entries.length
    ? entries.map(([k, x]) => fieldTreeHtml(x, k, depth + 1)).join('')
    : '<div class="ft-row"><span class="ft-v dim">（空）</span></div>';
  return `<details ${depth < 2 ? 'open' : ''}><summary>${label} <span class="dim">${hint}</span></summary><div class="ft-node">${kids}</div></details>`;
}

async function openEventDetail(id) {
  $('evtModal').classList.remove('hidden');
  $('evtModalId').textContent = '#' + id;
  $('evtModalMeta').textContent = '加载中…';
  $('evtModalBody').innerHTML = '';
  try {
    const e = await jget('/api/v1/events/' + encodeURIComponent(id));
    $('evtModalMeta').textContent = `${evtTime(e.ts)} · ${e.domain} · ${e.category}`;
    $('evtModalBody').innerHTML = `
      <dl class="kv">
        <dt>时间（UTC）</dt><dd class="mono">${esc(e.ts)}</dd>
        <dt>域 / 类别</dt><dd><span class="tag ${esc(e.domain)}">${esc(e.domain)}</span> ${esc(e.category)}</dd>
        <dt>名称</dt><dd>${esc(e.name || '—')}</dd>
        <dt>来源通道</dt><dd class="mono">${esc(e.source || '—')}</dd>
        <dt>源</dt><dd class="mono">${esc(evtEnd(e.src) || '—')}</dd>
        <dt>目的</dt><dd class="mono">${esc(evtEnd(e.dst) || '—')}</dd>
        <dt>威胁标识</dt><dd class="mono">${esc(e.threat_id || '—')}</dd>
      </dl>
      <div class="note" style="margin:10px 0 6px">全字段（归一化后的完整 ECS 结构，每个叶子都可被 事件检索 的关键词/字段:值 命中）</div>
      ${fieldTreeHtml(e.payload ?? {}, 'payload')}
      <details style="margin-top:8px">
        <summary class="note">原始 JSON（归一化前原文）</summary>
        <div class="jsonbox" style="margin-top:6px">${esc(JSON.stringify(e.payload ?? {}, null, 2))}</div>
      </details>`;
  } catch (err) {
    $('evtModalMeta').textContent = '';
    $('evtModalBody').innerHTML = `<p class="note" style="color:var(--crit)">${esc(err.message)}</p>`;
  }
}

function closeEvtModal() {
  $('evtModal').classList.add('hidden');
}

async function runImport(file) {
  const box = $('evtImportOut');
  box.classList.remove('hidden');
  if (!file.size) {
    box.innerHTML = `<div class="import-box err"><div class="hd"><b>${esc(file.name)}</b> <span style="color:var(--crit)">文件为空</span></div></div>`;
    return;
  }
  const feed = $('evtFeed').checked;
  const mode = ($('evtMode') && $('evtMode').value) || 'flow';
  const isPcap = /\.(pcap|pcapng|cap)$/i.test(file.name);
  box.innerHTML = `<div class="import-box"><div class="hd"><b>${esc(file.name)}</b>
    <span class="note">${(file.size / 1024 / 1024).toFixed(file.size > 1048576 ? 1 : 2)} MB</span>
    <span class="note">${isPcap ? `抓包解析中（${mode === 'packet' ? '逐包' : '按流聚合'}）…` : '上传解析中…'}</span></div></div>`;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('source', isPcap ? 'pcap' : 'ui-import');
  fd.append('feed', feed ? 'true' : 'false');
  const t0 = Date.now();
  try {
    const r = await fetch('/api/v1/ingest/import?mode=' + encodeURIComponent(mode), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') },
      body: fd,
    });
    if (r.status === 401) return handle401();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = Array.isArray(j.message) ? j.message.join('；') : j.message;
      throw new Error(msg || `导入失败（HTTP ${r.status}）`);
    }
    renderImportReport(j, file, Date.now() - t0);
    toast(`导入 ${j.file}：接收 ${j.accepted} / 拒绝 ${j.rejected} / 新增告警 ${j.alerts}`);
    // 历史抓包/补录常落在当前时间窗之外：导完"看不到"最容易被误判成导入失败
    const newest = j.pcap && j.pcap.lastMs ? j.pcap.lastMs : null;
    if (newest) {
      const ageDays = (Date.now() - newest) / 86400_000;
      if (newest < Date.now() - evtState.hours * 3600_000) {
        if (ageDays <= 30) {
          setEvtRange(720);
          toast(`数据最新一条在 ${Math.max(1, Math.round(ageDays))} 天前，已自动切到 30 天窗口`);
        } else {
          toast(`数据在 ${Math.round(ageDays)} 天前，超出控制台 30 天窗口；请用「安全查询」按 source 检索`, true);
        }
      }
    }
    await refreshEvents();
    await refreshEventStats();
  } catch (e) {
    box.innerHTML = `<div class="import-box err"><div class="hd"><b>${esc(file.name)}</b>
      <span style="color:var(--crit)">${esc(e.message)}</span></div></div>`;
    toast('导入失败: ' + e.message, true);
  }
}

function renderImportReport(j, file, wallMs) {
  const bad = (j.rejected || 0) > 0;
  const warn = j.warning ? `<div class="note" style="color:var(--high); margin-top:6px">⚠ ${esc(j.warning)}</div>` : '';
  const span = j.pcap.firstMs ? `${evtTime(j.pcap.firstMs)} ~ ${evtTime(j.pcap.lastMs)}` : '时间未知';
  const pcap = j.pcap
    ? `<div class="note" style="margin-top:6px">抓包：${fmtN(j.pcap.packets)} 包 → ${fmtN(j.pcap.flows)} 条 flow
        · 截断 ${fmtN(j.pcap.truncated)} / 分片 ${fmtN(j.pcap.fragments)} / 不支持链路 ${fmtN(j.pcap.unsupportedLink)}
        · ${esc(span)}
        ${j.pcap.overflowFlows ? ` · 流表溢出丢弃 ${fmtN(j.pcap.overflowFlows)}` : ''}</div>`
    : '';
  const errs = (j.errors || []).length
    ? `<ul class="errs">${j.errors.map((e) => `<li>第 <code>${esc(e.line)}</code> 行：${esc(e.reason)}</li>`).join('')}</ul>`
    : '';
  $('evtImportOut').innerHTML = `<div class="import-box${bad ? ' err' : ''}">
    <div class="hd">
      <b>${esc(j.file || file.name)}</b>
      <span class="tag low">接收 ${fmtN(j.accepted)}</span>
      <span class="tag ${bad ? 'high' : 'low'}">拒绝 ${fmtN(j.rejected)}</span>
      <span class="tag ${j.alerts ? 'medium' : 'low'}">告警 ${fmtN(j.alerts)}</span>
      <span class="note">格式 ${esc(j.format)}${j.adapter ? ' · 适配器 ' + esc(j.adapter) : ''} · 来源 ${esc(j.source)}</span>
      <span class="note">${j.stored ? '已落库' : '仅研判'} / ${j.fed ? '已研判' : '不研判'} · ${fmtN(j.ms ?? wallMs)}ms</span>
    </div>${pcap}${warn}${errs}</div>`;
}

$('evtQuery').onclick = () => {
  evtState.q = $('evtQ').value.trim();
  evtState.srcIp = $('evtSrcIp').value.trim();
  evtState.dstIp = $('evtDstIp').value.trim();
  readAdvFilters();
  refreshEvents();
  refreshEventStats();
};
$('evtQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('evtQuery').click(); });
$('evtSrcIp').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('evtQuery').click(); });
$('evtDstIp').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('evtQuery').click(); });
$('evtMore').onclick = () => {
  const adv = $('evtAdv');
  adv.classList.toggle('hidden');
  $('evtMore').textContent = adv.classList.contains('hidden') ? '更多 ▾' : '收起 ▴';
};

function readAdvFilters() {
  evtState.user = $('evtFUser').value.trim();
  evtState.process = $('evtFProcess').value.trim();
  evtState.file = $('evtFFile').value.trim();
  evtState.host = $('evtFHost').value.trim();
  evtState.action = $('evtFAction').value.trim();
  evtState.outcome = $('evtFOutcome').value.trim();
}
for (const id of ['evtFUser', 'evtFProcess', 'evtFFile', 'evtFHost', 'evtFAction', 'evtFOutcome']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('evtQuery').click(); });
}

document.querySelectorAll('#evtRange .chip').forEach((c) => {
  c.onclick = () => setEvtRange(Number(c.dataset.range) || 24);
});

function setEvtRange(hours) {
  evtState.hours = hours;
  document.querySelectorAll('#evtRange .chip').forEach((x) => {
    x.classList.toggle('active', Number(x.dataset.range) === hours);
  });
  refreshEvents();
  refreshEventStats();
}
document.querySelectorAll('#evtDomain .chip').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('#evtDomain .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    evtState.domain = c.dataset.domain;
    refreshEvents();
    refreshEventStats();
  };
});

$('evtCategory').onchange = (e) => { evtState.category = e.target.value; refreshEvents(); refreshEventStats(); };
$('evtSource').onchange = (e) => { evtState.source = e.target.value; refreshEvents(); };
$('evtImport').onclick = () => $('evtFile').click();
$('evtFile').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) runImport(f);
};
$('evtModalClose').onclick = closeEvtModal;
$('evtModal').onclick = (e) => { if (e.target === $('evtModal')) closeEvtModal(); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeEvtModal();
  closeAlertModal();
});

/* ===== 安全查询（SIME QL） =====
   POST /query 是平台唯一查询面；控制台只做三件事：给数据源与字段（catalog）、
   把编译结果摊开（sql/params/notes 可排错）、把错误原样显示（kind + pos）。
   不要在 UI 里重写一遍语法校验——两份实现迟早漂移。 */
let qlCatalog = null;
let qlLastQuery = '';

/** 带业务错误的 POST：把 Nest 返回的 {message, kind, pos} 原样抬成 Error 字段 */
async function jcall(url, body, method = 'POST') {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) return handle401();
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
  if (!r.ok) {
    const raw = j && j.message ? j.message : `HTTP ${r.status}`;
    const err = new Error(Array.isArray(raw) ? raw.join('；') : String(raw));
    err.kind = j && j.kind;
    err.pos = j && j.pos;
    err.status = r.status;
    throw err;
  }
  return j;
}

function qlMsg(type, tag, text) {
  const box = $('qlMsg');
  box.classList.remove('hidden');
  box.className = 'ql-msg ' + (type === 'ok' ? 'ql-ok' : 'ql-err');
  box.innerHTML = `<span class="kind">${esc(tag)}</span>${esc(text)}`;
}

function qlClearMsg() {
  $('qlMsg').classList.add('hidden');
  $('qlMsg').innerHTML = '';
}

async function initQuery() {
  if (!qlCatalog) {
    try {
      qlCatalog = await jget('/api/v1/query/sources');
    } catch (e) {
      qlMsg('err', 'catalog', '数据源目录获取失败：' + e.message);
      return;
    }
    renderQlCatalog();
  }
  if (!$('qlText').value.trim()) {
    $('qlText').value = (qlCatalog.examples && qlCatalog.examples[0]) || '';
    qlSyncSourceSelect();
  }
  renderQlFields();
  $('qlText').focus();
}

function renderQlCatalog() {
  const sources = qlCatalog.sources || [];
  const lim = qlCatalog.limits || {};
  $('qlNote').textContent = `${qlCatalog.language} ${qlCatalog.version} · ${sources.length} 个数据源`;
  $('qlHint').textContent = `默认 limit ${lim.defaultLimit ?? '-'} · 上限 ${lim.maxLimit ?? '-'} · 超时 ${Math.round((lim.timeoutMs ?? 0) / 1000)}s`;
  $('qlSource').innerHTML =
    '<option value="">数据源…</option>' +
    sources.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.large ? '（大表）' : ''}</option>`).join('');
  $('qlExamples').innerHTML = (qlCatalog.examples || [])
    .map((ex, i) => `<button class="chip" data-example="${i}" title="${esc(ex)}">${esc(ex.length > 74 ? ex.slice(0, 74) + '…' : ex)}</button>`)
    .join('');
  document.querySelectorAll('#qlExamples [data-example]').forEach((b) => {
    b.onclick = () => {
      $('qlText').value = qlCatalog.examples[Number(b.dataset.example)] || '';
      qlSyncSourceSelect();
      renderQlFields();
      $('qlText').focus();
    };
  });
}

/** 文本首 token 与某个数据源同名 → 同步下拉，让字段提示跟着走 */
function qlSyncSourceSelect() {
  const m = /^\s*([a-z_][a-z0-9_]*)/i.exec($('qlText').value || '');
  const name = m ? m[1].toLowerCase() : '';
  const hit = (qlCatalog?.sources || []).find((s) => s.name === name || (s.aliases || []).includes(name));
  $('qlSource').value = hit ? hit.name : '';
}

function renderQlFields() {
  const name = $('qlSource').value;
  const src = (qlCatalog?.sources || []).find((s) => s.name === name);
  if (!src) { $('qlFields').innerHTML = ''; return; }
  const fields = src.fields || [];
  $('qlFields').innerHTML =
    `<span class="note" style="margin-right:4px">${esc(src.label || src.name)}${src.note ? ' · ' + esc(src.note) : ''}</span>` +
    fields.map((f) => `<span class="fld" data-field="${esc(f)}">${esc(f)}</span>`).join('');
  document.querySelectorAll('#qlFields [data-field]').forEach((el) => {
    el.onclick = () => insertAtCursor($('qlText'), el.dataset.field);
  });
}

function insertAtCursor(el, text) {
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? s;
  el.value = el.value.slice(0, s) + text + el.value.slice(e);
  el.selectionStart = el.selectionEnd = s + text.length;
  el.focus();
}

async function runQuery() {
  const q = $('qlText').value.trim();
  if (!q) { qlMsg('err', 'empty', '先写一条查询语句（可点下方示例）'); return; }
  qlClearMsg();
  $('qlRun').disabled = true;
  $('qlNote').textContent = '查询中…';
  const t0 = Date.now();
  try {
    const r = await jcall('/api/v1/query', { q });
    qlLastQuery = q;
    renderQlResult(r, Date.now() - t0);
    $('qlNote').textContent = `${qlCatalog?.language || 'SIME QL'} · 上次 ${r.rowCount} 行 / ${r.totalMs}ms`;
  } catch (e) {
    $('qlNote').textContent = '查询失败';
    const pos = e.pos !== undefined && e.pos !== null ? `（位置 ${e.pos}）` : '';
    qlMsg('err', e.kind || `HTTP ${e.status || '?'}`, e.message + pos);
    $('qlOut').innerHTML = '';
  }
  $('qlRun').disabled = false;
}

function renderQlResult(r, wallMs) {
  const cols = r.columns || [];
  const all = r.rows || [];
  const cap = 500;
  const rows = all.slice(0, cap);
  const cell = (v) => {
    if (v === null || v === undefined) return '<span class="dim">—</span>';
    if (typeof v === 'object') {
      const s = JSON.stringify(v);
      return `<span title="${esc(s)}">${esc(s.length > 120 ? s.slice(0, 120) + '…' : s)}</span>`;
    }
    return esc(v);
  };
  const meta = `<div class="ql-meta">
      <span>数据源 <b>${esc(r.source)}</b></span>
      <span>返回 <b>${fmtN(r.rowCount)}</b> 行${all.length > cap ? `（仅渲染前 ${cap} 行，导出拿全量）` : ''}</span>
      <span>limit ${fmtN(r.limit)}</span>
      <span>DB ${fmtN(r.dbMs)}ms · 端到端 ${fmtN(wallMs)}ms</span>
    </div>`;
  const notes = (r.notes || []).length ? `<div class="note" style="margin-bottom:10px">${r.notes.map((n) => esc(n)).join('；')}</div>` : '';
  const table = cols.length
    ? `<div class="ql-table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.length
          ? rows.map((row) => `<tr>${cols.map((c) => `<td class="mono">${cell(row[c])}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${cols.length}" class="empty">0 行 —— 条件可能太严，或该时间窗内确实没有数据</td></tr>`}</tbody></table></div>`
    : '<p class="dim">查询没有输出列</p>';
  const details = `<details class="ql-details"><summary>编译产物（参数化 SQL，可复制到 psql 复现）</summary>
      <pre>${esc(r.sql)}</pre>
      <pre>params = ${esc(JSON.stringify(r.params ?? []))}</pre></details>`;
  $('qlOut').innerHTML = meta + notes + table + details;
}

async function qlValidate() {
  const q = $('qlText').value.trim();
  if (!q) { qlMsg('err', 'empty', '先写一条查询语句'); return; }
  try {
    const r = await jcall('/api/v1/query/validate', { q });
    const cols = (r.columns || []).join(', ') || '—';
    qlMsg('ok', 'validate', `语法通过 · 输出列：${cols}${(r.notes || []).length ? ' · ' + r.notes.join('；') : ''}`);
    $('qlOut').innerHTML = `<details class="ql-details" open><summary>编译产物（未执行）</summary>
        <pre>${esc(r.sql)}</pre><pre>params = ${esc(JSON.stringify(r.params ?? []))}</pre></details>`;
    $('qlNote').textContent = '校验通过（未执行）';
  } catch (e) {
    const pos = e.pos !== undefined && e.pos !== null ? `（位置 ${e.pos}）` : '';
    qlMsg('err', e.kind || 'syntax', e.message + pos);
    $('qlNote').textContent = '校验失败';
  }
}

/** 导出走 /export（流式，不经过前端内存）；未写 limit 时按服务端 maxRows 上限导 */
async function qlExport(fmt) {
  const q = $('qlText').value.trim();
  if (!q) { qlMsg('err', 'empty', '先写一条查询语句'); return; }
  const btn = fmt === 'csv' ? $('qlExportCsv') : $('qlExportJsonl');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/v1/export?q=${encodeURIComponent(q)}&format=${fmt}`, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') },
    });
    if (r.status === 401) return handle401();
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error((j && (Array.isArray(j.message) ? j.message.join('；') : j.message)) || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const cd = r.headers.get('content-disposition') || '';
    const hit = /filename="([^"]+)"/.exec(cd);
    const name = hit ? hit[1] : `sime-export.${fmt}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`已导出 ${name}（${(blob.size / 1024).toFixed(1)} KB）`);
    qlMsg('ok', 'export', `已下载 ${name} · ${(blob.size / 1024).toFixed(1)} KB（CSV 带 UTF-8 BOM，Excel 直接双击不乱码）`);
  } catch (e) {
    qlMsg('err', 'export', e.message);
  }
  btn.disabled = false;
}

$('qlRun').onclick = runQuery;
$('qlValidate').onclick = qlValidate;
$('qlExportCsv').onclick = () => qlExport('csv');
$('qlExportJsonl').onclick = () => qlExport('jsonl');
$('qlSource').onchange = () => {
  const name = $('qlSource').value;
  const v = $('qlText').value.trim();
  if (name) {
    if (!v) $('qlText').value = `${name} | limit 100`;
    else if (/^[a-z_][a-z0-9_]*/i.test(v)) $('qlText').value = v.replace(/^[a-z_][a-z0-9_]*/i, name);
  }
  renderQlFields();
  $('qlText').focus();
};
$('qlText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); return; }
  if (e.key === 'Tab') { e.preventDefault(); insertAtCursor($('qlText'), '  '); }
});
$('qlText').addEventListener('input', qlSyncSourceSelect);

/* ===== 启动 ===== */
/* 有 token 也要先验一次：过期 token 直接进登录页，不再先渲染控制台
   再等 2-3s 后的轮询 401（用户会先看到一个"假在线"的控制台）。 */
(async () => {
  if (!localStorage.getItem('sime_token')) { showLogin(true); return; }
  try {
    const r = await fetch('/api/v1/alerts?limit=1', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('sime_token') || '') } });
    if (r.status === 401) return handle401();
  } catch { /* 网络异常不拦启动，交由轮询按现有逻辑提示 */ }
  startConsole();
})();

let consoleStarted = false;
function startConsole() {
  if (consoleStarted) return; // 反复登录不叠加轮询定时器
  consoleStarted = true;
  refreshRules().then(() => { if (currentView === 'rules') renderRules();
    document.querySelectorAll('.rule-row').forEach((r) => {
      r.onclick = () => openRuleDetail(r.dataset.ruleid);
    }); });
  refreshCatalog();
  refreshHealth();
  refreshAlerts();
  refreshTelemetry();
  setInterval(refreshHealth, 3000);
  setInterval(refreshAlerts, 3000);
  setInterval(refreshTelemetry, 2000);
  setInterval(refreshTopology, 2000);
  setInterval(refreshEvents, 6000);
  setInterval(refreshEventStats, 20000);
  setInterval(refreshTrend, 30000);
}

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

/* ===== 日志解析工作台（自动识别） ===== */
const PARSE_SAMPLE = 'time=2025-04-27 10:23:01 src_ip=203.0.113.7 src_port=52110 dst_ip=10.2.85.118 dst_port=8080 rule_id=1000002 threat=SQL注入攻击 level=高危 action=阻断\n2025/04/27 10:23:02 src_ip=198.51.100.23 src_port=55110 dst_ip=10.2.85.119 dst_port=443 rule_id=3000001 attack_type=SQL注入攻击 risk=高 action=阻断\nApr 27 10:23:03 web-prd-02 sshd[18342]: Failed password for invalid user oracle from 203.0.113.99 port 41022 ssh2';

$('parseSample').onclick = () => { $('parseInput').value = PARSE_SAMPLE; };
$('parseBtn').onclick = async () => {
  const raw = $('parseInput').value.trim();
  const box = $('parseResult');
  if (!raw) { box.innerHTML = '<p class="note" style="color:var(--crit);padding:8px 4px">请先粘贴日志</p>'; return; }
  box.innerHTML = '<p class="dim" style="padding:8px 4px">识别中…</p>';
  try {
    const r = await jget('/api/v1/adapters/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!r.matches.length) {
      box.innerHTML = '<p class="note" style="padding:8px 4px">30 个适配器均未命中——该格式尚未支持。可将日志与格式说明提交到 adapters/ 目录贡献新适配器。</p>';
      return;
    }
    box.innerHTML = `<p class="note" style="margin:0 0 8px">命中 ${r.matched} / ${r.total} 个适配器（按字段命中数排序，最优匹配高亮）</p>` +
      r.matches.map((m, i) => `<div class="parse-hit${i === 0 ? ' best' : ''}">
        <div class="ph-head">
          <span class="ph-name">${esc(m.vendor)} · ${esc(m.product)}</span>
          <span class="tag it">${esc(m.protocol)}</span>
          <span class="dim mono" style="font-size:11px">${esc(m.id)}</span>
          <span class="dim" style="margin-left:auto">${m.fieldCount} 字段</span>
        </div>
        <div class="parse-fields">${Object.entries(m.mapped).map(([k, v]) => `<div><b>${esc(k)}</b> = ${esc(String(v).slice(0, 60))}</div>`).join('')}</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="note" style="color:var(--crit);padding:8px 4px">${esc(e.message)}</p>`;
  }
};

/* ===== Agent 家族台账（多类型 Agent 接入） ===== */
const AGENT_TYPE_LABEL = { host: '主机防护', edge: '边缘 OT 网关', log: '日志转发', net: '网络探针', cloud: '云原生采集', scan: '合规扫描', external: '第三方设备', sim: '模拟器', legacy: '未标注' };

async function refreshAgents() {
  if (currentView !== 'agents') return;
  try {
    const r = await jget('/api/v1/agents');
    const types = Object.entries(r.byType || {});
    $('agentCards').innerHTML = types.length
      ? types.map(([t, s]) => `<div class="card"><div class="v">${s.online}<span class="dim" style="font-size:14px"> / ${s.total}</span></div><div class="k">${esc(AGENT_TYPE_LABEL[t] ?? t)}</div></div>`).join('')
      : '<div class="card"><div class="v">0</div><div class="k">尚无 Agent 接入</div></div>';
    $('agentRows').innerHTML = (r.agents || []).length
      ? r.agents.map((a) => `<tr>
          <td class="mono">${esc(a.deviceId)}<div class="dim mono">${esc(a.assetId)}</div></td>
          <td><span class="tag ${a.type === 'host' ? 'ot' : a.type === 'edge' ? 'it' : 'info'}">${esc(AGENT_TYPE_LABEL[a.type] ?? a.type)}</span></td>
          <td class="mono">${esc(a.version)}</td>
          <td class="dim mono">${esc((a.capabilities || []).join(' ')) || '-'}</td>
          <td><span class="tag ${a.online ? 'low' : 'high'}">${a.online ? '在线' : '离线'}</span></td>
          <td class="dim">${rel(a.lastSeen)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">暂无 Agent —— 遥测携带 agent 元数据即自动注册（见 docs/agent-family.md）</td></tr>';
  } catch (e) {
    $('agentRows').innerHTML = `<tr><td colspan="6" class="empty">加载失败: ${esc(e.message)}</td></tr>`;
  }
}

/* ===== 规则详情弹窗（复用告警弹窗容器，无告警字段时展示规则六要素） ===== */
async function openRuleDetail(ruleId) {
  try {
    const d = await jget('/api/v1/rules/' + encodeURIComponent(ruleId));
    const det = d.detection || {};
    const cond = [
      det.source ? 'source:     ' + det.source : '',
      det.window ? 'window:     ' + det.window : '',
      Array.isArray(det.group_by) && det.group_by.length ? 'group_by:   ' + det.group_by.join(', ') : '',
      det.condition ? 'condition:  ' + det.condition : '',
      det.threshold ? 'threshold:  ' + JSON.stringify(det.threshold) : '',
      det.except ? 'except:     ' + det.except : '',
    ].filter(Boolean).join('\n');
    const body = `
      <dl class="kv">
        <dt>规则</dt><dd>${esc(d.name)} <span class="dim mono">(${esc(d.id)} v${esc(d.version)})</span></dd>
        <dt>域 / 类别</dt><dd><span class="tag ${esc(d.domain)}">${esc(d.domain)}</span> ${esc(d.category)}</dd>
        <dt>级别</dt><dd><span class="tag ${esc(d.severity)}">${esc(d.severity)}</span> · 状态 ${esc(d.status)}</dd>
      </dl>
      <div class="sec"><h3 class="sec-title">检测逻辑</h3><div class="jsonbox">${esc(cond || '—')}</div></div>
      ${d.triage ? `<div class="sec"><h3 class="sec-title">研判指引</h3><p>${esc(d.triage)}</p></div>` : ''}
      ${(d.response && d.response.default || []).length ? `<div class="sec"><h3 class="sec-title">响应动作</h3><div class="taglist">${d.response.default.map((a) => `<span class="tag info mono">${esc(a)}</span>`).join('')}</div></div>` : ''}
      ${((d.tactics || []).concat(d.techniques || [])).length ? `<div class="sec"><h3 class="sec-title">ATT&amp;CK</h3><div class="taglist">${(d.tactics || []).concat(d.techniques || []).map((t) => `<span class="tag medium">${esc(t)}</span>`).join('')}</div></div>` : ''}
      ${(d.references || []).length ? `<div class="sec"><h3 class="sec-title">参考</h3><ul class="reflist">${d.references.map((r) => { const u = /^https?:/.test(r) ? r : ''; return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(r)}</a>` : esc(r)}</li>`; }).join('')}</ul></div>` : ''}
      ${d.file ? `<p class="note mono">规则文件：${esc(d.file)}</p>` : ''}`;
    $('alertModalTitle').textContent = '规则详情';
    $('alertModalBody').innerHTML = body;
    ['alertAck', 'alertResolve', 'alertGoEvents'].forEach((i) => { const el = $(i); if (el) el.classList.add('hidden'); });
    $('alertModal').classList.add('open');
    // 关闭时恢复被隐藏的告警操作按钮（弹窗容器为告警/规则共用）
    const origClose = $('alertModalClose').onclick;
    $('alertModalClose').onclick = () => { origClose && origClose(); closeAlertModal(); ['alertAck', 'alertResolve', 'alertGoEvents'].forEach((i) => { const el = $(i); if (el) el.classList.remove('hidden'); }); };
  } catch (e) { toast('规则详情加载失败: ' + e.message, true); }
}

/* ===== 规则管理：启禁/删除/编辑/新建（全分片热生效 ≤15s） ===== */
const RULE_TEMPLATE = {
  id: "rule.custom.my-rule", name: "我的自定义规则", version: "1.0", status: "stable",
  author: "console", domain: "it", category: "host-security",
  tactics: ["TA0006 凭证访问"], techniques: ["T1110 密码猜解"],
  severity: "medium",
  detection: { source: "event.security.auth", window: "5m", group_by: ["src.ip"],
    condition: "event.category == 'authentication' and event.outcome == 'failure' and count() >= 10" },
  response: { default: ["ticket.create", "notify.sec_team"] },
  triage: "研判说明：写清楚值班人员第一眼需要知道什么（至少 20 字）。" ,
  references: ["https://attack.mitre.org/techniques/T1110/"]
};

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ract]');
  if (!btn) return;
  e.stopPropagation();
  const rid = btn.dataset.rid;
  const act = btn.dataset.ract;
  if (act === 'toggle') {
    await jget(`/api/v1/rules/${rid}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: btn.dataset.st }) });
    toast(`规则 ${rid} 已${btn.dataset.st === 'disabled' ? '禁用' : '启用'}（全分片热生效）`);
    refreshRules();
  } else if (act === 'del') {
    if (!confirm(`确认删除自定义规则 ${rid}？`)) return;
    await jget(`/api/v1/rules/${rid}`, { method: 'DELETE' });
    toast(`规则 ${rid} 已删除`); refreshRules();
  } else if (act === 'edit') {
    openRuleEditor(rid);
  }
});
$('ruleNew').onclick = () => openRuleEditor(null);

async function openRuleEditor(rid) {
  const cur = rid ? await jget('/api/v1/rules/' + encodeURIComponent(rid)) : null;
  const d = cur ?? JSON.parse(JSON.stringify(RULE_TEMPLATE));
  $('alertModalTitle').textContent = rid ? '编辑规则' : '新建规则';
  $('alertModalBody').innerHTML = '';
  ['alertAck', 'alertResolve', 'alertGoEvents'].forEach((i) => { const el = $(i); if (el) el.classList.add('hidden'); });
  $('alertModal').classList.add('open');

  const F = (label, id, val, ph, ta) =>
    `<div style="margin-bottom:8px"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">${label}</label>${ta
      ? `<textarea id="${id}" class="sqlbox" style="min-height:${ta}px">${esc(val)}</textarea>`
      : `<input id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" style="width:100%;background:#0d1526;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font-size:13px">`}</div>`;
  const det = d.detection || {};
  const SEL = (label, id, val, opts) =>
    `<div style="margin-bottom:8px"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">${label}</label><select id="${id}" style="width:100%;background:#0d1526;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;

  const form = document.createElement('div');
  form.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div>${F('规则 ID（rule.custom.xxx）', 'rf_id', d.id)}${F('名称', 'rf_name', d.name)}${SEL('级别', 'rf_sev', d.severity, ['info', 'low', 'medium', 'high', 'critical'])}${SEL('域', 'rf_domain', d.domain, ['it', 'ot', 'merged'])}${SEL('类别', 'rf_cat', d.category, ['host-security', 'windows-security', 'network-security', 'web', 'vpn', 'email', 'identity', 'ot', 'ueba', 'compliance', 'container', 'edge-security'])}</div>
      <div>${F('ATT&CK 战术（逗号分隔）', 'rf_tac', (d.tactics || []).join(', '), 'TA0006 凭证访问')}${F('ATT&CK 技术（逗号分隔）', 'rf_tec', (d.techniques || []).join(', '), 'T1110 密码猜解')}${F('数据源', 'rf_src', det.source || '', 'event.security.auth')}${F('窗口', 'rf_win', det.window || '5m', '如 1m / 5m / 1h')}${F('分组字段（逗号分隔）', 'rf_gb', (det.group_by || []).join(', '), 'src.ip')}</div>
    </div>
    ${F('检测条件（DSL）', 'rf_cond', det.condition || '', "event.category == 'authentication' and count() >= 10", 70)}
    ${F('研判说明（值班第一眼要看的）', 'rf_triage', d.triage || '', '怎么判断、怎么处置', 80)}
    ${F('响应动作（每行一个）', 'rf_resp', ((d.response || {}).default || []).join('\n'), 'ticket.create\nnotify.sec_team', 60)}`;
  $('alertModalBody').appendChild(form);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = rid ? '保存（热生效）' : '创建（热生效）';
  const jsonBtn = document.createElement('button');
  jsonBtn.className = 'btn ghost'; jsonBtn.textContent = 'JSON 模式';
  bar.appendChild(save); bar.appendChild(dryBtn); bar.appendChild(jsonBtn);
  $('alertModalBody').appendChild(bar);

  const collectDef = () => ({
    id: $('rf_id').value.trim(), name: $('rf_name').value.trim(), version: String(d.version || '1.0'), status: 'stable',
    author: 'console', domain: $('rf_domain').value, category: $('rf_cat').value, severity: $('rf_sev').value,
    tactics: $('rf_tac').value.split(',').map((x) => x.trim()).filter(Boolean),
    techniques: $('rf_tec').value.split(',').map((x) => x.trim()).filter(Boolean),
    detection: {
      source: $('rf_src').value.trim(), window: $('rf_win').value.trim() || '5m',
      group_by: $('rf_gb').value.split(',').map((x) => x.trim()).filter(Boolean),
      condition: $('rf_cond').value.trim(),
    },
    response: { default: $('rf_resp').value.split('\n').map((x) => x.trim()).filter(Boolean) },
    triage: $('rf_triage').value,
    references: d.references || [],
  });

  const dryBtn = document.createElement('button');
  dryBtn.className = 'btn ghost'; dryBtn.textContent = '▶ 试跑（回放近24h）';
  dryBtn.onclick = async () => {
    const def = collectDef();
    if (!def.detection.condition) { toast('请先填写检测条件', true); return; }
    dryBtn.disabled = true; dryBtn.textContent = '回放中…';
    let out = document.getElementById('rf_dryout');
    if (!out) { out = document.createElement('div'); out.id = 'rf_dryout'; out.style.cssText = 'margin-top:10px;padding:10px 12px;background:#0d1526;border:1px solid var(--line);border-radius:8px;font-size:12.5px'; $('alertModalBody').appendChild(out); }
    try {
      const r = await jget('/api/v1/rules/dryrun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule: def, hours: 24 }) });
      const color = r.alertsWouldFire === 0 ? 'var(--med)' : r.alertsWouldFire > 200 ? 'var(--crit)' : 'var(--ok)';
      out.innerHTML = `<b style="color:${color}">试跑结果：${r.alertsWouldFire} 条告警</b> <span class="dim">/ 近 ${r.hours}h 的 ${fmtN(r.eventsScanned)} 条真实事件</span>` +
        (r.samples || []).map((x) => `<div class="dim mono" style="margin-top:4px">· ${x.ts.slice(11, 19)} [${x.severity}] ${esc(x.groupKey)} — ${esc(String(x.summary).slice(0, 60))}</div>`).join('') +
        `<div class="dim" style="margin-top:6px">${esc(r.note)}</div>`;
    } catch (e) { out.innerHTML = `<span style="color:var(--crit)">试跑失败: ${esc(e.message)}</span>`; }
    dryBtn.disabled = false; dryBtn.textContent = '▶ 试跑（回放近24h）';
  };

  save.onclick = async () => {
    const def = collectDef();
    if (!def.id || !def.name || !def.detection.condition || def.triage.length < 20) {
      toast('id/名称/条件必填，研判说明至少 20 字', true); return;
    }
    try {
      await (rid
        ? jget(`/api/v1/rules/${rid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) })
        : jget('/api/v1/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) }));
      toast('已保存并热生效（全分片 ≤15s）');
      closeAlertModal(); refreshRules();
    } catch (e) { toast('保存失败: ' + e.message, true); }
  };
  jsonBtn.onclick = () => jsonRuleEditor(rid, cur);
}

/** JSON 高级模式（原编辑器）。 */
function jsonRuleEditor(rid, cur) {
  const ta = document.createElement('textarea');
  ta.value = JSON.stringify(cur ?? RULE_TEMPLATE, null, 2); ta.className = 'sqlbox'; ta.style.minHeight = '380px';
  $('alertModalBody').innerHTML = ''; $('alertModalBody').appendChild(ta);
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = '保存（热生效）'; save.style.marginTop = '10px';
  save.onclick = async () => {
    try {
      const def = JSON.parse(ta.value);
      await (rid
        ? jget(`/api/v1/rules/${rid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) })
        : jget('/api/v1/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) }));
      toast('已保存并热生效'); closeAlertModal(); refreshRules();
    } catch (e) { toast('保存失败: ' + e.message, true); }
  };
  $('alertModalBody').appendChild(save);
}

/* ===== 剧本编辑器（新建/编辑，Schema 服务端校验，热生效） ===== */
const PB_TEMPLATE = {
  id: "pb.custom.my-playbook", name: "我的自定义剧本", version: "1.0", status: "stable",
  trigger: { rules: ["rule.host.ssh-bruteforce"] },
  steps: ["ticket.create", "notify.sec_team"]
};
$('pbNew').onclick = () => openPbEditor(null);

const PB_ACTIONS = ['ticket.create', 'notify.sec_team', 'notify.ot_duty', 'notify.owner', 'notify.net_admin', 'account.lock', 'account.unlock', 'firewall.block', 'firewall.unblock', 'process.kill', 'file.quarantine', 'isolate.host', 'isolate.remove'];

async function openPbEditor(pid) {
  const [list, rules] = await Promise.all([jget('/api/v1/playbooks'), refreshRules().then(() => allRules)]);
  const cur = pid ? list.playbooks.find((p) => p.id === pid) : null;
  const d = cur ? { id: cur.id, name: cur.name, version: cur.version, status: cur.status, rules: cur.rules, steps: cur.steps } : { ...PB_TEMPLATE };
  $('alertModalTitle').textContent = pid ? '编辑剧本' : '新建剧本';
  $('alertModalBody').innerHTML = '';
  ['alertAck', 'alertResolve', 'alertGoEvents'].forEach((i) => { const el = $(i); if (el) el.classList.add('hidden'); });
  $('alertModal').classList.add('open');

  const IN = (label, id, val, ph) => `<div style="margin-bottom:8px"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">${label}</label><input id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" style="width:100%;background:#0d1526;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font-size:13px"></div>`;
  const form = document.createElement('div');
  form.innerHTML = `
    ${IN('剧本 ID（pb.custom.xxx）', 'pf_id', d.id)}
    ${IN('名称', 'pf_name', d.name)}
    <div style="margin-bottom:8px"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">触发规则（多选，勾选即绑定）</label>
      <div id="pf_rules" style="max-height:180px;overflow-y:auto;background:#0d1526;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12.5px">
        ${rules.map((r) => `<label style="display:flex;gap:8px;align-items:center;padding:2px 0;cursor:pointer"><input type="checkbox" value="${esc(r.id)}" ${(d.rules || []).includes(r.id) ? 'checked' : ''} style="accent-color:#4f8cff"><span class="mono">${esc(r.id)}</span><span class="dim"> — ${esc(r.name)}</span></label>`).join('')}
      </div></div>
    <div style="margin-bottom:8px"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">执行动作（按顺序，勾选追加）</label>
      <div id="pf_steps" style="display:flex;flex-wrap:wrap;gap:6px">
        ${PB_ACTIONS.map((a) => `<label style="display:flex;gap:5px;align-items:center;background:#0d1526;border:1px solid var(--line);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer"><input type="checkbox" value="${a}" ${(d.steps || []).includes(a) ? 'checked' : ''} style="accent-color:#4f8cff"><span class="mono">${a}</span></label>`).join('')}
      </div></div>
    <div style="margin:8px 0"><label style="display:block;font-size:12px;color:var(--dim);margin-bottom:3px">自定义动作（逗号分隔，如 plc.deny(dst.asset_id)）</label><input id="pf_extra" value="${esc((d.steps || []).filter((x) => !PB_ACTIONS.includes(x)).join(', '))}" placeholder="留空则无" style="width:100%;background:#0d1526;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font-size:13px"></div>`;
  $('alertModalBody').appendChild(form);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = pid ? '保存（热生效）' : '创建（热生效）';
  bar.appendChild(save);
  $('alertModalBody').appendChild(bar);

  save.onclick = async () => {
    const selRules = [...document.querySelectorAll('#pf_rules input:checked')].map((x) => x.value);
    const selSteps = [...document.querySelectorAll('#pf_steps input:checked')].map((x) => x.value);
    const extra = $('pf_extra').value.split(',').map((x) => x.trim()).filter(Boolean);
    const def = { id: $('pf_id').value.trim(), name: $('pf_name').value.trim(), version: String(d.version || '1.0'), status: 'stable',
      trigger: { rules: selRules }, steps: [...selSteps, ...extra] };
    if (!def.id || !def.name || !selRules.length || !def.steps.length) { toast('id/名称必填，至少选一个触发规则和动作', true); return; }
    try {
      await (pid
        ? jget(`/api/v1/playbooks/${pid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) })
        : jget('/api/v1/playbooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) }));
      toast('剧本已保存并热生效'); closeAlertModal(); refreshResponses();
    } catch (e) { toast('保存失败: ' + e.message, true); }
  };
}

/* ===== 规则命中排行（噪声识别） ===== */
async function refreshHitStats() {
  if (currentView !== 'rules') return;
  try {
    const r = await jget('/api/v1/rules/hitstats');
    const rows = r.rows || [];
    const max = Math.max(1, ...rows.map((x) => x.h24));
    $('hitRows').innerHTML = rows.length
      ? rows.map((x) => `<tr>
          <td>${esc(x.name)}<div class="dim mono">${esc(x.ruleId)}</div></td>
          <td><b style="color:${x.h24 > 100 ? 'var(--crit)' : x.h24 > 20 ? 'var(--high)' : 'var(--ok)'}">${fmtN(x.h24)}</b></td>
          <td class="dim">${fmtN(x.total)}</td>
          <td style="min-width:120px"><div style="height:6px;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent2));width:${Math.max(3, Math.round((x.h24 / max) * 100))}%"></div></td>
          <td><button class="mini" data-hrid="${esc(x.ruleId)}" data-st="disabled">禁用</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">暂无告警数据</td></tr>';
    document.querySelectorAll('[data-hrid]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`禁用 ${b.dataset.hrid}？（高噪声规则建议先调阈值再禁用）`)) return;
        await jget(`/api/v1/rules/${b.dataset.hrid}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.st }) });
        toast('已禁用（热生效）'); refreshHitStats(); refreshRules();
      };
    });
  } catch (e) { /* 静默 */ }
}
