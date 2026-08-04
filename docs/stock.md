# Stock reference-info aggregator

SK하이닉스(`000660`) **매매 참고정보** 대시보드. 리처드님이 직접 매매할 때 볼 정보를
모아 보여주는 것이 목적 — **자동매매·수익예측 아님.**

> ⚠️ **정직성 규칙 (제품의 핵심 제약, 2026-07-31 개정).**
> **AI(브리핑·루틴·세션)는 여전히 "사라/팔라"를 하지 않는다.** `stock_analysis`에
> buy/sell/target/rating 컬럼은 없고, `validated_directional`은 API에서 **거부(400)** 된다.
>
> 방향성은 단 하나의 레인에서만 존재한다 — **결정론적 규칙 신호**(`src/lib/stock-signal.ts`,
> 리처드 결정으로 개설). 이 레인이 정직할 수 있는 세 가지 장치:
> ① 규칙·임계값이 코드에 전부 드러나 있고(AI 재량 없음),
> ② 화면·API 어디서든 **"미검증" 라벨 + directional 적중률(표본 수)** 없이는 표시되지 않으며,
> ③ 모든 buy/sell 신호는 발행 즉시 `stock_predictions(kind='directional', 5거래일 지평)`로
> 기록돼 **자동 채점**된다 — 신호의 성적표가 신호 옆에 쌓인다.
> `validated_directional` 해금(=AI가 방향성 주장 가능)은 이 표본이 유의미해진 뒤
> 리처드가 결정한다. 이 경계를 무너뜨리는 변경은 하지 말 것.

---

## 데이터 흐름

```
GitHub Actions cron (평일: 18:43 마감 / 08:10 프리마켓 / 09~15시 매시 장중)
  └─ scripts/collect-stock.ts
       └─ src/lib/kis-marketdata.ts  (KIS 읽기전용)
       └─ POST ${JARVIS_BASE_URL}/api/stock/collector-run  ← 실행 시작/종료 보고
       └─ src/lib/market-sources.ts  (OpenDART 공시 + 구글 뉴스 RSS)
       └─ POST ${JARVIS_BASE_URL}/api/stock/{snapshot,event}   ← Bearer
              └─ upsert → Neon (stock_snapshots, market_events)
                     └─ /stock 대시보드 (server component, 서비스 직접 조회)

Claude 클라우드 루틴 (평일 09:30~15:30 매시) · Claude 세션 (온디맨드)
  └─ 최신 snapshot 읽고 브리핑 작성 (+ 직전 브리핑 채점)
       └─ POST /api/stock/analysis  → Neon (stock_analysis)
              └─ /stock "최신 브리핑" 섹션
```

수집·스케줄링은 **Vercel 밖 GitHub Actions**에서 돈다 (Vercel Hobby cron은 하루 1회만
가능해서). jarvis는 저장·API·대시보드만 담당하는 passive store.

---

## 파일 지도

| 영역 | 파일 |
|---|---|
| DB 스키마 | `src/db/schema.ts` — `stockSnapshots`, `stockAnalysis`, `collectorRuns`, `marketEvents`, `tradeDecisions` |
| 마이그레이션 | `drizzle/0004_stock_snapshots.sql` ~ `0008_market_events.sql` |
| zod 입력/쿼리 | `src/lib/schemas.ts` — `CreateStockSnapshotInput` 외 |
| 서비스 | `src/lib/stock-service.ts`, `stock-analysis-service.ts`, `collector-run-service.ts`, `market-event-service.ts`, `trade-decision-service.ts` |
| 이벤트 소스 | `src/lib/market-sources.ts` — OpenDART 공시 + 구글 뉴스 RSS (읽기 전용) |
| 지표·국면 | `src/lib/stock-indicators.ts`(순수 계산·임계값), `stock-regime-service.ts`(DB 로드) |
| API | `src/app/api/stock/{snapshot,analysis,collector-run,health,event,decision}/route.ts` |
| 결정 로그 UI | `src/app/stock/decisions/` (page + server actions) |
| KIS 클라이언트 | `src/lib/kis-marketdata.ts` (읽기전용) |
| 수집기 | `scripts/collect-stock.ts` |
| cron | `.github/workflows/collect-stock.yml` |
| 대시보드 | `src/app/stock/page.tsx`, `TrendCharts.tsx`(추이 차트), `format.ts` |
| 차트 색 토큰 | `src/app/globals.css` — `.viz` (라이트/다크) |

---

## 데이터 모델

### `stock_snapshots` — 수집된 원천 지표
- 자연키 **`(symbol, source, metric, bucket_key)`** 에 unique index → **upsert 멱등**.
  같은 버킷 재수집은 덮어쓴다(수집기 재시도 안전).
- `bucket_key`: 일별 `YYYY-MM-DD`, 인트라데이는 ISO. `metric`별로 형식이 다름.
- `payload`: `jsonb`. **지표별 스키마는 payload 안에서만 다르다** → 새 지표 추가 시
  마이그레이션 불필요, 컬럼은 그대로.
- `captured_at`: insert/update **둘 다 DB `now()`** 사용 (Node 시계 아님 — upsert 시
  시각이 거꾸로 가지 않도록. `stock-service.ts`의 `sql\`now()\`` 참고).

현재 수집 중인 `metric` 4종 (`source: 'kis'`):

| metric | payload 필드 |
|---|---|
| `investor_flow` | `close`, `amount_unit: 'million_krw'`, `{foreign,institution,individual}_{net,buy,sell}` — 투자자별 순매수/매수/매도 **대금(백만원)** |
| `daily_ohlcv` | `open, high, low, close, volume` |
| `foreign_holding` | `price, foreign_ratio(%), foreign_qty` |
| `benchmark_{sox,nasdaq,kospi,electronics,samsung}` | `close, open, high, low, volume` (+`index_code`/`peer_code`) — 상대강도용 벤치마크 |
| `fx_{usdjpy,usdkrw}` | `fx_code, close, open, high, low` — 환율 (FHKST03030100 div `X`, FX@JPY/FX@KRW). **벤치마크 아님**, 매크로 지표 |
| `adr_price` | `ticker, exchange, currency: 'USD', close, open, high, low, volume` — SKHY(NAS). 벤치마크 아님 |
| `intraday_price` | 가격·거래: `price, change, change_rate, open, high, low, volume, amount_krw, amount_unit: 'krw'` · 수급의 질: `foreign_ratio, foreign_qty, foreign_net_qty, program_net_qty, short_qty, loan_balance_rate` · 플래그: `vi_code, warn_code, short_over_yn, caution_yn` |
| `valuation` | `per, pbr, eps, bps, market_cap(+`market_cap_unit: 'hundred_million_krw'`), listed_shares, turnover_rate, sector, w52_high/low(+date), d250_high/low` |

