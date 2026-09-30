-- SIME M2: 通知投递状态（真实渠道发送 / 模拟 / 失败）
alter table notifications add column if not exists status text not null default 'simulated';
