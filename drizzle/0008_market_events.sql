-- Phase 8: market_events — 공시(DART)·뉴스 헤드라인.
--
-- stock_snapshots는 (metric, bucket_key) 단일 값 모델이라 여러 건이 흐르는 이벤트를
-- 담을 수 없어서 테이블을 따로 둔다. 멱등성은 (source, external_id) —
-- 공시는 rcept_no, 뉴스는 링크. 같은 걸 다시 수집해도 갱신만 된다.
--
-- 주의: DART 공시는 접수 '날짜'만 오므로 published_at의 시각은 09:00 KST 근사다
-- (src/lib/market-sources.ts). 장중 시각 대조는 뉴스(pubDate)로 한다.
-- Idempotent: safe to re-run.

create table if not exists market_events (
  id           uuid primary key default gen_random_uuid(),
  symbol       text not null,
  source       text not null,                  -- dart | news
  external_id  text not null,                  -- rcept_no | 뉴스 링크
  published_at timestamptz not null,
  title        text not null,
  url          text,
  publisher    text,
  category     text,
  collector_run_id uuid,
  collected_at timestamptz not null default now(),
  raw          jsonb not null default '{}'::jsonb
);

create unique index if not exists ux_market_events_natural
  on market_events (source, external_id);

create index if not exists ix_market_events_symbol_published
  on market_events (symbol, published_at desc)