> ⚠️ **금액 단위가 지표마다 다르다.** `investor_flow`는 **백만원**,
> `intraday_price.amount_krw`는 **원**, `valuation.market_cap`은 **억원**이다.
> payload의 `*_unit` 필드를 보고 환산할 것. 화면 포맷터도 셋이 다르다 —
> `moneyMil`(백만원) / `moneyKrw`(원) / 시총은 카드에서 직접 환산.
> `korQty`는 억까지만 알아서 12조를 '124934.30억'으로 찍는다 (실제로 낸 버그).

`intraday_price`·`valuation`은 **KIS inquire-price 한 번 호출로 같이** 얻는다. 이 TR이
80개 필드를 주는데 예전엔 3개만 쓰고 버렸다 — 밸류에이션, 52주/250일 고저, 프로그램
순매수, 대차잔고율, 공매도 체결량, VI·시장경고가 전부 그 응답에 있다.

`intraday_price`만 `bucket_key`가 **KST 정시 ISO**(`2026-07-30T13:00+09:00`)다. cron이 늦게
떠도 "그 시각대 1건"으로 멱등하게 덮어쓰고, 실제 조회 시각은 `as_of_at`에 남는다.

> 수급 대금 단위는 **백만원**이다. 화면에서는 조/억으로 환산해 표시
> (`page.tsx`의 `moneyMil`). raw 숫자를 그대로 찍으면 1.24조를 1,242,524로
> 오표기하게 됨 — 실제로 있었던 버그.

### `stock_analysis` — AI 브리핑/의견
- `kind`: `pre | intraday | close | ondemand`
- `claim_type`: `state_summary | anomaly | scenario | risk | validated_directional`
  (마지막은 위 정직성 규칙에 따라 API에서 거부)
- `input_snapshot_ids`: 이 브리핑이 근거로 삼은 snapshot id 배열
- **buy/sell/target/rating 컬럼 없음** — 설계상 의도.

### `collector_runs` — 수집 실행 기록 (운영 모니터링)
- `id`는 수집기가 만든 `collector_run_id`와 **같은 값** → 그 실행이 남긴 스냅샷을
  조인 없이 추적할 수 있다.
- `kind`: `close | premarket | intraday | backfill | manual`, `status`: `running | ok | partial | error`
- 수집기가 시작·종료 두 번 보고한다(같은 id로 upsert). **보고가 실패해도 수집은 계속**한다
  — 모니터링 때문에 데이터를 잃는 건 본말전도.

### `market_events` — 공시·뉴스
- 스냅샷과 달리 한 시점에 여러 건이 흐르므로 별도 테이블. 멱등키 **`(source, external_id)`** —
  공시는 `rcept_no`, 뉴스는 **링크의 sha256**(구글 뉴스 링크가 수백 자라 인덱스에 부담).
- `title`은 갱신하되 **`published_at`은 갱신하지 않는다.** 최초 발행 시각이 이벤트의
  정체성이고, 시각이 흔들리면 급변 구간 대조가 깨진다.
- **공시는 시각이 없다.** DART `list.json`이 접수일자(날짜)만 줘서 `09:00 KST`로 근사해
  저장한다. **분 단위 대조는 뉴스만 유효**하다.
- 뉴스는 구글 뉴스 RSS(키 불필요, 48시간·40건 상한). 채용·일반 기사가 섞이므로 소비하는
  쪽에서 관련성을 판단한다. 제목 끝의 언론사 suffix는 제거한다 — 원문에 이미 붙어 있으면
  구글이 하나 더 붙여 `- 머니투데이 - 머니투데이`가 되므로 반복 제거한다.
- **호재·악재 라벨이나 인과 해석은 저장하지 않는다.** 사건의 존재와 시각까지가 사실이고,
  인과는 검증 대상이다. 대시보드 문구·openapi 설명에도 같은 선을 그어놨다.

### `stock_predictions` — 예측 기록 + 자동 채점
- 브리핑의 "지켜볼 것"을 **기계가 채점 가능한 조건**으로 기록한다:
  `metric.field가 target_bucket에서 comparator threshold`. 한 행 = 반증 가능한 주장 하나.
- **사후 예측 차단**: 등록 시점에 대상 버킷의 스냅샷이 이미 있으면 **409**. 이 검사가
  없으면 지나간 데이터를 맞히는 가짜 적중률이 쌓여 채점 전체가 무의미해진다.
- **조회가 곧 채점이다.** 별도 cron 없이, `GET /api/stock/prediction`이 pending 중
  데이터가 도착한 것을 정산한다(멱등). 스냅샷 있으면 confirmed/refuted, 필드가 없으면
  unverifiable, 대상 날짜 +3일 유예까지 데이터가 안 오면 expired(휴장일 등).
- `kind`: `watch`(관찰 항목)만 쓴다. `directional`은 스키마에 있지만 **적중률 통계가
  쌓이기 전까지 금지** — §정직성 규칙의 해금 전제조건이 바로 이 테이블의 통계다.
- `/api/stock/prediction/stats`: hit_rate는 반드시 scored(표본 수)와 함께 인용할 것.

### `trade_decisions` — 결정 → 결과 → 교훈
- **사람이 실제로 한 결정의 기록**이다. 여기 `action`(buy/sell/…)이 있다고 해서 위 정직성
  규칙이 풀린 게 아니다: AI는 무엇을 살지 제안하지 않고, 사용자가 이미 한 행동을 받아적을
  뿐이다. openapi 설명에도 "추측해서 넣지 말 것"을 박아뒀다.
- `rationale`(결정 시점 근거) → 나중에 `outcome`·`lesson`을 붙이면 `status`가 `closed`로
  넘어가고 `outcome_at`이 찍힌다. **사후 각색이 이 로그의 유일한 실패 모드**라 근거는
  결정 시점에 적는 걸 전제로 한다.
- `analysis_id`/`input_snapshot_ids`로 그때 본 브리핑·스냅샷을 매달 수 있다.

---

## API

- 모든 라우트: `runtime='nodejs'`, `dynamic='force-dynamic'`.
- 인증: **`checkBearer(req)`** — `Authorization: Bearer <JARVIS_API_TOKEN>`,
  timing-safe 비교. 일부 라우트는 `{ also: 'briefing' }`로 **브리핑 전용 토큰**도 받는다
  (스냅샷 GET, 브리핑 GET/POST, health GET, improvement POST — §자동 브리핑 루틴). `/api/`는 `middleware.ts`에서 **패스워드 미들웨어를 우회**하고
  Bearer만 검사한다 (페이지는 `JARVIS_WEB_PASSWORD` 세션 쿠키).
