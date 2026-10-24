-- SIME: 剧本热管理（同规则模式：builtin 文件可禁用 / custom 全 CRUD + 全分片热生效）
create table if not exists playbooks (
    id         text primary key,
    name       text not null,
    version    text not null default '1.0',
    status     text not null default 'stable',
    trigger    jsonb not null,          -- {rules: [...]}
    steps      jsonb not null,          -- ["ticket.create", ...]
    source     text not null default 'custom',
    updated_at timestamptz not null default now()
);
insert into config (key, value) values ('playbooks.version', '"1"') on conflict (key) do nothing;
