-- SIME Agent 家族：设备表扩展 Agent 元数据（多类型接入台账）
-- agent_type: host/edge/log/net/cloud/scan/external/sim（见 docs/agent-family.md）
alter table devices add column if not exists agent_type text;
alter table devices add column if not exists agent_version text;
alter table devices add column if not exists capabilities jsonb not null default '[]';
create index if not exists devices_agent_type_idx on devices (agent_type);