- 공통 배관: `withLog(...)` 래퍼 + zod `safeParse` + `ok()/jsonError()/fromZod()`
  (`@/lib/http`).

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/stock/snapshot` | 자연키로 upsert, 201 |
| GET | `/api/stock/snapshot?latest=true` | `(symbol,metric)`별 최신 1건. `symbol/metric/source/limit` 필터 |
| POST | `/api/stock/analysis` | 브리핑 생성, 201. `validated_directional`은 400 |
| GET | `/api/stock/analysis?limit=n` | 최신순. `symbol/kind` 필터 |
| POST | `/api/stock/collector-run` | 수집 실행 보고(upsert). **수집기 전용** |
| GET | `/api/stock/collector-run` | 실행 이력. `symbol/status` 필터 |
| GET | `/api/stock/health` | 수집 생존 요약 — `missed`, 마지막 성공, 지표별 최신 버킷 |
| GET | `/api/stock/regime` | 지표 + 규칙 기반 국면. 저장 안 하고 매번 계산 |
| POST/GET | `/api/stock/prediction` | 예측 등록(사후면 409) / 목록(조회=채점) |
| GET | `/api/stock/prediction/stats` | 적중률 요약 |
| GET/POST | `/api/stock/signal` | 규칙 신호 조회 / directional 예측으로 기록(수집기 전용, 멱등) |
| POST/GET | `/api/stock/event` | 공시·뉴스 upsert(배열 허용, **수집기 전용**) / 조회 |
| POST/GET | `/api/stock/decision` | 매매 결정 기록/목록 |
| GET/PATCH | `/api/stock/decision/{id}` | 단건 / 결과·교훈 붙이기 |

`public/openapi.yaml`(v1.7.0)에 문서화돼 있다. 예외는 **수집기 전용 쓰기 두 개** —
`POST /api/stock/collector-run`과 `POST /api/stock/event`는 모델이 만들 데이터가 아니라
스펙에서 뺐다(읽기 GET은 있다).

스펙 쪽 정직성 장치: `CreateStockAnalysisInput`의 `claim_type` enum에서
`validated_directional`을 **뺐고**, `POST /api/stock/snapshot`은 "수집기 전용, 대화 중
호출 금지", `POST /api/stock/decision`은 "사용자가 이미 한 행동만 기록, action을 추측하지
말 것"으로 설명해 모델이 데이터를 지어내지 못하게 막았다.

---

## KIS 클라이언트 & 수집기

`src/lib/kis-marketdata.ts` — **읽기전용.** 주문 코드는 **절대 넣지 말 것**
(PLAN-DASHBOARD §14). 쓰는 TR:

- `FHKST01010900` inquire-investor → 투자자별 매수/매도/순매수 대금·수량 (30일)
- `FHKST03010100` inquire-daily-itemchartprice → 일봉 OHLCV
- `FHKST01010100` inquire-price → 현재가 + 외국인 보유비율/수량
  (`foreignHolding()`은 보유 지표만, `currentQuote()`는 장중용으로 등락·거래량·거래대금까지)

`scripts/collect-stock.ts`:
- KIS에서 위 3종 fetch → 정규화 → jarvis API로 POST. `collector_run_id`(uuid)로
  한 번의 수집을 묶는다.
- **확정 전 값은 담지 않는다.** KST 16:00(정규장 15:30 + 종가단일가) 전에 돌면 그날
  `daily_ohlcv`/`investor_flow` 행을 **건너뛰고** 직전 확정일을 대신 올린다. KIS는 장중에
  진행 중인 부분 봉을 그날 일봉으로 돌려주는데, 그걸 담으면 (a) 대시보드가 부분 봉을
  종가로 보여주고 (b) 마감 수집이 실패한 날엔 그 값이 그날 일봉으로 굳는다.
  `foreign_holding`은 원래 "현재 시점" 지표라 이 규칙에서 제외 — 하루에 여러 번
  덮어쓰는 게 정상이다.
- **백필 모드** `--backfill[=N]` / `STOCK_BACKFILL_DAYS=N` (기본 30, 상한 120):
  최신 1일이 아니라 N일치를 전부 POST한다. upsert가 멱등이라 반복 실행 안전.
  **오래된 날짜부터** POST하므로 `captured_at` 순서가 거래일 순서와 어긋나지 않는다
  (대시보드의 "최신"은 `captured_at` 기준이라 이 순서가 중요하다).
  `foreign_holding`은 KIS inquire-price가 이력을 안 줘서 **백필해도 오늘 1건뿐**이다.
  실측: 30일 요청 → 거래일 22일 × 2지표 + 당일 보유비율 1건 = 45건.
- **import는 상대경로** (`../src/lib/kis-marketdata`) — tsx 단독 실행이 `@/` alias를
  해석하지 못함. `@/`로 바꾸지 말 것.
- **이벤트 수집**(공시·뉴스)은 백필을 뺀 모든 실행에 붙는다. 소스별로 따로 감싸서 하나가
  죽어도 다른 하나는 올라간다. `DART_API_KEY`가 없으면 공시만 건너뛰고 뉴스는 계속한다.
- env: `KIS_APP_KEY`, `KIS_APP_SECRET`, `JARVIS_API_TOKEN`, `JARVIS_BASE_URL`,
  `DART_API_KEY`, (선택) `STOCK_SYMBOL`, `DART_CORP_CODE`(기본 `00164779` = SK하이닉스,
  **종목코드와 다른 체계**이니 종목 바꿀 때 같이 바꿔야 한다), `NEWS_QUERY`.

> 🔐 **KIS app key는 그 자체로 주문 가능**하다. jarvis는 high-high의 live-trading
> 타입 게이팅을 상속하지 않으므로, KIS 키를 **Vercel env에 두지 말 것.**
> GitHub Secrets(CI) + 로컬 `~/git/high-high/.env`(개발)에만 둔다.

---

## GitHub Actions cron

`.github/workflows/collect-stock.yml` — 스케줄 2개:
- `'43 9 * * 1-5'` = **18:43 KST 평일** 마감 수집 (투자자 flow 확정 후, 정각 지연 회피용
  off-minute).
- `'10 23 * * 0-4'` = **08:10 KST 평일** 프리마켓. 새 지표를 얻는 게 아니라
  **안전망**이다: 마감 수집이 실패했으면 전날 데이터를 다시 채우고, 아침 시점의
  외국인 보유비율을 그날 버킷으로 하나 남긴다.
- `'0 0-6 * * 1-5'` = **09~15시 KST 매시 평일** 장중 수집. `intraday_price` 1건만 남기고
  일봉·수급은 건드리지 않는다(장중엔 확정이 아니므로). 장 시간 밖이면 아무것도 안 하고
  끝난다 — 지연 발화로 15:30 이후에 떠도 쓰레기 데이터가 안 생긴다.
- 어느 cron이 떴는지는 `github.event.schedule`로 구분해
  `STOCK_RUN_KIND`(close/premarket/intraday)로 넘긴다. 수동 실행이면 비어 있고,
  수집기가 알아서 `backfill`/`manual`로 붙인다.
- `workflow_dispatch`로 수동 트리거 가능.
- Node `.nvmrc`(20.20.2), pnpm 9.
- Repo Secrets: `KIS_APP_KEY`, `KIS_APP_SECRET`, `JARVIS_API_TOKEN`,
  `JARVIS_BASE_URL`, `DART_API_KEY`. (Environment secrets 아님 — **Repository secrets**)
- 수동 실행: `gh workflow run collect-stock.yml` → `gh run watch <id> --exit-status`.
- 백필도 CI에서 가능: `gh workflow run collect-stock.yml -f backfill_days=30`.
  스케줄 실행은 input이 없으므로 `STOCK_BACKFILL_DAYS`가 `0`(최신 1일)으로 떨어진다.

> ⏱ **스케줄은 돌지만 많이 늦는다.** 관측: 마감분 18:43 예정 → **20:48 KST 발화(2시간 5분
> 지연)**, 프리마켓분 08:10 예정 → **09:08 KST 발화(약 1시간 지연)**. GitHub cron은
> best-effort고 러너 혼잡에 따라 밀린다. 그래서
> (a) `missed` 유예를 3시간으로 잡았고, (b) 프리마켓 실행이 개장(09:00) 이후로 밀려도
> 부분 봉을 담지 않도록 위 §확정 전 값 규칙을 뒀다. **정시 실행을 전제로 하는 로직은 쓰지 말 것.**

---

## 지표·국면 (규칙 기반)

`src/lib/stock-indicators.ts`는 **DB를 모르는 순수 함수**다. `stock-regime-service.ts`가
저장된 일봉·수급을 읽어 넘기고, `/api/stock/regime`과 대시보드 "국면" 섹션이 그 결과를 쓴다.

**저장하지 않고 매번 계산한다.** 파생값이라 원천과 어긋나면 그게 버그이고, 규칙을 고치는
순간 저장분은 전부 낡은 값이 된다. 269거래일 계산은 밀리초라 캐싱할 이유도 없다.

계산 항목: MA5/20/60/120과 이격률, 250일 고점 대비 낙폭, 연속 상승·하락일,
20일 실현변동성과 **그 값의 이력 백분위**, 최근 5일 대비 60일 거래량 비율,
투자자별 20일 누적 순매수와 외국인 연속 방향.

분류 규칙(임계값은 파일 상단 상수):
- **추세** — 가격이 MA20에서 ±3% 밖이고 MA20·MA60 배열이 같은 방향일 때만 추세로 본다.
  둘이 어긋나면 `sideways`. 급반전 구간에서 방향을 단정하지 않기 위한 규칙이다.
- **변동성** — 절대 %가 아니라 **자기 이력 백분위**로 판정한다(≤25 calm / ≥75 elevated /
  ≥90 extreme). 절대값은 종목마다 기준이 달라 비교가 안 된다.
- **수급** — 외국인 20일 누적 부호 + 같은 방향 2거래일 이상 연속일 때만 방향을 붙이고,
  아니면 `mixed`. 2026-07-30 실측: 20일 누적은 순매도인데 당일 순매수로 전환 → `mixed`.

> ⚠️ **표본이 창보다 짧으면 `null`을 준다.** MA20을 5일로 계산해 놓고 MA20이라 부르면
> 그 뒤 모든 판단이 조용히 틀어진다. 소비하는 쪽은 null을 0으로 읽지 말 것.

> ⚠️ **이 라벨은 예측이 아니다.** "하락 추세"는 지금까지 내려왔다는 서술이다. 응답에
> `disclaimer`를 함께 실어 보내고, 화면·openapi 설명에도 같은 선을 그어놨다.
> 규칙이 코드에 드러나 있어야 나중에 적중률을 채점할 수 있다(Phase 5의 전제).

### 벤치마크와 오염 (⚠️ 상대강도 해석 규칙)

**하이닉스는 KOSPI·전기전자 지수의 큰 부분이라 그 지수 대비 초과수익은 순환 비교다.**
2026-07-30 실측(269거래일): 지수 수익률을 종목 수익률로 회귀하면 KOSPI 계수 0.51·R² 0.78,
전기·전자 0.72·R² 0.86 — KOSPI 일간 변동의 78%가 이 한 종목으로 설명된다. 그래서
"업종 대비 -7.1%p"는 실제 상대 약세를 크게 축소한 값이었다(같은 날 SOX 대비는 -26.6%p).

- **액면대로 읽어도 되는 벤치마크**: SOX(필라델피아 반도체 — 업황의 상위 동인이자
  미국 세션이 먼저 끝나 오버나이트 정보), 삼성전자(피어), 나스닥 종합.
- **오염된 벤치마크(KOSPI·업종)는 지우지 않는다** — 회귀계수 자체가 "지수가 종목에
  끌려간다"는 정보다. 대신 응답의 `contains_stock`·`index_on_stock_beta`·`index_on_stock_r2`와
  국면 reasons의 "축소 편향" 단서가 반드시 따라붙는다. 이 단서 없이 인용하지 말 것.
- 지수에서 종목 기여분을 빼는 정확한 보정은 **불가능**하다 — 지수 응답에 시총 필드가 없어
  가중치를 모른다. 회귀로 역산하지 않는다(다른 구성종목과의 공분산이 섞임).
- **크로스마켓 정렬은 as-of**: 미국 지수는 KRX와 달력이 달라(시차·휴장) 정확 일치 매칭이
  항상 실패한다. "그 날짜 이하 최근 세션"으로 맞추고, 5일 넘게 벌어지면 null.
- **환율(fx_*)도 벤치마크가 아니다** — 주식과 환율의 '초과수익' 비교는 무의미해서
  `relative`가 아닌 `indicators.fx`로 나간다. **USD/JPY 하락 = 엔 강세**고 엔캐리 청산
  압력은 그쪽에서 커진다(2026-08-03 미·일 공조 개입 국면에서 추가). 오독 방지용
  `reading` 문구("엔 강세" 등)가 함께 나가니 소비 측은 그걸 그대로 쓸 것.
- 매크로 뉴스는 `MACRO_NEWS_QUERY`(기본 '엔캐리 OR 엔화 개입 OR 원달러 환율')로 따로
  긁어 `category='macro'`로 저장한다. 종목명이 없는 거시 사건이 기존 쿼리에 안 잡히던
  구멍을 메운 것.
- **ADR(SKHY)은 벤치마크가 아니다** — 같은 회사라 초과수익이 정의상 무의미하다.
  오버나이트 괴리 관찰용이며, 이력 15거래일·BYMD 페이징 불가라는 한계가 있다.
  KRX 대비 프리미엄 계산은 ADR 비율·환율이 없어 하지 않는다.

---

## 규칙 신호 (Phase 6) — 주간 관점

`src/lib/stock-signal.ts`(순수) + `stock-signal-service.ts`(DB) + `/api/stock/signal`.

- **컴포넌트 3개, 각 ±1**: 추세(regime.trend) / 수급(regime.flow) / SOX 대비 20일
  초과수익(±5%p 초과 시). 오염 벤치마크(KOSPI·업종)는 신호에 넣지 않는다.
- **|합| ≥ 2 → buy/sell, 아니면 watch.** 변동성 극단(이력 90%ile↑)에서는 **만점(3)이
  아니면 watch로 강등** — 급등락 구간의 방향 신호는 신뢰도가 낮다.
  실사례: 2026-07-31(+24% 급반등, 96%ile) score -2 → gated → watch.
- **기록은 수집기가 한다.** 마감 수집 성공 후 `POST /api/stock/signal` — LLM 세션에
  맡기지 않는 이유는 신호 기록이 결정론적이어야 하고 루틴이 안 떠도 표본이 쌓여야 해서다.
  watch는 반증 불가라 기록하지 않고, 같은 대상 버킷에 pending이 있으면 중복 기록하지 않는다.
- 검증 조건: **5거래일(≈달력 7일, 주말 보정) 후 종가가 기준 종가보다 높은지/낮은지.**
  공휴일에 걸리면 채점기가 expired 처리한다(적중률 분모에서 제외).
- 대시보드 카드와 openapi 설명 모두 "미검증 + 표본 수" 없이 신호만 보여주는 경로가 없다.

### 두 지평 (2026-08-04) — 하루 · 일주일
같은 규칙, 같은 점수를 **두 시점에 채점**한다. 다른 건 "언제 확인하느냐"뿐이다
(`HORIZONS`, `src/lib/stock-signal.ts`). 예측 레인도 분리된다:
`kind='directional_1d'`(1거래일) / `kind='directional'`(5거래일 — 이 레인이 먼저
있어서 접미사가 없다).

왜 둘인가:
- **하루** — 표본이 5배 빨리 쌓인다(매 거래일 1건). 실전 검증이 먼저 끝난다.
- **일주일** — 국면·수급 지표의 창(20~60일)과 스케일이 맞는다.

2026-08-04 인샘플 측정 (상방 63회, 동일 표본):
| 지평 | 적중 | 기저율 | 차이 |
|---|---|---|---|
| 하루(1거래일) | 63.5% | 56.3% | **+7.2%p** |
| 일주일(5거래일) | 65.1% | 60.2% | **+4.9%p** |

하루 쪽 엣지가 더 크지만 **우열을 단정하지 않는다** — 같은 63개 신호를 다른 자로 잰
것이고 둘 다 인샘플이다. 실전 표본(live)이 쌓이면 그때 판정한다.

대상 거래일은 **기준 봉(as_of)에서 잰다**. "오늘"에서 재면 백테스트(신호일 종가 진입)와
기록이 다른 걸 재게 된다. 기준 봉이 낡아 대상일이 이미 지났으면(`stale`) 그 레인은
기록을 건너뛴다 — 결과를 아는 채로 예측하는 걸 막는다. 대상일이 **오늘**인 건 stale이
아니다(종가 미확정). 그래도 이미 확정됐다면 `createPrediction`의 409가 잡고, 그 레인만
접고 나머지 지평은 계속 기록한다.

### 전량 기록 + 국면별 분해 (2026-08-04)
**규칙이 통과시킨 날만 기록하면 규칙을 개선할 수 없다.** 게이트가 막은 날의 결과를
모르니, 자기 필터로 자기 성적을 매기는 순환이 된다. 그래서 방향이 잡히는
**모든 거래일**을 기록하고, `stock_predictions.context`(0010 마이그레이션)에 판정
상태를 박제한다:

```json
{ "score": -2, "passed": false, "gated": true, "applied_threshold": 3,
  "volatility": "extreme", "components": { "trend": -1, "flow": 0, "relative_sox": -1 } }
