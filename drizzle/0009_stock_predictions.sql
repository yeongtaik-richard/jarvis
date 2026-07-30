-- Phase 9: stock_predictions — 브리핑의 "지켜볼 것"을 기계가 채점 가능한 형태로 기록한다.
--
-- 한 행 = 반증 가능한 조건 하나: "metric.field가 target_bucket에서 comparator threshold".
-- 데이터가 도착하면 결정론적으로 confirmed/refuted가 갈리고, 영영 안 오면 expired.
-- 이 적중률 통계가 §정직성 규칙의 validated_directional을 해금하는 전제조건이다 —
-- 통계가 쌓이기 전까지 방향성 주장은 여전히 금지다.
-- Idempotent: safe to re-run.

create table if not exists stock_predictions (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null,
  created_at    timestamptz not null default now(),
  analysis_id   uuid references stock_analysis (id),   -- 이 예측을 낳은 브리핑
  authored_by   text not null default 'claude-routine',
  kind          text not null default 'watch',          -- watch | directional
  claim         text not null,                          -- 사람이 읽는 문장
  metric        text not null,                          -- 채점에 쓸 stock_snapshots.metric
  field         text not null,                          -- payload 내 숫자 필드
  comparator    text not null,                          -- gt | gte | lt | lte
  threshold     double precision not null,
  target_bucket text not null,                          -- 채점 대상 bucket_key
  status        text not null default 'pending',        -- pending | confirmed | refuted | expired | unverifiable
  actual_value  double precision,
  scored_at     timestamptz,
  score_note    text
);

create index if not exists ix_stock_predictions_symbol_created
  on stock_predictions (symbol, created_at desc);

create index if not exists ix_stock_predictions_status
  on stock_predictions (status, target_bucket)
