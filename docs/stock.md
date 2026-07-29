# Stock reference-info aggregator

SK하이닉스(`000660`) **매매 참고정보** 대시보드. 리처드님이 직접 매매할 때 볼 정보를
모아 보여주는 것이 목적 — **자동매매·수익예측 아님.**

> ⚠️ **정직성 규칙 (제품의 핵심 제약).**
> 이 기능은 "AI가 사라/팔라"를 하지 않는다. buy/sell/target price/rating 같은
> 컬럼·필드를 **의도적으로 두지 않는다.** AI 브리핑은 "현재 상태 요약/이상치/
> 시나리오/리스크"까지만 허용되고, 검증된 방향성 주장(`validated_directional`)은
> 통계 검증(미구현)이 붙기 전까지 API에서 **거부(400)** 된다. 이 경계를 무너뜨리는
> 변경은 하지 말 것.

---

## 데이터 흐름

```
GitHub Actions cron (18:43 KST, 평일)
  └─ scripts/collect-stock.ts
       └─ src/lib/kis-marketdata.ts  (KIS 읽기전용)
       └─ POST ${JARVIS_BASE_URL}/api/stock/snapshot   ← Bearer
              └─ upsert → Neon (stock_snapshots)
                     └─ /stock 대시보드 (server component, 서비스 직접 조회)

Claude 세션 (온디맨드 브리핑)
  └─ 최신 snapshot 읽고 브리핑 작성
       └─ POST /api/stock/analysis  → Neon (stock_analysis)
              └─ /stock "최신 브리핑" 섹션
```

수집·스케줄링은 **Vercel 밖 GitHub Actions**에서 돈다 (Vercel Hobby cron은 하루 1회만
가능해서). jarvis는 저장·API·대시보드만 담당하는 passive store.

---

## 파일 지도

| 영역 | 파일 |
|---|---|
| DB 스키마 | `src/db/schema.ts` — `stockSnapshots`, `stockAnalysis` |
| 마이그레이션 | `drizzle/0004_stock_snapshots.sql`, `0005_stock_analysis.sql` |
| zod 입력/쿼리 | `src/lib/schemas.ts` — `CreateStockSnapshotInput` 외 |
| 서비스 | `src/lib/stock-service.ts`, `src/lib/stock-analysis-service.ts` |
| API | `src/app/api/stock/snapshot/route.ts`, `.../analysis/route.ts` |
| KIS 클라이언트 | `src/lib/kis-marketdata.ts` (읽기전용) |
| 수집기 | `scripts/collect-stock.ts` |
| cron | `.github/workflows/collect-stock.yml` |
| 대시보드 | `src/app/stock/page.tsx` |

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

현재 수집 중인 `metric` 3종 (`source: 'kis'`):

| metric | payload 필드 |
|---|---|
| `investor_flow` | `close`, `amount_unit: 'million_krw'`, `{foreign,institution,individual}_{net,buy,sell}` — 투자자별 순매수/매수/매도 **대금(백만원)** |
| `daily_ohlcv` | `open, high, low, close, volume` |
| `foreign_holding` | `price, foreign_ratio(%), foreign_qty` |

> 수급 대금 단위는 **백만원**이다. 화면에서는 조/억으로 환산해 표시
> (`page.tsx`의 `moneyMil`). raw 숫자를 그대로 찍으면 1.24조를 1,242,524로
> 오표기하게 됨 — 실제로 있었던 버그.

### `stock_analysis` — AI 브리핑/의견
- `kind`: `pre | intraday | close | ondemand`
- `claim_type`: `state_summary | anomaly | scenario | risk | validated_directional`
  (마지막은 위 정직성 규칙에 따라 API에서 거부)
- `input_snapshot_ids`: 이 브리핑이 근거로 삼은 snapshot id 배열
- **buy/sell/target/rating 컬럼 없음** — 설계상 의도.

---

## API

- 모든 라우트: `runtime='nodejs'`, `dynamic='force-dynamic'`.
- 인증: **`checkBearer(req)`** — `Authorization: Bearer <JARVIS_API_TOKEN>`,
  timing-safe 비교. `/api/`는 `middleware.ts`에서 **패스워드 미들웨어를 우회**하고
  Bearer만 검사한다 (페이지는 `JARVIS_WEB_PASSWORD` 세션 쿠키).