```

- `passed=true` — 게이트·임계값 통과. 대시보드의 "실전 적중률"이 이것만 센다.
- `passed=false` — 막힌 날. **매매 참고가 아니라 게이트 검증용 표본이다.** 이쪽이
  통과분보다 잘 맞으면 게이트가 틀렸다는 실전 증거가 된다.
- context 없는 옛 행(08-04 이전)은 전부 통과분이라 passed 쪽으로 센다.

`computeRegimeBreakdown`이 이 축들로 성능을 쪼갠다 — 국면별(추세/변동성/수급)과
컴포넌트별로, **각 슬라이스의 기저율과 함께**. 국면마다 기저율이 다르다는 게 핵심이다:
상승 추세 구간은 아무 날이나 사도 잘 맞으므로, 국면별 기저율을 빼지 않으면
"상승장에서 규칙이 잘 맞는다"는 동어반복만 나온다.

2026-08-04 인샘플 1차 관찰 (5거래일 지평, 원시 방향 기준):
| 컴포넌트 | n | 적중 | 기저율 | 차이 |
|---|---|---|---|---|
| 수급(외국인) | 15 | 93% | 7% | +86.6%p |
| 추세(MA 배열) | 121 | 64% | 64% | 0%p |
| 상대강도(SOX) | 154 | 54% | 58% | **−3.9%p** |

읽는 법 — **아직 결론이 아니다**:
- 수급의 +86.6%p는 못 믿는다. 수급 이력이 30거래일뿐이라 15개 표본이 급락 한 구간에
  몰려 있고(기저율 7%가 그 증거다), 5일 창이 서로 겹쳐 실질 독립 표본은 서너 개다.
  "외국인 순매도 국면에서 하락이 이어졌다"는 사건 하나를 15번 센 것에 가깝다.
- 상대강도의 −3.9%p는 표본이 가장 크고(n=154) 기간도 넓어 **가장 진지하게 볼 단서**다.
  이 컴포넌트가 점수에 해를 끼치고 있을 가능성. 실전 표본으로 재확인이 필요하다.
- 전부 인샘플이다. 임계값을 이 데이터를 보며 정했으므로 여기서 규칙을 또 고치면
  과최적화가 깊어진다. **실전 표본으로 확인한 뒤에 고치는 게 순서다.**

### 주간 관점 뷰 (2026-08-03 추가)
이 시스템의 본체는 **주 단위 판단 보조**다 — 신호 지평(5거래일), 국면 창(20~60일),
채점 루프가 전부 그 스케일이다. 신호 카드가 그걸 화면으로 보여준다:
- **주간 등락 8주** (마지막 확정 종가 기준) — `computeWeeklyChanges`.
- **규칙 점수 추이** (최근 90거래일 스파크라인, 신호 발생일에 점) — `computeSignalSeries`가
  **각 과거 거래일에 그날까지의 데이터만 잘라** 같은 규칙을 재적용한다(룩어헤드 방지).
- **인샘플 백테스트 + 기저율** — 지평별 적중률을 "아무 날이나 잡았을 때의 상승
  확률(기저율)"과 나란히 표시한다(위 표). 기저율 없이 적중률만 인용하면 상승장 착시다.
  주의: 인샘플(임계값을 이 데이터를 보며 정함) + 수급 컴포넌트는 이력 있는 최근
  30거래일만 반영. 실전 성적은 directional 표본이 별도로 쌓인다.

---

## 운영 모니터링

수집이 조용히 실패하는 걸 막는 장치. 세 겹이다.

1. **`collector_runs` 기록** — 수집기가 실행 시작·종료를 보고한다. 실패 사유는 `error`에
   들어가고, `partial`(일부만 저장)도 따로 구분된다.
2. **`GET /api/stock/health`** — `missed`, 마지막 성공 실행, 지표별 최신 버킷을 한 번에.
   외부에서 폴링하거나 세션에서 "수집 잘 되고 있어?"에 답할 때 쓴다.
3. **`/stock` 상단 경고 배너** — `missed`면 예정 시각·마지막 성공·에러 앞부분을 보여준다.

`missed` 판정: `lastExpectedCloseRun()`이 "이미 지났어야 할 가장 최근 평일 18:43 KST +
**유예 3시간**"을 구하고, 그 시각 이후 `status='ok'`인 실행이 없으면 참.
**`kind='intraday'` 실행은 이 계산에서 제외**한다 — 장중 실행은 확정 데이터를 하나도
만들지 않아서, 세면 장중 성공이 마감 누락을 가려버린다. 프리마켓은 전날 확정분을 다시
채우는 안전망이라 포함한다.
유예를 45분으로 뒀다가 2시간 늦게 뜬 실행을 누락으로 오탐해서 늘렸다 — 하루 1회 작업이라
몇 시간 늦게 알아도 손해가 없고, 지각을 실패로 부르는 알림이 더 해롭다.

> **공휴일 오탐.** KRX 휴장일을 모른다 — 평일 휴장일엔 `missed`가 참으로 뜬다.
> 배너·openapi 설명 모두에 이 단서를 적어놨다. 휴장일 캘린더를 붙이기 전까지는
> "공휴일이면 정상"이 정답이다.

---

## 대시보드

`src/app/stock/page.tsx` — server component. API를 거치지 않고 서비스
(`searchStockSnapshots`, `getStockHistory`, `searchStockAnalysis`)를 **직접 호출**한다.
- 지표별 카드(`metricRows`) + "최신 브리핑" 섹션(`BriefingCard`) + "추이" 섹션.
- 신선도 배지(`freshnessBadge`/`agoText`), 숫자 포맷은 `src/app/stock/format.ts`
  (서버 페이지와 클라이언트 차트가 공유).
- 모바일 우선(폰에서 주로 봄): `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.

