-- SIME M2: SOAR 剧本执行记录
create table if not exists playbook_runs (
    id           bigserial primary key,
    playbook_id  text        not null,
    alert_id     bigint,
    rule_id      text        not null,
    actions      text[]      not null default '{}',
    ts           timestamptz not null default now()
);
create index if not exists playbook_runs_pb_idx on playbook_runs (playbook_id, ts desc);
