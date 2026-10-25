-- Agent 资产清单：每设备最新快照（覆盖式 CMDB 语义；进程/软件明细随快照整体刷新）
create table if not exists agent_inventory (
  device_id text primary key,
  asset_id text,
  data jsonb not null,
  collected_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists agent_inventory_asset_idx on agent_inventory (asset_id);