### 추이 차트 (`src/app/stock/TrendCharts.tsx`)

라이브러리 없이 인라인 SVG. 클라이언트 컴포넌트인 이유는 hover/포커스 툴팁 하나뿐이고,
데이터·표는 서버에서 렌더된다.

- **종가** — 단일 시계열 선. 선은 중립 회색이고 기간 방향 색은 끝점·기간 등락률에만 쓴다.
- **투자자별 순매수** — 외국인/기관/개인 3단 스몰 멀티플. **셋이 같은 y 스케일**이라
  서로 비교된다(캡션에 ±스케일 명시). 0선 위=순매수, 아래=순매도.
- 툴팁은 마크를 가리지 않는 쪽에 붙는다. 한 번 잡으면 그 날짜의 세 값을 다 보여준다.
  ← → 키로도 이동한다. **툴팁은 보조 수단** — 모든 값은 각 카드의 "표로 보기"에 있다.
- 부호 색 토큰은 `globals.css`의 `.viz` (라이트/다크 각각). 국내 관례를 따라
  **빨강=순매수·상승, 파랑=순매도·하락**이고, 카드 텍스트(`toneClass`)도 같은 규칙이다.
  원래 쓰던 emerald/rose는 색각 이상 판별에서 실패해서(deutan ΔE 5.8, 하한 6) 갈아탔다.
  현재 쌍은 두 표면 모두 CVD·대비 검사 통과(ΔE 21.6 light / 19.2 dark).
  **색을 바꾸면 dataviz 스킬의 `validate_palette.js`를 다시 돌릴 것.**

