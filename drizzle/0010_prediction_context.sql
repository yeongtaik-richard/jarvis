-- 예측에 "그때 규칙이 어떤 상태였는지"를 붙인다.
--
-- 왜 필요한가: 지금까지는 규칙이 **통과시킨 날만** 예측으로 기록했다. 그러면 규칙이
-- 막은 날에 실제로 무슨 일이 있었는지 실전 데이터가 영원히 안 생기고, 자기 필터로
-- 자기 성적을 평가하는 순환이 된다. 게이트·임계값을 올리려면 막힌 날의 결과가 필요하다.
--
-- 그래서 방향이 잡히는 모든 거래일을 기록하되, 통과분과 차단분을 이 컬럼으로 구분한다.
-- score/gated/volatility를 함께 남기므로 나중에 "|score|가 얼마부터, 어떤 변동성에서
-- 기저율을 넘는가"를 실전 표본으로 되물을 수 있다.
--
-- 판정 시점의 값을 **박제**하는 게 핵심이다. 임계값을 나중에 바꾸면 재현 계산은
-- 새 규칙으로 과거를 다시 칠하지만, 이 컬럼은 그때 실제로 무엇을 주장했는지 남긴다.
alter table stock_predictions add column if not exists context jsonb;

-- 통과분만 골라내는 조회가 잦다 (대시보드의 실전 적중률).
create index if not exists ix_stock_predictions_passed
  on stock_predictions ((context ->> 'passed'), kind, status);
