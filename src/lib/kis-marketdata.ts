/**
 * Minimal READ-ONLY KIS market-data client for the stock aggregator collector.
 * Deliberately contains NO order/trading code — the collector must never be
 * able to place orders (PLAN-DASHBOARD §14). Note: the KIS app key itself is
 * still order-capable, so keep it in GitHub Secrets only, never in Vercel env.
 */

import { withRetry } from './retry';

const REAL_BASE = 'https://openapi.koreainvestment.com:9443';

export interface KisCreds {
  appKey: string;
  appSecret: string;
}

export interface KisToken {
  token: string;
  /** epoch ms. 캐시가 이 값으로 재사용 여부를 정한다. */
  expiresAt: number;
}

/**
 * 접근 토큰 발급. **KIS는 발급할 때마다 사용자에게 알림을 보내므로** 직접 부르지 말고
 * `kis-token-cache.getKisToken`을 쓸 것 — 토큰은 24시간짜리라 실행마다 받을 이유가 없다.
 */
export async function issueToken(creds: KisCreds): Promise<KisToken> {
  // `only: 'network'` — 요청이 KIS에 닿지 못한 경우만 다시 던진다. 서버가 응답했다면
  // 발급이 일어났을 수 있고, 그러면 재시도가 알림을 한 통 더 만든다. 발급 자체에도
  // 분당 제한이 있어서 무턱대고 재시도하면 오히려 막힌다.
  const res = await withRetry(
    'KIS tokenP',
    () =>
      fetch(`${REAL_BASE}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: creds.appKey,
          appsecret: creds.appSecret,
        }),
      }),
    { only: 'network' },
  );
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`KIS token failed: ${res.status} ${body.error_description ?? ''}`);
  }
  // expires_in은 초. 안 오면 24시간으로 가정하되, 캐시 쪽 여유(30분)가 오차를 흡수한다.
  const ttl = Number.isFinite(body.expires_in) ? Number(body.expires_in) : 86_400;
  return { token: body.access_token, expiresAt: Date.now() + ttl * 1000 };
}

/**
 * 조회는 전부 이걸 지나간다. 여기 하나에 재시도를 걸어두면 KIS 호출 전체가 덮인다 —
 * 러너에서 한국 호스트로 나가는 연결이 가끔 끊기는데, 그때마다 실행이 통째로 죽고
 * 있었다 (retry.ts 참고).
 */
async function kisGet<T>(
  token: string,
  creds: KisCreds,
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(REAL_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return withRetry(`KIS ${trId}`, async () => {
    const res = await fetch(url, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: creds.appKey,
        appsecret: creds.appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    });
    // 상태를 먼저 본다. 502를 그대로 json()에 넘기면 SyntaxError로 둔갑해서, 재시도할
    // 가치가 있는 실패인지 판정할 수 없게 된다. 본문에 설명이 있으면 같이 실어 보낸다 —
    // 상태 코드만 남기면 4xx일 때 원인을 알 수 없다.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = '';
      try {
        msg = (JSON.parse(detail) as { msg1?: string }).msg1 ?? '';
      } catch {
        msg = detail.slice(0, 120);
      }
      throw new Error(`KIS ${trId} http ${res.status}${msg ? ` ${msg}` : ''}`);
    }
    const body = (await res.json()) as T & { rt_cd?: string; msg1?: string };
    if (body.rt_cd && body.rt_cd !== '0') {
      throw new Error(`KIS ${trId} error: ${body.msg1 ?? body.rt_cd}`);
    }
    return body;
  });
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface InvestorFlow {
  date: string; // YYYYMMDD
  close: number;
  // net / buy / sell trading amount in 백만원 (million KRW), per investor type
  prsnNet: number;
  frgnNet: number;
  orgnNet: number;
  prsnBuy: number;
  frgnBuy: number;
  orgnBuy: number;
  prsnSell: number;
  frgnSell: number;
  orgnSell: number;
}

/** One published estimate point within today's session. */
export interface InvestorEstimateBucket {
  /** KIS `bsop_hour_gb` — the publish slot, ascending through the session. */
  seq: number;
  /** Estimated net buy in SHARES (not amount). Foreign / institution only. */
  foreignQty: number;
  institutionQty: number;
  sumQty: number;
}

/**
 * Intraday 외국인·기관 net-buy ESTIMATE, in shares, per publish slot.
 *
 * This is the only per-stock flow KIS serves while the session is open —
 * `investorFlows` (FHKST01010900) carries nothing for today until after the
 * close. The tradeoffs are real and must survive to the screen: no 개인, shares
 * rather than amount, and the field name is literally `frgn_fake_ntby_qty`
 * (가집계). On 2026-08-11 the final slot read −345,000 shares against a settled
 * −299,781 백만원 (≈ −210,000 shares) — the estimate is the right sign but not
 * the right size, so read direction from it, never magnitude.
 *
 * Slots are returned newest-first and are NOT normalized here: whether a slot
 * is cumulative or per-interval is unverified, so the caller stores the whole
 * array and lets accumulated observations answer that.
 */
export async function investorTrendEstimate(
  token: string,
  creds: KisCreds,
  code: string,
): Promise<InvestorEstimateBucket[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/investor-trend-estimate',
    'HHPTJ04160200',
    { MKSC_SHRN_ISCD: code },
  );
  return (body.output2 ?? [])
    .filter((o) => o.bsop_hour_gb)
    .map((o) => ({
      seq: num(o.bsop_hour_gb),
      foreignQty: num(o.frgn_fake_ntby_qty),
      institutionQty: num(o.orgn_fake_ntby_qty),
      sumQty: num(o.sum_fake_ntby_qty),
    }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Daily buy/sell/net trading amount (백만원) by 개인/외국인/기관, newest-first,
 * settled days only. `_shnu_` = 매수, `_seln_` = 매도, `_ntby_` = 순매수.
 *
 * Note: the response carries NO row for today while the session is open — the
 * earliest it appears is after the close. Intraday callers want
 * `investorTrendEstimate` instead.
 */
export async function investorFlows(
  token: string,
  creds: KisCreds,
  code: string,
): Promise<InvestorFlow[]> {
  const body = await kisGet<{ output?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-investor',
    'FHKST01010900',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
  );
  return (body.output ?? [])
    .filter((o) => o.stck_bsop_date && o.frgn_ntby_tr_pbmn !== '')
    .map((o) => ({
      date: o.stck_bsop_date ?? '',
      close: num(o.stck_clpr),
      prsnNet: num(o.prsn_ntby_tr_pbmn),
      frgnNet: num(o.frgn_ntby_tr_pbmn),
      orgnNet: num(o.orgn_ntby_tr_pbmn),
      prsnBuy: num(o.prsn_shnu_tr_pbmn),
      frgnBuy: num(o.frgn_shnu_tr_pbmn),
      orgnBuy: num(o.orgn_shnu_tr_pbmn),
      prsnSell: num(o.prsn_seln_tr_pbmn),
      frgnSell: num(o.frgn_seln_tr_pbmn),
      orgnSell: num(o.orgn_seln_tr_pbmn),
    }));
}

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily OHLCV within [start,end] (YYYYMMDD), newest-first. */
export async function dailyCandles(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
): Promise<DailyBar[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    'FHKST03010100',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: start,
      FID_INPUT_DATE_2: end,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    },
  );
  return (body.output2 ?? [])
    .filter((o) => o.stck_bsop_date)
    .map((o) => ({
      date: o.stck_bsop_date ?? '',
      open: num(o.stck_oprc),
      high: num(o.stck_hgpr),
      low: num(o.stck_lwpr),
      close: num(o.stck_clpr),
      volume: num(o.acml_vol),
    }));
}

export interface IndexBar {
  date: string; // YYYYMMDD
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

/** 벤치마크로 쓰는 업종/지수 코드. `FID_COND_MRKT_DIV_CODE='U'`와 함께 쓴다. */
export const INDEX_CODES = {
  kospi: '0001',
  electronics: '0013', // 전기·전자 — SK하이닉스가 속한 업종
} as const;

/**
 * 업종/지수 일별 시세 (FHKUP03500100). 종목 일봉과 응답 형태가 달라
 * (`bstp_nmix_*`) 별도 함수로 둔다. 반환은 **최신순**.
 */
export async function indexDaily(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
): Promise<IndexBar[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice',
    'FHKUP03500100',
    {
      FID_COND_MRKT_DIV_CODE: 'U',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: start,
      FID_INPUT_DATE_2: end,
      FID_PERIOD_DIV_CODE: 'D',
    },
  );
  return (body.output2 ?? [])
    .filter((o) => o.stck_bsop_date)
    .map((o) => ({
      date: o.stck_bsop_date ?? '',
      close: num(o.bstp_nmix_prpr),
      open: num(o.bstp_nmix_oprc),
      high: num(o.bstp_nmix_hgpr),
      low: num(o.bstp_nmix_lwpr),
      volume: num(o.acml_vol),
    }));
}

/**
 * 지수도 한 번에 다 안 온다 — **종목 일봉은 100건, 지수는 50건**이 상한이다(확인됨).
 * 같은 방식으로 창을 밀며 받되, 호출 수 계산은 50건 기준으로 잡아야 조용히 잘리지 않는다.
 */
export async function indexDailyRange(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
  opts: { maxCalls?: number; delayMs?: number } = {},
): Promise<IndexBar[]> {
  const maxCalls = opts.maxCalls ?? 12;
  const delayMs = opts.delayMs ?? 250;
  const byDate = new Map<string, IndexBar>();
  let cursor = end;

  for (let i = 0; i < maxCalls; i++) {
    const page = await indexDaily(token, creds, code, start, cursor);
    if (!page.length) break;
    const before = byDate.size;
    for (const b of page) byDate.set(b.date, b);
    if (byDate.size === before) break;
    const earliest = page.reduce((min, b) => (b.date < min ? b.date : min), page[0]!.date);
    if (earliest <= start) break;
    cursor = prevYmd(earliest);
    if (cursor < start) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** 환율 코드 (FHKST03030100, div `X`). 확인: FX@KRW=원/달러(KMB), FX@JPY=엔/달러. */
export const FX_CODES = {
  usdkrw: 'FX@KRW',
  usdjpy: 'FX@JPY',
} as const;

/**
 * 해외지수/환율 일별 (FHKST03030100). `marketDiv` — `'N'` 해외지수, `'X'` 환율.
 * 국내 지수와 **필드명이 또 다르다** (`ovrs_nmix_*`). 확인된 코드: `SOX`(필라델피아
 * 반도체지수), `COMP`(나스닥 종합), 환율은 FX_CODES. `.SOX`/`SOXX`/`USDKRW` 같은
 * 변형은 빈 응답이라 쓰지 말 것. 한 번에 100건 상한. 반환은 최신순.
 */
export async function overseasIndexDaily(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
  marketDiv: 'N' | 'X' = 'N',
): Promise<IndexBar[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice',
    'FHKST03030100',
    {
      FID_COND_MRKT_DIV_CODE: marketDiv,
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: start,
      FID_INPUT_DATE_2: end,
      FID_PERIOD_DIV_CODE: 'D',
    },
  );
  return (body.output2 ?? [])
    .filter((o) => o.stck_bsop_date)
    .map((o) => ({
      date: o.stck_bsop_date ?? '',
      close: num(o.ovrs_nmix_prpr),
      open: num(o.ovrs_nmix_oprc),
      high: num(o.ovrs_nmix_hgpr),
      low: num(o.ovrs_nmix_lwpr),
      volume: num(o.acml_vol),
    }));
}

/** 해외지수도 창을 밀며 받는다 (100건 상한). */
export async function overseasIndexDailyRange(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
  opts: { maxCalls?: number; delayMs?: number; marketDiv?: 'N' | 'X' } = {},
): Promise<IndexBar[]> {
  const maxCalls = opts.maxCalls ?? 12;
  const delayMs = opts.delayMs ?? 250;
  const byDate = new Map<string, IndexBar>();
  let cursor = end;
  for (let i = 0; i < maxCalls; i++) {
    const page = await overseasIndexDaily(token, creds, code, start, cursor, opts.marketDiv ?? 'N');
    if (!page.length) break;
    const before = byDate.size;
    for (const b of page) byDate.set(b.date, b);
    if (byDate.size === before) break;
    const earliest = page.reduce((min, b) => (b.date < min ? b.date : min), page[0]!.date);
    if (earliest <= start) break;
    cursor = prevYmd(earliest);
    if (cursor < start) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 해외주식 일별 (HHDFS76240000). SK하이닉스 ADR은 `EXCD='NAS', SYMB='SKHY'`.
 *
 * 두 가지 한계를 알고 써야 한다:
 * - **이력이 짧다.** 2026-07-30 확인 시 SKHY는 15거래일만 온다.
 * - **`BYMD`로 과거를 더 못 긁는다.** BYMD는 '그 날짜 기준 1건'을 주는 as-of 파라미터라
 *   창을 밀며 받는 방식이 통하지 않는다.
 * 반환은 최신순.
 */
export async function overseasStockDaily(
  token: string,
  creds: KisCreds,
  excd: string,
  symb: string,
): Promise<DailyBar[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/overseas-price/v1/quotations/dailyprice',
    'HHDFS76240000',
    { AUTH: '', EXCD: excd, SYMB: symb, GUBN: '0', BYMD: '', MODP: '0' },
  );
  return (body.output2 ?? [])
    .filter((o) => o.xymd)
    .map((o) => ({
      date: o.xymd ?? '',
      open: num(o.open),
      high: num(o.high),
      low: num(o.low),
      close: num(o.clos),
      volume: num(o.tvol),
    }));
}

/** `YYYYMMDD` 하루 전. 문자열 날짜 계산을 Date로 왕복시키지 않기 위한 헬퍼. */
function prevYmd(ymd: string): string {
  const d = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 일봉을 여러 번 나눠 받아 긴 구간을 채운다.
 *
 * `dailyCandles`(FHKST03010100)는 **요청 구간과 무관하게 최신 100건만** 준다
 * (19개월을 요청해도 100건, 확인됨). 그래서 받은 것 중 가장 오래된 날짜의 하루 전으로
 * `end`를 밀어가며 반복한다. 새 데이터가 안 오면 상장 이래 끝에 닿은 것으로 보고 멈춘다.
 *
 * KIS 초당 호출 제한이 있어 창 사이에 `delayMs`만큼 쉰다. 반환은 기존 계약대로 **최신순**.
 */
export async function dailyCandlesRange(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
  opts: { maxCalls?: number; delayMs?: number } = {},
): Promise<DailyBar[]> {
  const maxCalls = opts.maxCalls ?? 12;
  const delayMs = opts.delayMs ?? 250;
  const byDate = new Map<string, DailyBar>();
  let cursor = end;

  for (let i = 0; i < maxCalls; i++) {
    const page = await dailyCandles(token, creds, code, start, cursor);
    if (!page.length) break;

    const before = byDate.size;
    for (const b of page) byDate.set(b.date, b);
    // 같은 창을 다시 받은 셈이면(새 날짜 0건) 더 뒤로 갈 데이터가 없다.
    if (byDate.size === before) break;

    const earliest = page.reduce((min, b) => (b.date < min ? b.date : min), page[0]!.date);
    if (earliest <= start) break;
    cursor = prevYmd(earliest);
    if (cursor < start) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface Quote {
  price: number;
  change: number; // 전일 대비 (원)
  changeRate: number; // 전일 대비 %
  open: number;
  high: number;
  low: number;
  volume: number; // 누적 거래량 (주)
  amountKrw: number; // 누적 거래대금 (원 — investor_flow의 백만원과 단위가 다르다)
  foreignRatio: number;
  foreignQty: number;
  // 수급의 '질' — 누가 사는지
  /**
   * KIS `frgn_ntby_qty`. 이름은 "외국인 순매수 수량"이지만 **장중 매매 순매수가 아니다.**
   * 2026-08-05 확인: 거래량이 89만→193만 주로 느는 동안 값이 -2,208로 고정이었고,
   * 그 -2,208은 `frgn_hldn_qty`(외국인 보유수량)의 전일 대비 변화와 정확히 같았다
   * (07-31의 -32,544도 일치). 즉 **보유수량 일별 변화**이고 하루 한 번만 갱신된다.
   * 장중 수급 근거로 쓰면 안 된다 — 그러라고 있는 값이 아니다.
   */
  foreignHoldingDeltaQty: number;
  programNetQty: number; // 프로그램 순매수 수량
  shortQty: number; // 최종 공매도 체결량
  loanBalanceRate: number; // 대차잔고 비율 %
  // 상태 플래그. 빈 문자열/'N'이면 해당 없음.
  viCode: string; // VI 발동 구분
  warnCode: string; // 시장경고 구분
  shortOverYn: string; // 공매도 과열
  cautionYn: string; // 투자주의
  // 밸류에이션·기준선
  per: number;
  pbr: number;
  eps: number;
  bps: number;
  marketCap: number; // 시가총액 (억원 단위로 옴)
  listedShares: number;
  turnoverRate: number; // 거래량 회전율 %
  sector: string; // 업종명
  w52High: number;
  w52Low: number;
  w52HighDate: string;
  w52LowDate: string;
  d250High: number;
  d250Low: number;
}

/**
 * 장중 스냅샷용 현재가 묶음. `foreignHolding()`과 같은 TR(inquire-price)이다 —
 * **이 TR은 80개 필드를 주는데** 예전엔 3개만 꺼내 쓰고 나머지를 버렸다. 밸류에이션,
 * 52주/250일 고저, 프로그램 순매수, 대차잔고율, 공매도 체결량, VI·시장경고까지
 * 전부 같은 응답에 들어 있어서 추가 호출 없이 얻는다.
 */
export async function currentQuote(
  token: string,
  creds: KisCreds,
  code: string,
): Promise<Quote> {
  const body = await kisGet<{ output?: Record<string, string> }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    'FHKST01010100',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
  );
  const o = body.output ?? {};
  return {
    price: num(o.stck_prpr),
    change: num(o.prdy_vrss),
    changeRate: num(o.prdy_ctrt),
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    volume: num(o.acml_vol),
    amountKrw: num(o.acml_tr_pbmn),
    foreignRatio: num(o.hts_frgn_ehrt),
    foreignQty: num(o.frgn_hldn_qty),
    foreignHoldingDeltaQty: num(o.frgn_ntby_qty),
    programNetQty: num(o.pgtr_ntby_qty),
    shortQty: num(o.last_ssts_cntg_qty),
    loanBalanceRate: num(o.whol_loan_rmnd_rate),
    viCode: o.vi_cls_code ?? '',
    warnCode: o.mrkt_warn_cls_code ?? '',
    shortOverYn: o.short_over_yn ?? '',
    cautionYn: o.invt_caful_yn ?? '',
    per: num(o.per),
    pbr: num(o.pbr),
    eps: num(o.eps),
    bps: num(o.bps),
    marketCap: num(o.hts_avls),
    listedShares: num(o.lstn_stcn),
    turnoverRate: num(o.vol_tnrt),
    sector: o.bstp_kor_isnm ?? '',
    w52High: num(o.w52_hgpr),
    w52Low: num(o.w52_lwpr),
    w52HighDate: o.w52_hgpr_date ?? '',
    w52LowDate: o.w52_lwpr_date ?? '',
    d250High: num(o.d250_hgpr),
    d250Low: num(o.d250_lwpr),
  };
}

export interface ForeignHolding {
  price: number;
  foreignRatio: number; // 외국인 보유비율 %
  foreignQty: number; // 외국인 보유수량
}

/** Current price + foreign ownership (외국인 보유비율/수량). */
export async function foreignHolding(
  token: string,
  creds: KisCreds,
  code: string,
): Promise<ForeignHolding> {
  const body = await kisGet<{ output?: Record<string, string> }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    'FHKST01010100',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
  );
  const o = body.output ?? {};
  return {
    price: num(o.stck_prpr),
    foreignRatio: num(o.hts_frgn_ehrt),
    foreignQty: num(o.frgn_hldn_qty),
  };
}

// ── 국내 휴장일 달력 ────────────────────────────────────────────────────

export interface BusinessDay {
  date: string; // YYYY-MM-DD
  /** 증시 개장일인가 (opnd_yn) — 이게 우리가 쓰는 값이다 */
  openMarket: boolean;
  /** 영업일인가 (bzdy_yn) — 은행 기준이라 증시와 다를 수 있다 (근로자의날 등) */
  businessDay: boolean;
}

/**
 * 국내 휴장일 조회 (CTCA0903R). 미래 날짜까지 준다 — 이게 핵심이다.
 *
 * 과거 휴장일은 저장된 일봉의 빈 평일로 정확히 역산되지만(백필이 KIS 연속 구간
 * 조회라 "봉 없음 = 휴장"이 확실하다), **미래는 역산할 수 없다.** 5거래일 뒤가
 * 언제인지 알려면 앞으로의 휴장일을 알아야 하고, 그래서 이 API가 필요하다.
 *
 * `opnd_yn`(개장 여부)만 쓴다. `bzdy_yn`(영업일)은 은행 기준이라 근로자의 날처럼
 * 증시만 쉬는 날에 어긋난다.
 */
export async function domesticBusinessDays(
  token: string,
  creds: KisCreds,
  fromYmd: string, // YYYYMMDD
  /**
   * 받아올 페이지 수. 한 페이지가 약 한 달치라, **"오늘 장이 열리나"만 알면 되는
   * 호출은 1로 준다** — 장중 매시 실행이 4페이지씩 받으면 하루 32번의 낭비다.
   */
  opts: { maxPages?: number } = {},
): Promise<BusinessDay[]> {
  const maxPages = opts.maxPages ?? 4;
  const out: BusinessDay[] = [];
  let ctxArea = '';
  let ctxKey = '';
  // 한 번에 최대 약 한 달치라 연속조회로 채운다. 지평 계산엔 2주면 충분하지만
  // 여유를 둔다 — 호출은 하루 한 번뿐이다.
  for (let page = 0; page < maxPages; page++) {
    const body = await kisGet<{
      output?: Array<{ bass_dt?: string; opnd_yn?: string; bzdy_yn?: string }>;
      ctx_area_fk?: string;
      ctx_area_nk?: string;
      tr_cont?: string;
    }>(token, creds, '/uapi/domestic-stock/v1/quotations/chk-holiday', 'CTCA0903R', {
      BASS_DT: fromYmd,
      CTX_AREA_NK: ctxKey,
      CTX_AREA_FK: ctxArea,
    });
    for (const r of body.output ?? []) {
      const d = r.bass_dt;
      if (!d || d.length !== 8) continue;
      out.push({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        openMarket: r.opnd_yn === 'Y',
        businessDay: r.bzdy_yn === 'Y',
      });
    }
    ctxArea = body.ctx_area_fk?.trim() ?? '';
    ctxKey = body.ctx_area_nk?.trim() ?? '';
    if (!ctxKey) break;
  }
  // 같은 날짜가 페이지 경계에서 겹칠 수 있다
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.date) ? false : (seen.add(b.date), true)));
}

// ── 분기 재무 (긴 지평의 "위치" 답변용) ────────────────────────────────

export interface QuarterFinancial {
  /** 'YYYYMM' 결산년월 */
  period: string;
  roe: number;
  /** 주당순이익 */
  eps: number;
  /** 주당순자산 — PBR 밴드의 분모 */
  bps: number;
  /** 주당매출 */
  sps: number;
  salesGrowthPct: number;
  operatingProfitGrowthPct: number;
  netIncomeGrowthPct: number;
  debtRatio: number;
}

/**
 * 분기 재무비율 (FHKST66430300). 23분기치가 온다 — **긴 지평에서 방향 대신 위치를
 * 답하기 위한 재료**다. 6달·1년 방향 예측은 검증에 수십 년이 걸려 내지 않는 대신,
 * "PBR이 이력 밴드의 어디"처럼 오늘 확인 가능한 사실을 보여준다 (horizon-board.ts 참고).
 *
 * 반환은 **최신순**. 연간/분기 혼재가 아니라 `FID_DIV_CLS_CODE=0`(연간 누적) 기준이라
 * `stac_yymm`이 12월인 행과 분기 행이 섞여 나온다 — 쓰는 쪽이 period로 판단할 것.
 */
export async function quarterFinancials(
  token: string,
  creds: KisCreds,
  symbol: string,
): Promise<QuarterFinancial[]> {
  const body = await kisGet<{
    output?: Array<Record<string, string>>;
  }>(token, creds, '/uapi/domestic-stock/v1/finance/financial-ratio', 'FHKST66430300', {
    FID_DIV_CLS_CODE: '0',
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: symbol,
  });
  return (body.output ?? [])
    .filter((o) => o.stac_yymm)
    .map((o) => ({
      period: o.stac_yymm!,
      roe: num(o.roe_val),
      eps: num(o.eps),
      bps: num(o.bps),
      sps: num(o.sps),
      salesGrowthPct: num(o.grs),
      operatingProfitGrowthPct: num(o.bsop_prfi_inrt),
      netIncomeGrowthPct: num(o.ntin_inrt),
      debtRatio: num(o.lblt_rate),
    }));
}

// ── 분봉 (짧은 지평의 재료) ─────────────────────────────────────────────

export interface MinuteBar {
  /** 'HH:MM' KST */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 당일 분봉 (FHKST03010200). **`endHhmmss` 직전 30분**을 준다 — 한 번에 30건이라
 * 하루(09:00~15:30, 390분)를 채우려면 30분 간격으로 13번 부른다.
 *
 * 왜 필요한가: 10분·1시간 지평은 시간당 스냅샷 1건으로는 채점조차 못 한다. 분봉이
 * 있어야 "09:10 시점 예측을 09:20 값으로 채점"이 성립한다 (horizon-board.ts 참고).
 */
export async function minuteBars(
  token: string,
  creds: KisCreds,
  symbol: string,
  endHhmmss: string,
): Promise<MinuteBar[]> {
  const body = await kisGet<{ output2?: Array<Record<string, string>> }>(
    token,
    creds,
    '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
    'FHKST03010200',
    {
      FID_ETC_CLS_CODE: '',
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: symbol,
      FID_INPUT_HOUR_1: endHhmmss,
      FID_PW_DATA_INCU_YN: 'N',
    },
  );
  return (body.output2 ?? [])
    .filter((o) => o.stck_cntg_hour && o.stck_prpr)
    .map((o) => ({
      time: `${o.stck_cntg_hour!.slice(0, 2)}:${o.stck_cntg_hour!.slice(2, 4)}`,
      open: num(o.stck_oprc),
      high: num(o.stck_hgpr),
      low: num(o.stck_lwpr),
      close: num(o.stck_prpr),
      volume: num(o.cntg_vol),
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** 하루를 덮는 조회 끝점들 (30분 간격). 정규장 09:00~15:30. */
export const MINUTE_WINDOWS = [
  '093000', '100000', '103000', '110000', '113000', '120000', '123000',
  '130000', '133000', '140000', '143000', '150000', '153000',
] as const;