---

## 로컬 개발 / 명령어

```bash
pnpm dev                 # localhost:3000
pnpm typecheck           # tsc --noEmit (커밋 전 필수)
pnpm db:migrate          # drizzle/*.sql 전체 재적용 (idempotent, create ... if not exists)
pnpm collect:stock       # .env.local 로 수집기 로컬 실행 (JARVIS_BASE_URL 대상으로 POST)
```

로컬 백필(=프로덕션 Neon에 직접 쌓기): dev 서버를 띄우고 그쪽으로 POST한다. 사내
프록시가 `*.vercel.app`을 막아서 로컬에서는 프로덕션 URL을 못 치기 때문이고,
`.env.local`의 `DATABASE_URL`이 프로덕션 Neon이라 결과는 CI 실행과 동일하다.

```bash
pnpm dev &
set -a; . ~/git/high-high/.env; set +a   # KIS 키 (레포 밖에만 둔다)
STOCK_BACKFILL_DAYS=30 JARVIS_BASE_URL=http://localhost:3000 pnpm collect:stock
```

`.env.local` 필요 키: `DATABASE_URL`, `JARVIS_API_TOKEN`, `JARVIS_WEB_PASSWORD`,
`JARVIS_BRIEFING_TOKEN`(자동 브리핑 루틴용 — **Vercel 환경변수에도 같은 값이 있어야** 한다).
로컬에서 `collect:stock`을 돌리려면 `KIS_APP_KEY/SECRET`, `JARVIS_BASE_URL`도 추가해야
한다(기본 `.env.local`엔 없음 — CI 시크릿으로만 돎).

