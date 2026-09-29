/* SIME 控制台 —— vanilla JS，无构建依赖；CSP 下全部外链资源 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function refreshHealth() {
  try {
    const h = await jget('/api/v1/health');
    const el = $('health');
    el.textContent = `运行中 · 规则 ${h.assets.rules} · 适配 ${h.assets.adapters} · 物模型 ${h.assets.thing-models} · 引擎告警 ${h.ruleEngine.alerts} · 存储 ${h.pgProfile === 'active' ? 'PostgreSQL' : '内存'}`;
    el.classList.remove('err');
    $('cards').innerHTML = [
      { k: '检测规则', v: h.assets.rules },
      { k: '日志源适配器', v: h.assets.adapters },
      { k: '物模型模板', v: h.assets['thing-models'] },
      { k: '累计告警', v: h.ruleEngine.alerts },
      { k: '告警存储', v: h.pgProfile === 'active' ? 'PG' : '内存' },
      { k: '规则引擎', v: 'v2 增量聚合' },
    ].map((c) => `<div class="card"><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div></div>`).join('');
  } catch (e) {
    $('health').textContent = '连接失败: ' + e.message;
    $('health').classList.add('err');
  }
}

async function refreshAlerts() {
  const a = await jget('/api/v1/alerts');
  const rows = a.items || [];
  $('alerts').innerHTML = rows.length
    ? rows.map((x) => `<tr>
        <td class="mono">${esc(x.ts.replace('T', ' ').slice(0, 19))}</td>
        <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
        <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
        <td class="mono">${esc(x.ruleId)}<div class="dim">${esc(x.ruleName)}</div></td>
        <td class="mono">${esc(x.groupKey)}</td>
        <td>${esc(x.summary)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">暂无告警 —— 点击「模拟攻击回放」看引擎实时检出</td></tr>';
}

async function refreshRules() {
  const list = await jget('/api/v1/rules');
  $('ruleCount').textContent = `共 ${list.length} 条（等保 2.0 + ATT&CK 全映射，目标 3000+）`;
  $('rules').innerHTML = list.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.name)}</td>
    <td><span class="tag ${esc(x.domain)}">${esc(x.domain)}</span></td>
    <td class="dim">${esc(x.category)}</td>
    <td><span class="tag ${esc(x.severity)}">${esc(x.severity)}</span></td>
    <td class="mono">${esc((x.techniques || []).join(' '))}</td></tr>`).join('');
}

async function refreshAdapters() {
  const list = await jget('/api/v1/adapters');
  $('adapters').innerHTML = list.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.vendor)} / ${esc(x.product)}</td>
    <td class="dim">${esc(x.protocol)}</td><td>${x.threatCount} 条</td></tr>`).join('');
}

async function refreshModels() {
  const list = await jget('/api/v1/thing-models');
  $('models').innerHTML = list.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td>${esc(x.label)}</td>
    <td>${x.propertyCount}</td><td>${x.eventCount}</td>
    <td class="dim">关键性 ${esc(x.security?.asset_criticality ?? '-')}</td></tr>`).join('');
}

async function simulate(reset) {
  const btn = $('simulate');
  btn.disabled = true;
  $('simNote').textContent = '回放中…';
  try {
    const r = await jget('/api/v1/health'); void r;
    const resp = await fetch('/api/v1/pipeline/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: !!reset }),
    });
    const j = await resp.json();
    $('simNote').textContent = `回放 ${j.events} 条事件 → 新增 ${j.newAlerts} 条告警（累计 ${j.stats.alerts}）`;
  } catch (e) {
    $('simNote').textContent = '失败: ' + e.message;
  }
  btn.disabled = false;
  await refreshAlerts();
  await refreshHealth();
}

$('simulate').onclick = () => simulate(false);
$('reset').onclick = () => simulate(true);

refreshHealth(); refreshAlerts(); refreshRules(); refreshAdapters(); refreshModels();
setInterval(refreshHealth, 3000);
setInterval(refreshAlerts, 3000);
