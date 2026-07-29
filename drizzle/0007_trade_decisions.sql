-- Phase 7: trade decision log — 결정 → 결과 → 교훈 루프.
--
-- 여기 들어가는 buy/sell은 **사람이 실제로 한 결정의 기록**이지 AI 추천이 아니다.
-- stock_analysis에 매수/매도 컬럼을 두지 않는 정직성 규칙은 그대로다 (docs/stock.md §정직성).
-- Idempotent: safe to re-run.

create table if not exists trade_decisions (
  id                 uuid primary key default gen_random_uuid(),
  symbol             text not null,
  decided_at         timestamptz not null default now(),
  action             text not null,                  -- buy | sell | hold | watch | skip
  price              integer,                        -- 체결/기준가 (원)
  quantity           integer,
  rationale          text not null,                  -- 결정 시점의 근거 (사후 미화 방지)
  input_snapshot_ids uuid[] not null default '{}'::uuid[],
  analysis_id        uuid references stock_analysis (id),
  status             text not null default 'open',   -- open | closed
  outcome_at         timestamptz,
  outcome            text,                           -- 실제로 어떻게 됐나
  lesson             text,                           -- 다음에 뭘 다르게 할까
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists ix_trade_decisions_symbol_decided
  on trade_decisions (symbol, decided_at desc);

create index if not exists ix_trade_decisions_status
  on trade_decisions (status, decided_at desc)