마이그레이션은 손으로 쓴 **idempotent SQL**(`create table if not exists …`)이고
`src/db/migrate.ts`가 매 실행마다 `drizzle/`의 모든 `.sql`을 다시 적용한다. 새 지표가
컬럼을 추가할 일은 거의 없다(payload jsonb라서).

---

## 자동 브리핑 루틴 (Claude 클라우드)

`trig_01TF1cTEXXQ4pfVCZfDAHnta` — **매일 08:30~19:30 KST 매시 30분**(cron `30 23,0-10 * * 0-5` UTC).
UTC 단일 cron으로는 KST 주말 경계를 정확히 못 자르므로 토·일 슬롯 일부가 발화하는데,
프롬프트 0단계가 KST 요일을 보고 주말이면 즉시 종료한다. 모드는 시각으로 정한다:
**pre**(09시 이전 — 간밤 SOX·나스닥·ADR 괴리) / **intraday**(09~15시반) /
**close**(15시반 이후 — 마감 확정치·하루 요약).
관리·실행 로그: https://claude.ai/code/routines/trig_01TF1cTEXXQ4pfVCZfDAHnta
(삭제는 이 화면에서만 되고 API로는 안 된다.)

- **데이터가 낡았으면 스스로 수집을 트리거한다.** `POST /api/stock/collect`가 GitHub
  workflow_dispatch를 쏘고(수 초 내 시작, cron과 달리 지연 없음 — 실행 자체는 ~31초),
  루틴은 30초 간격 폴링으로 신선한 스냅샷을 기다렸다가 브리핑한다. 2026-07-31 오전에
  cron 지연으로 루틴이 연쇄 스킵된 것이 계기. 엔드포인트에는 GitHub PAT만 필요하고
  **KIS 키는 여전히 GitHub Secrets에만 있다.** 남발 방지: 10분 이내 신선하면 skip,
  3분 이내 실행 중이면 skip. `GITHUB_DISPATCH_TOKEN` 미설정이면 503 → 루틴은 기존
  스킵 규칙으로 후퇴한다.
- 하는 일: ①`intraday_price` 신선도 확인 ②**직전 브리핑의 "지켜볼 것"을 지금 데이터로 채점**
  ③현황·이상치·지켜볼 것 작성 ④`POST /api/stock/analysis`(`kind='intraday'`,
  `authored_by='claude-routine'`) ⑤데이터·API 한계가 있었으면 개선노트 1건.
- **안 쓰는 조건이 프롬프트에 박혀 있다**: 장중 데이터가 60분 이상 밀렸거나, 직전 브리핑
  30분 이내 + 가격 변화 0.3% 미만이면 건너뛴다. 매시간 같은 말을 반복하면 대시보드가
  노이즈가 된다.
- "지켜볼 것"은 **다음 시간에 채점 가능한 문장**으로 쓰게 했다. 채점 결과에 '판단 불가'가
  쌓이면 그건 브리핑이 검증 불가능하게 쓰였다는 신호로 본다.

> 🔑 **토큰.** 루틴은 로컬 env에 접근하지 못해서 프롬프트에 토큰을 들고 있다. 그래서 전권
> 토큰이 아니라 **`JARVIS_BRIEFING_TOKEN`**(스냅샷·브리핑 읽기 + 브리핑 쓰기 + 개선노트
> 쓰기)만 준다. `src/lib/auth.ts`의 `checkBearer(req, { also: 'briefing' })`가 그 경계다.
> **Vercel 환경변수에 이 키가 없으면 루틴은 401을 받고 아무것도 쓰지 않는다**(그렇게
> 설계했다 — 조용히 실패하지 않고 보고한다).
>
> 🚫 KIS 키는 루틴에 **절대** 넣지 않는다. 주문 가능 키다. 루틴은 jarvis API만 본다.

### 루틴이 올린 개선노트 처리하기

루틴이 "데이터·API가 부족해 못 한 것"을 발견하면 `improvement_notes`에 쌓인다. 그 뒤 처리는
**사람 몫**이고, 상태 기계는 이미 있다 (`status`: `open → triaged → applied | wontfix`).

| 상태 | 뜻 |
|---|---|
| `open` | 루틴이 올린 그대로. 아직 안 봤다. |
| `triaged` | 봤고 고칠 가치가 있다고 판단. 아직 안 고쳤다. |
| `applied` | 고쳤다. **`resolution_note`에 커밋 SHA를 적는다.** |
| `wontfix` | 안 고치기로 했다. `resolution_note`에 **왜 안 하는지**를 적는다. |

- 처리 화면: `/improvement` (status 필터) → 단건에서 상태·메모 수정. API는 `PATCH /api/improvement/{id}`.
- **루틴은 등록(POST)과 조회(GET)만 된다. 상태 변경 권한은 없다** — 판정을 자기가 내리면
  루프가 자기충족적이 된다. 브리핑 전용 토큰의 경계가 그 선이다.
- 루틴은 새 노트를 올리기 전에 GET으로 **중복을 먼저 확인**한다. 같은 한계를 매시간 다시
  올리면 목록이 쓸모없어진다.
- 첫 사례: `819b9c5a` — "장중에 `foreign_holding`이 갱신되지 않아 그걸 근거로 한 관찰 항목이
  구조적으로 채점 불가" → `applied`, 커밋 `7469506`.

---

## 온디맨드 브리핑 (Claude 세션이 하는 일)

"오늘 브리핑해줘" 요청 시:
1. 최신 snapshot을 읽는다 (Neon 직접 조회가 가장 확실 — 아래 gotcha 참고).
2. 상태 요약을 작성한다 — **예측 아님**, 현재 수급·가격 상태 + 이상치 + 지켜볼 것.
3. `POST /api/stock/analysis` (`claim_type: 'state_summary'`, `input_snapshot_ids`에
   근거 snapshot id 넣기)로 저장 → 대시보드 "최신 브리핑"에 표시.

---

## Gotchas

