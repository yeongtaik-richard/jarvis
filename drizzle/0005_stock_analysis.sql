-- Phase 5: AI briefings / opinions over stock snapshots (aggregator P1)
-- Idempotent: safe to re-run.

create table if not exists stock_analysis (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  symbol             text not null,
  kind               text not null default 'ondemand',
  claim_type         text not null default 'state_summary',
  title              text,
  body               text not null,
  input_snapshot_ids uuid[] not null default '{}'::uuid[],
  prompt_version     text,
  authored_by        text not null default 'claude-session'
);

create index if not exists ix_stock_analysis_symbol_created
  on stock_analysis (symbol, created_at desc);
