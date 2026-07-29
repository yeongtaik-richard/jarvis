-- Phase 6: collector run log — 수집기가 언제 돌았고 성공했는지 남긴다.
-- 지금까지는 수집이 조용히 실패해도 알 방법이 없었다 (cron 누락 포함).
-- Idempotent: safe to re-run.

create table if not exists collector_runs (
  id          uuid primary key,                 -- 스냅샷의 collector_run_id와 같은 값
  symbol      text not null,
  kind        text not null default 'close',    -- close | premarket | backfill | manual
  status      text not null default 'running',  -- running | ok | partial | error
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  posted      integer not null default 0,
  failed      integer not null default 0,
  error       text
);

create index if not exists ix_collector_runs_started
  on collector_runs (started_at desc);

create index if not exists ix_collector_runs_status
  on collector_runs (status, started_at desc)
