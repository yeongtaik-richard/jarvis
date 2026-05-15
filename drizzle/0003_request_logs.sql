-- Phase 3: API request access log
-- Idempotent: safe to re-run.

create table if not exists request_logs (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  method       text not null,
  path         text not null,
  status       smallint not null,
  duration_ms  integer not null,
  error        text,
  user_agent   text,
  ip           text
);

create index if not exists ix_request_logs_ts     on request_logs(ts desc);
create index if not exists ix_request_logs_status on request_logs(status, ts desc);
create index if not exists ix_request_logs_path   on request_logs(path, ts desc);
