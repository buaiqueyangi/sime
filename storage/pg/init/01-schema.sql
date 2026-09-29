-- SIME M0 initial schema (PostgreSQL 16)
-- 设计依据：蓝图 §5.3 —— 告警/工单/资产不区分安全与设备，用 domain 字段区分。

create table if not exists assets (
    id            text primary key,
    name          text not null,
    type          text not null,
    domain        text not null default 'ot' check (domain in ('it','ot','merged')),
    thing_model   text,
    labels        jsonb not null default '{}',
    security      jsonb not null default '{}',
    created_at    timestamptz not null default now()
);

create table if not exists devices (
    id            text primary key,
    asset_id      text not null references assets(id),
    vendor        text,
    model         text,
    secret_hash   text,                     -- 一机一密（哈希存储）
    online        boolean not null default false,
    last_seen_at  timestamptz
);

create table if not exists measure_points (
    id            text primary key,
    device_id     text not null references devices(id),
    point_id      text not null,            -- 物模型 property id
    unit          text,
    store_policy  jsonb not null default '{}',
    unique (device_id, point_id)
);

-- 统一事件表：IT 安全事件与 OT 设备事件同库同结构（融合闭环的数据基座）
create table if not exists events (
    id            bigserial primary key,
    ts            timestamptz not null,
    domain        text not null check (domain in ('it','ot','merged')),
    category      text not null,
    name          text,
    source        text,                     -- 适配器 id / 采集通道
    src           jsonb,
    dst           jsonb,
    payload       jsonb not null default '{}',
    threat_id     text                      -- sime.tht.* 归一后
);
create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_domain_cat_idx on events (domain, category, ts desc);
create index if not exists events_payload_gin on events using gin (payload jsonb_path_ops);

create table if not exists rules (
    id            text primary key,
    name          text not null,
    version       text not null,
    domain        text not null,
    category      text not null,
    severity      text not null,
    tactics       text[] not null default '{}',
    techniques    text[] not null default '{}',
    definition    jsonb not null,           -- 原始 YAML 解析结果
    status        text not null default 'draft'
);

create table if not exists alerts (
    id            bigserial primary key,
    rule_id       text not null references rules(id),
    ts            timestamptz not null default now(),
    severity      text not null,
    domain        text not null check (domain in ('it','ot','merged')),
    state         text not null default 'open' check (state in ('open','ack','resolved','suppressed')),
    entity        jsonb not null default '{}',   -- 命中主体（src/dst/asset）
    summary       text
);
create index if not exists alerts_state_idx on alerts (state, ts desc);

create table if not exists tickets (
    id            bigserial primary key,
    alert_id      bigint references alerts(id),
    title         text not null,
    state         text not null default 'open' check (state in ('open','processing','closed')),
    assignee      text,
    created_at    timestamptz not null default now(),
    closed_at     timestamptz
);

create table if not exists users (
    id            text primary key,
    name          text not null,
    role          text not null,
    labels        jsonb not null default '{}'
);
