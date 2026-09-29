-- SIME M2: 通用 KV 配置（组态布局等运行时可编辑资产）
create table if not exists config (
    key        text primary key,
    value      jsonb       not null,
    updated_at timestamptz not null default now()
);