- **`*.vercel.app`이 403이면 그건 사내 프록시(Zscaler)다 — Vercel이 아니다.**
  2026-07-30 확인: 로컬에서 프로덕션 URL을 치면 Zscaler 차단 페이지(403 HTML)가 오지만,
  Anthropic 클라우드 루틴에서 같은 URL을 치면 우리 앱의 JSON이 온다(`request_logs`에
  `curl/8.5.0`로 찍힘). **Deployment Protection 때문이라던 종전 설명은 틀렸다.**
  로컬 세션에서 검증할 땐 Neon 직접 조회나 `pnpm dev`(→ 같은 프로덕션 DB)를 쓸 것.
- **tsx alias 미해석.** `scripts/`의 단독 스크립트는 `@/` 대신 상대경로 import.
- **captured_at은 DB `now()`.** upsert set에서 Node `new Date()` 쓰면 시각 역행.
- **`latest=true`는 `captured_at`(기록 시각) 기준이지 거래일 기준이 아니다.**
  과거 버킷 하나만 다시 수집하면 그 옛 날짜가 대시보드에 "최신"으로 뜬다. 백필은
  오래된 날짜부터 POST해서 이 문제를 피한다. 단건 재수집은 이 점을 알고 할 것.
- **수급 대금 단위 = 백만원.** 표시 전 조/억 환산 필수.
- **KIS 주문 코드 금지 / KIS 키 Vercel 반입 금지** (위 §KIS 참고).

---

## 남은 일 / 다음 단계

### ✅ 완료·배포됨
- 수집 배관: `stock_snapshots`/`stock_analysis` 테이블 + `/api/stock/*` + 수집기
  (jarvis 내 `scripts/collect-stock.ts`) + GitHub Actions cron(18:43 KST 평일)
- `/stock` 대시보드 (지표별 카드 + "최신 브리핑" 섹션)
- 수급 매수/매도 분해 표시 + 대금 단위(백만원→조/억) 환산
- 온디맨드 브리핑 (Claude 세션이 수동으로 작성·POST)
- **30일 백필** — 수집기 `--backfill` 모드 + workflow_dispatch input.
  2026-07-29 실행분: 거래일 22일치 `investor_flow`/`daily_ohlcv` 적재 완료
  (2026-06-29~07-29). 이제 추세 계산의 원천 데이터는 있다.
- **openapi.yaml에 `/api/stock/*` 4개 추가** (v1.2.0) — ChatGPT Actions에서 스냅샷을
  읽고 브리핑을 남길 수 있다.
- **추이 차트** — 종가 시계열 + 투자자별 순매수 스몰 멀티플(같은 스케일) + 표로 보기.
  부호 색을 국내 관례(빨강=순매수)로 통일하면서 색각 이상 실패를 걷어냈다.
- **운영 모니터링** — `collector_runs` + `/api/stock/health` + 대시보드 경고 배너.
- **매매 결정 로그** — `trade_decisions` + `/stock/decisions` + API 4개.
- **아침 프리마켓 cron** — 08:10 KST 평일 (마감 수집 실패 시 안전망).
- **cron 자동 실행 검증** — 2026-07-30 확인. 다만 1~2시간 지연이 정상이라 유예를 3시간으로 뒀다.
- **장중 수집** — `intraday_price` 매시 (09~15시 KST 평일).
- **KIS 필드 회수** — 밸류에이션·수급질·플래그 (`valuation` metric 신설, 추가 호출 없음).
- **공시·뉴스** — `market_events` + OpenDART/구글 뉴스 RSS.
- **일봉 페이지네이션 + 장기 백필** — 269거래일(2025-06-25~) 적재. 수급은 KIS 30일 상한.
- **지표·국면 라벨** — MA60/120·변동성 백분위·국면 분류 + `/api/stock/regime`.
- **벤치마크 재설계** — SOX·삼성전자·나스닥(비오염) + KOSPI·업종(오염 표기, §벤치마크와 오염).
- **ADR 수집** — `adr_price`(NAS/SKHY). 벤치마크 아님, 오버나이트 괴리 관찰용.
- **예측 기록·자동 채점** — `stock_predictions` + 사후 차단 + 조회 시 채점 + 적중률 통계.
  루틴이 매시 "지켜볼 것"을 구조화 등록하고 다음 시간에 채점 결과를 인용한다.
- **UX 정비 (2026-08-03, 자체+codex 이중 리뷰)** — 히어로 요약(현재가·전일比 최상단),
  카드 그리드 화이트리스트·고정 순서(보조 시계열 원시 노출 제거), `latest=true`를
  `DISTINCT ON`으로 교체(대량 백필 후 카드 실종 버그), 신호 워딩 탈권고화("상방/하방
  조건 충족" + 미검증 라벨 동일 무게), 결정 로그 기본값 중립화, 다크모드 배지 일괄,
  장세 인지 신선도 배지, 브리핑·국면 근거 접기, 헤더 모바일 스크롤.
- **자동 브리핑 루틴** — Claude 클라우드 루틴 + 브리핑 전용 토큰 (§자동 브리핑 루틴).

### ⬜ 남은 일 (대략 우선순위 순)
1. **directional 표본 쌓기 → `validated_directional` 해금 판단** — Phase 6 신호 레인은
   열렸고(2026-07-31, 리처드 결정), 이제 마감마다 buy/sell 신호가 자동 기록·채점된다.
   표본 수십 건이 쌓이면 적중률을 보고 AI 방향성 주장 해금 여부를 결정한다 — 리처드님 결정.
2. **KRX 휴장일 캘린더** — `missed` 공휴일 오탐 + 예측 expired 오탐 제거.
3. **수집 항목 확대** — KRX 연기금 세분·이력, DART 5%+ 대주주.
4. **장중 하이브리드 심화** — 초·분 단위 실시간이 필요해지면 상시 프로세스 호스팅 필요.

### 열린 결정
- **실시간 시세 호스팅** — 장중 실시간이 필요해지면 GitHub Actions cron으로 불가,
  상시 프로세스를 어디서 돌릴지 결정 필요.
- **크로스레포 구조** — 지금은 KIS 클라이언트/수집기를 jarvis 안에 두고 있음. 안정화되면
  데이터 전용 패키지로 분리할지 재검토.
- **다종목** — 우선 하이닉스 단일. `STOCK_SYMBOL`로 파라미터화는 돼 있음.
- **소스 리스크** — KRX 비공식 엔드포인트 깨짐 가능성, DART API 키 발급 필요.

---

원래 자동매매 엔진을 만들던 배경·백테스트·설계 히스토리는 별도 레포
`~/git/high-high/PLAN-DASHBOARD.md`에 있다. 이 문서는 **현재 구현 + 남은 일**을 다룬다.
