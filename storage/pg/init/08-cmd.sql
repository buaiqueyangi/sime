-- SIME P2: cmd 响应执行通道 —— 审计表增加命令关联与回执
alter table response_audit add column if not exists cmd_id text;
alter table response_audit add column if not exists reply jsonb;
create index if not exists response_audit_cmd_idx on response_audit (cmd_id);
