/**
 * Minimal READ-ONLY KIS market-data client for the stock aggregator collector.
 * Deliberately contains NO order/trading code — the collector must never be
 * able to place orders (PLAN-DASHBOARD §14). Note: the KIS app key itself is
 * still order-capable, so keep it in GitHub Secrets only, never in Vercel env.
 */

const REAL_BASE = 'https://openapi.koreainvestment.com:9443';

export interface KisCreds {
  appKey: string;
  appSecret: string;
}

export async function issueToken(creds: KisCreds): Promise<string> {
  const res = await fetch(`${REAL_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: creds.appKey,
      appsecret: creds.appSecret,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`KIS token failed: ${res.status} ${body.error_description ?? ''}`);
  }
  return body.access_token;
}

async function kisGet<T>(
  token: string,
  creds: KisCreds,
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(REAL_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
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
  const body = (await res.json()) as T & { rt_cd?: string; msg1?: string };
  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS ${trId} error: ${body.msg1 ?? body.rt_cd}`);
  }
  return body;
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

/**
 * Daily buy/sell/net trading amount (백만원) by 개인/외국인/기관, newest-first,
 * settled days only. `_shnu_` = 매수, `_seln_` = 매도, `_ntby_` = 순매수.
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

/**
 * 해외지수 일별 (FHKST03030100, `FID_COND_MRKT_DIV_CODE='N'`).
 * 국내 지수와 **필드명이 또 다르다** (`ovrs_nmix_*`). 확인된 코드: `SOX`(필라델피아
 * 반도체지수), `COMP`(나스닥 종합). `.SOX`/`SOXX`는 빈 응답이라 쓰지 말 것.
 * 한 번에 100건 상한. 반환은 최신순.
 */
export async function overseasIndexDaily(
  token: string,
  creds: KisCreds,
  code: string,
  start: string,
  end: string,
): Promise<IndexBar[]> {
  const body = await kisGet<{ output2?: Record<string, string>[] }>(
    token,
    creds,
    '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice',
    'FHKST03030100',
    {
      FID_COND_MRKT_DIV_CODE: 'N',
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
  opts: { maxCalls?: number; delayMs?: number } = {},
): Promise<IndexBar[]> {
  const maxCalls = opts.maxCalls ?? 12;
  const delayMs = opts.delayMs ?? 250;
  const byDate = new Map<string, IndexBar>();
  let cursor = end;
  for (let i = 0; i < maxCalls; i++) {
    const page = await overseasIndexDaily(token, creds, code, start, cursor);
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
  foreignNetQty: number; // 외국인 순매수 수량
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
    foreignNetQty: num(o.frgn_ntby_qty),
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