- 공통 배관: `withLog(...)` 래퍼 + zod `safeParse` + `ok()/jsonError()/fromZod()`
  (`@/lib/http`).

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/stock/snapshot` | 자연키로 upsert, 201 |
| GET | `/api/stock/snapshot?latest=true` | `(symbol,metric)`별 최신 1건. `symbol/metric/source/limit` 필터 |
| POST | `/api/stock/analysis` | 브리핑 생성, 201. `validated_directional`은 400 |
| GET | `/api/stock/analysis?limit=n` | 최신순. `symbol/kind` 필터 |

---

## KIS 클라이언트 & 수집기

`src/lib/kis-marketdata.ts` — **읽기전용.** 주문 코드는 **절대 넣지 말 것**
(PLAN-DASHBOARD §14). 쓰는 TR:

- `FHKST01010900` inquire-investor → 투자자별 매수/매도/순매수 대금·수량 (30일)
- `FHKST03010100` inquire-daily-itemchartprice → 일봉 OHLCV
- `FHKST01010100` inquire-price → 현재가 + 외국인 보유비율/수량

`scripts/collect-stock.ts`:
- KIS에서 위 3종 fetch → 정규화 → jarvis API로 POST. `collector_run_id`(uuid)로
  한 번의 수집을 묶는다.
- **import는 상대경로** (`../src/lib/kis-marketdata`) — tsx 단독 실행이 `@/` alias를
  해석하지 못함. `@/`로 바꾸지 말 것.
- env: `KIS_APP_KEY`, `KIS_APP_SECRET`, `JARVIS_API_TOKEN`, `JARVIS_BASE_URL`,
  (선택) `STOCK_SYMBOL`.

> 🔐 **KIS app key는 그 자체로 주문 가능**하다. jarvis는 high-high의 live-trading
> 타입 게이팅을 상속하지 않으므로, KIS 키를 **Vercel env에 두지 말 것.**
> GitHub Secrets(CI) + 로컬 `~/git/high-high/.env`(개발)에만 둔다.

---

## GitHub Actions cron

`.github/workflows/collect-stock.yml`:
- `cron: '43 9 * * 1-5'` = **18:43 KST 평일** (투자자 flow 확정 후, 정각 지연 회피용
  off-minute). `workflow_dispatch`로 수동 트리거 가능.
- Node `.nvmrc`(20.20.2), pnpm 9.
- Repo Secrets: `KIS_APP_KEY`, `KIS_APP_SECRET`, `JARVIS_API_TOKEN`,
  `JARVIS_BASE_URL`. (Environment secrets 아님 — **Repository secrets**)
- 수동 실행: `gh workflow run collect-stock.yml` → `gh run watch <id> --exit-status`.

---

## 대시보드

`src/app/stock/page.tsx` — server component. API를 거치지 않고 서비스
(`searchStockSnapshots`, `searchStockAnalysis`)를 **직접 호출**한다.
- 지표별 카드(`metricRows`) + "최신 브리핑" 섹션(`BriefingCard`).
- 신선도 배지(`freshnessBadge`/`agoText`), 숫자 포맷(`won`/`korQty`/`moneyMil`).
- 모바일 우선(폰에서 주로 봄): `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.

---

## 로컬 개발 / 명령어

```bash
pnpm dev                 # localhost:3000
pnpm typecheck           # tsc --noEmit (커밋 전 필수)
pnpm db:migrate          # drizzle/*.sql 전체 재적용 (idempotent, create ... if not exists)
pnpm collect:stock       # .env.local 로 수집기 로컬 실행 (JARVIS_BASE_URL 대상으로 POST)
```

`.env.local` 필요 키: `DATABASE_URL`, `JARVIS_API_TOKEN`, `JARVIS_WEB_PASSWORD`.
로컬에서 `collect:stock`을 돌리려면 `KIS_APP_KEY/SECRET`, `JARVIS_BASE_URL`도 추가해야
한다(기본 `.env.local`엔 없음 — CI 시크릿으로만 돎).

마이그레이션은 손으로 쓴 **idempotent SQL**(`create table if not exists …`)이고
`src/db/migrate.ts`가 매 실행마다 `drizzle/`의 모든 `.sql`을 다시 적용한다. 새 지표가
컬럼을 추가할 일은 거의 없다(payload jsonb라서).

---

## 온디맨드 브리핑 (Claude 세션이 하는 일)

"오늘 브리핑해줘" 요청 시:
1. 최신 snapshot을 읽는다 (Neon 직접 조회가 가장 확실 — 아래 gotcha 참고).
2. 상태 요약을 작성한다 — **예측 아님**, 현재 수급·가격 상태 + 이상치 + 지켜볼 것.
3. `POST /api/stock/analysis` (`claim_type: 'state_summary'`, `input_snapshot_ids`에
   근거 snapshot id 넣기)로 저장 → 대시보드 "최신 브리핑"에 표시.

---

## Gotchas

- **Vercel Deployment Protection.** 공개 `*.vercel.app` 도메인은 플랫폼 레벨에서
  API/페이지를 `403`(HTML)로 막을 수 있다. 세션에서 데이터를 **읽어 검증**할 땐
  `DATABASE_URL`로 **Neon 직접 조회**가 확실하다. 수집기가 통과하는 건 GitHub
  Secret의 `JARVIS_BASE_URL`(보호 안 된 경로)로 POST하기 때문.
- **tsx alias 미해석.** `scripts/`의 단독 스크립트는 `@/` 대신 상대경로 import.
- **captured_at은 DB `now()`.** upsert set에서 Node `new Date()` 쓰면 시각 역행.
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

### ⬜ 남은 일 (대략 우선순위 순)
1. **자동 브리핑 스케줄** — 지금은 수동 온디맨드. Claude 루틴으로 마감 후 자동 작성.
2. **`tradeDecisionLog`** — 결정 → 결과 → 교훈 루프 테이블 + UI (제품 개선의 핵심 피드백).
3. **운영 모니터링** — `collectorRuns` 기록 + staleness/수집 실패 알림 (지금은 실패해도
   조용함, cron 누락을 놓칠 수 있음).
4. **아침 프리마켓 수집 cron** 추가 (현재는 마감 후 1회만).
5. **수집 항목 확대** — KRX 연기금 세분·이력, DART 5%+ 대주주, SOX/글로벌 오버나이트 갭.
6. **장중 하이브리드** — 결정론적 지표 + AI 저빈도. 실시간 시세가 필요하면 cron으로는
   안 되고 상시 프로세스 호스팅이 필요 (아래 열린 결정).
7. **방향성 지표 + 적중률 검증** — §12의 `validated_directional`을 해금하는 전제조건.
   검증 통계 없이는 방향성 주장 금지. 이후 다종목 확장.

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
