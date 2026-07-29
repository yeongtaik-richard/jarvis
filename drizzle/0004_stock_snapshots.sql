-- Phase 4: stock reference-info snapshots (aggregator P0a)
-- Idempotent: safe to re-run.

create table if not exists stock_snapshots (
  id               uuid primary key default gen_random_uuid(),
  symbol           text not null,
  source           text not null,
  metric           text not null,
  bucket_key       text not null,
  schema_version   smallint not null default 1,
  trading_date_kst text,
  as_of_at         timestamptz,
  captured_at      timestamptz not null default now(),
  collector_run_id uuid,
  payload_hash     text,
  payload          jsonb not null default '{}'::jsonb
);

create unique index if not exists ux_stock_snapshot_natural
  on stock_snapshots (symbol, source, metric, bucket_key);

create index if not exists ix_stock_snapshot_symbol_metric
  on stock_snapshots (symbol, metric, captured_at desc);
