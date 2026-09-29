-- SIME M1: 遥测存储 / 告警处置闭环（工单/通知/响应审计）
-- 遥测走"明细 + 最新值"双表；规模上来后平移时序库（蓝图 §6.1 存储梯度）。
create table if not exists telemetry (
    asset_id    text        not null,
    point       text        not null,
    ts          timestamptz not null,
    value       double precision not null
);
create index if not exists telemetry_q on telemetry (asset_id, point, ts desc);

create table if not exists point_latest (
    asset_id    text        not null,
    point       text        not null,
    ts          timestamptz not null,
    value       double precision not null,
    primary key (asset_id, point)
);

-- 告警处置闭环（SOAR 地基）：规则 response.default 里的动作在此落地
create table if not exists notifications (
    id          bigserial primary key,
    alert_id    bigint,
    channel     text        not null,          -- notify.sec_team → sec_team
    payload     jsonb       not null default '{}',
    ts          timestamptz not null default now()
);

create table if not exists response_audit (
    id          bigserial primary key,
    alert_id    bigint,
    action      text        not null,          -- firewall.block / isolate.host / plc.deny ...
    target      text,
    status      text        not null default 'simulated',  -- 真实联动接入后升级为 executed
    ts          timestamptz not null default now()
);
