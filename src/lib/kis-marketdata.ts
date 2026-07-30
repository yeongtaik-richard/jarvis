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
