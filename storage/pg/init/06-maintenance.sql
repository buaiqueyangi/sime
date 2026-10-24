-- SIME M2: 维护任务运行记录（保留策略清理 / 导出）
-- 目的：清理是破坏性动作，必须可追溯"谁在什么时候删了多少行"。
create table if not exists maintenance_runs (
    id          bigserial primary key,
    job         text        not null,                 -- retention / export
    target      text,                                 -- 表名 或 数据源
    scanned     bigint      not null default 0,       -- 命中（待删/已导出）行数
    affected    bigint      not null default 0,       -- 实际删除/写出行数
    dry_run     boolean     not null default false,
    ms          integer     not null default 0,
    status      text        not null default 'ok',    -- ok / partial / error / locked
    detail      text,
    ts          timestamptz not null default now()
);
create index if not exists maintenance_runs_ts_idx on maintenance_runs (ts desc);
create index if not exists maintenance_runs_job_idx on maintenance_runs (job, ts desc);
