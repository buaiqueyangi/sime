-- SIME: 规则热管理（增删改查 + 启用禁用）
-- builtin = 仓库 YAML 同步（可禁用不可删除）；custom = 控制台/API 创建（全 CRUD）
alter table rules add column if not exists source text not null default 'custom';
alter table rules add column if not exists updated_at timestamptz not null default now();
-- 版本号：任何写操作 bump，各分片轮询检测变化后热重载引擎
insert into config (key, value) values ('rules.version', '"1"')
on conflict (key) do nothing;
