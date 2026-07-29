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
  prsnNet: number;
  frgnNet: number;
  orgnNet: number;
}

/** Daily net-buy amount by 개인/외국인/기관, newest-first, settled days only. */
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
