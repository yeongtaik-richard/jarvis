import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getCollectorHealth } from '@/lib/collector-run-service';
import { searchMarketEvents, toApiMarketEvent } from '@/lib/market-event-service';
import { getStockRegime } from '@/lib/stock-regime-service';
import { predictionStats, searchPredictions, toApiPrediction } from '@/lib/prediction-service';
import { getStockSignal } from '@/lib/stock-signal-service';
import { PredictionQuery } from '@/lib/schemas';
import { MarketEventQuery, StockAnalysisQuery, StockSnapshotQuery } from '@/lib/schemas';
import {
  searchStockAnalysis,
  toApiStockAnalysis,
  type ApiStockAnalysis,
} from '@/lib/stock-analysis-service';
import {
  getStockHistory,
  searchStockSnapshots,
  toApiStockSnapshot,
  type ApiStockSnapshot,
} from '@/lib/stock-service';
import { korQty, moneyKrw, moneyMil, won } from './format';
import {
  CloseTrendChart,
  NetFlowChart,
  type ClosePoint,
  type FlowPoint,
} from './TrendCharts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function minutesAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 60000);
}
/** 평일 09:00~15:30 KST인가 — 신선도 경고는 장중에만 의미가 있다. */
function isMarketHoursKst(now: number): boolean {
  const kst = new Date(now + 9 * 3_600_000);
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 9 * 60 && min <= 15 * 60 + 30;
}
/**
 * 장외·주말에는 금요일 마감 데이터가 "이틀 전"이어도 정상이라 경고색을 쓰지 않는다.
 * rose는 쓰지 않는다 — 빨강 계열은 가격·수급 방향(상승/순매수)에 예약돼 있어서
 * 상태 경고에 섞으면 관례와 충돌한다 (codex 리뷰 반영).
 */
function freshnessBadge(mins: number, marketOpen: boolean): string {
  if (!marketOpen) return 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  if (mins < 20) return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (mins < 90) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  return 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200';
}
function agoText(mins: number): string {
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const METRIC_LABEL: Record<string, string> = {
  investor_flow: '수급 · 투자자별 순매수',
  daily_ohlcv: '일봉 (OHLCV)',
  foreign_holding: '외국인 보유',
  intraday_price: '장중 현재가',
  valuation: '밸류에이션 · 기준선',
};

/**
 * 카드 그리드에 올리는 metric과 그 **고정 순서**. captured_at 순서로 돌리면 카드
 * 위치가 수집 시점마다 흔들리고, benchmark_*·fx_*·adr_price 같은 보조 시계열이
 * 영문 키 그대로 원시 카드로 노출됐다 (2026-08-03 리뷰). 보조 시계열은 이미
 * 국면·추이 섹션에 반영되므로 그리드에서 제외한다.
 */
const CARD_METRICS = [
  'intraday_price',
  'investor_flow',
  'daily_ohlcv',
  'valuation',
  'foreign_holding',
] as const;

type Tone = 'pos' | 'neg' | 'neutral';
type Row = { label: string; value: string; tone?: Tone; sub?: string };

function flowRow(
  label: string,
  net: number | null,
  buy: number | null,
  sell: number | null,
): Row {
  if (net === null) return { label, value: '—' };
  const sub =
    buy !== null && sell !== null
      ? `매수 ${moneyMil(buy)} · 매도 ${moneyMil(sell)}`
      : undefined;
  if (net === 0) return { label, value: '보합', tone: 'neutral', sub };
  const word = net > 0 ? '순매수' : '순매도';
  return {
    label,
    value: `${word} ${moneyMil(net)}`,
    tone: net > 0 ? 'pos' : 'neg',
    sub,
  };
}

/** 수량 기준 순매수 행 (대금이 아니라 주식 수 — 단위를 섞지 않기 위해 별도 함수). */
function flowQtyRow(label: string, qty: number | null): Row {
  if (qty === null) return { label, value: '—' };
  if (qty === 0) return { label, value: '보합', tone: 'neutral' };
  return {
    label,
    value: `${qty > 0 ? '순매수' : '순매도'} ${korQty(Math.abs(qty), '주')}`,
    tone: qty > 0 ? 'pos' : 'neg',
  };
}

/** VI·시장경고 같은 플래그는 **켜졌을 때만** 줄을 만든다. 평소엔 'N'만 늘어놓는 노이즈다. */
function flagRows(p: Record<string, unknown>): Row[] {
  const on = (v: unknown) => typeof v === 'string' && v !== '' && v !== 'N' && v !== '00';
  const rows: Row[] = [];
  if (on(p.vi_code)) rows.push({ label: 'VI 발동', value: String(p.vi_code), tone: 'neutral' });
  if (on(p.warn_code)) rows.push({ label: '시장경고', value: String(p.warn_code), tone: 'neg' });
  if (on(p.short_over_yn)) rows.push({ label: '공매도 과열', value: '지정', tone: 'neg' });
  if (on(p.caution_yn)) rows.push({ label: '투자주의', value: '지정', tone: 'neg' });
  return rows;
}

function metricRows(item: ApiStockSnapshot): Row[] {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : null;
  };

  if (item.metric === 'investor_flow') {
    const close = num('close');
    return [
      { label: '종가', value: close === null ? '—' : won(close) },
      flowRow('외국인', num('foreign_net'), num('foreign_buy'), num('foreign_sell')),
      flowRow(
        '기관',
        num('institution_net'),
        num('institution_buy'),
        num('institution_sell'),
      ),
      flowRow('개인', num('individual_net'), num('individual_buy'), num('individual_sell')),
    ];
  }
  if (item.metric === 'daily_ohlcv') {
    const o = num('open');
    const c = num('close');
    const hi = num('high');
    const lo = num('low');
    const vol = num('volume');
    const chg = o && c ? ((c - o) / o) * 100 : null;
    const range = lo && hi ? ((hi - lo) / lo) * 100 : null;
    return [
      { label: '시가', value: o === null ? '—' : won(o) },
      { label: '고가', value: hi === null ? '—' : won(hi) },
      { label: '저가', value: lo === null ? '—' : won(lo) },
      {
        label: '종가',
        value: c === null ? '—' : won(c),
        tone: chg === null ? undefined : chg >= 0 ? 'pos' : 'neg',
      },
      {
        label: '등락(시가대비)',
        value: chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
        tone: chg === null ? undefined : chg >= 0 ? 'pos' : 'neg',
      },
      { label: '일중 변동폭', value: range === null ? '—' : `${range.toFixed(1)}%` },
      { label: '거래량', value: vol === null ? '—' : korQty(vol, '주') },
    ];
  }
  if (item.metric === 'intraday_price') {
    const price = num('price');
    const rate = num('change_rate');
    const vol = num('volume');
    // 이 지표의 거래대금만 단위가 원이다 (수급은 백만원) — payload.amount_unit 참고.
    const amount = num('amount_krw');
    return [
      {
        label: '현재가',
        value: price === null ? '—' : won(price),
        tone: rate === null ? undefined : rate >= 0 ? 'pos' : 'neg',
      },
      {
        label: '전일 대비',
        value: rate === null ? '—' : `${rate >= 0 ? '+' : ''}${rate}%`,
        tone: rate === null ? undefined : rate >= 0 ? 'pos' : 'neg',
      },
      { label: '고가', value: num('high') === null ? '—' : won(num('high')!) },
      { label: '저가', value: num('low') === null ? '—' : won(num('low')!) },
      { label: '누적 거래량', value: vol === null ? '—' : korQty(vol, '주') },
      { label: '누적 거래대금', value: amount === null ? '—' : moneyKrw(amount) },
      flowQtyRow('외국인 순매수', num('foreign_net_qty')),
      flowQtyRow('프로그램 순매수', num('program_net_qty')),
      { label: '공매도 체결', value: num('short_qty') === null ? '—' : korQty(num('short_qty')!, '주') },
      {
        label: '대차잔고 비율',
        value: num('loan_balance_rate') === null ? '—' : `${num('loan_balance_rate')}%`,
      },
      ...flagRows(p),
    ];
  }
  if (item.metric === 'valuation') {
    const per = num('per');
    const pbr = num('pbr');
    const cap = num('market_cap');
    const hi = num('w52_high');
    const lo = num('w52_low');
    return [
      { label: 'PER', value: per === null ? '—' : `${per}배` },
      { label: 'PBR', value: pbr === null ? '—' : `${pbr}배` },
      // 시총은 억원 단위로 온다 (payload.market_cap_unit)
      { label: '시가총액', value: cap === null ? '—' : `${(cap / 10000).toFixed(1)}조` },
      { label: 'EPS', value: num('eps') === null ? '—' : won(num('eps')!) },
      { label: 'BPS', value: num('bps') === null ? '—' : won(num('bps')!) },
      {
        label: '52주 고가',
        value: hi === null ? '—' : won(hi),
        sub: p.w52_high_date ? String(p.w52_high_date) : undefined,
      },
      {
        label: '52주 저가',
        value: lo === null ? '—' : won(lo),
        sub: p.w52_low_date ? String(p.w52_low_date) : undefined,
      },
      {
        label: '250일 고/저',
        value:
          num('d250_high') === null ? '—' : `${won(num('d250_high')!)} / ${won(num('d250_low')!)}`,
      },
      { label: '거래량 회전율', value: num('turnover_rate') === null ? '—' : `${num('turnover_rate')}%` },
      { label: '업종', value: p.sector ? String(p.sector) : '—' },
    ];
  }
  if (item.metric === 'foreign_holding') {
    const ratio = num('foreign_ratio');
    const qty = num('foreign_qty');
    const price = num('price');
    return [
      { label: '보유비율', value: ratio === null ? '—' : `${ratio}%`, tone: 'neutral' },
      { label: '보유수량', value: qty === null ? '—' : korQty(qty, '주') },
      { label: '현재가', value: price === null ? '—' : won(price) },
    ];
  }
  // fallback: readable key/value of the raw payload
  return Object.entries(p).map(([k, v]) => ({
    label: k,
    value: typeof v === 'number' ? v.toLocaleString('ko-KR') : String(v),
  }));
}

// 부호 색은 국내 관례 — 빨강=순매수·상승, 파랑=순매도·하락. (emerald/rose는 색각 이상
// 판별에서 실패해서 갈아탔다. globals.css의 `.viz` 토큰과 같은 규칙.)
const toneClass: Record<Tone, string> = {
  pos: 'text-red-600 dark:text-red-400',
  neg: 'text-blue-600 dark:text-blue-400',
  neutral: 'text-zinc-700 dark:text-zinc-300',
};

const CLAIM_LABEL: Record<string, string> = {
  state_summary: '현황 요약',
  anomaly: '이상 신호',
  scenario: '시나리오',
  risk: '리스크',
  validated_directional: '검증된 방향성',
};
function claimBadge(ct: string): string {
  if (ct === 'anomaly') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  if (ct === 'risk') return 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300';
  if (ct === 'scenario') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
  return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
}
const KIND_LABEL: Record<string, string> = {
  pre: '프리마켓',
  intraday: '장중',
  close: '마감',
  ondemand: '온디맨드',
};

/** 루틴 브리핑은 3화면짜리 벽텍스트가 되기 쉽다 — 앞부분만 보이고 나머지는 접는다. */
const BRIEFING_PREVIEW_LINES = 14;

function BriefingCard({
  a,
  now,
  prominent = false,
}: {
  a: ApiStockAnalysis;
  now: number;
  prominent?: boolean;
}) {
  const mins = minutesAgo(a.created_at, now);
  const lines = a.body.split('\n');
  const collapsible = lines.length > BRIEFING_PREVIEW_LINES + 4;
  return (
    <div
      className={`rounded-lg border p-4 ${prominent ? 'border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800'}`}
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded ${claimBadge(a.claim_type)}`}>
          {CLAIM_LABEL[a.claim_type] ?? a.claim_type}
        </span>
        <span className="text-xs text-zinc-500">{KIND_LABEL[a.kind] ?? a.kind}</span>
        <span className="text-xs text-zinc-400 ml-auto">{agoText(mins)}</span>
      </div>
      {a.title && <div className="font-medium mb-1">{a.title}</div>}
      {collapsible ? (
        <>
          <div className="text-sm whitespace-pre-wrap leading-relaxed">
            {lines.slice(0, BRIEFING_PREVIEW_LINES).join('\n')}
          </div>
          <details>
            <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
              전체 브리핑 보기
            </summary>
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {lines.slice(BRIEFING_PREVIEW_LINES).join('\n')}
            </div>
          </details>
        </>
      ) : (
        <div className="text-sm whitespace-pre-wrap leading-relaxed">{a.body}</div>
      )}
      <div className="mt-2 text-[11px] text-zinc-400">
        {a.authored_by} · {a.symbol} · 예측 아님(참고용)
      </div>
    </div>
  );
}

const HISTORY_DAYS = 30;

const RUN_KIND_LABEL: Record<string, string> = {
  close: '마감',
  premarket: '프리마켓',
  backfill: '백필',
  manual: '수동',
};
const RUN_STATUS_BADGE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  error: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

// 국면 배지. 추세 색은 국내 관례(빨강=상승, 파랑=하락), 변동성은 상태색(중립→경고).
const TREND_TEXT: Record<string, string> = {
  up: '상승 추세',
  down: '하락 추세',
  sideways: '횡보',
  unknown: '추세 판단 불가',
};
const TREND_BADGE: Record<string, string> = {
  up: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  down: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  sideways: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};
const VOL_TEXT: Record<string, string> = {
  calm: '변동성 낮음',
  normal: '변동성 보통',
  elevated: '변동성 높음',
  extreme: '변동성 극단',
  unknown: '변동성 판단 불가',
};
const VOL_BADGE: Record<string, string> = {
  calm: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  normal: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  elevated: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  extreme: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};
const FLOW_TEXT: Record<string, string> = {
  foreign_buying: '외국인 순매수 지속',
  foreign_selling: '외국인 순매도 지속',
  mixed: '수급 엇갈림',
  unknown: '수급 판단 불가',
};
const FLOW_BADGE: Record<string, string> = {
  foreign_buying: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  foreign_selling: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  mixed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

// 신호 배지. 워딩은 의도적으로 조건 서술형이다 — "매수/매도"는 권고로 읽혀서
// 정직성 제약을 무너뜨린다 (codex 리뷰 반영). 색은 방향 관례(빨강=상방)만 따른다.
const SIGNAL_TEXT: Record<string, string> = {
  buy: '상방 조건 충족',
  sell: '하방 조건 충족',
  watch: '관망',
};
const SIGNAL_BADGE: Record<string, string> = {
  buy: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  sell: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  watch: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

const PRED_TEXT: Record<string, string> = {
  pending: '대기',
  confirmed: '확인됨',
  refuted: '빗나감',
  expired: '만료',
  unverifiable: '검증 불가',
};
const PRED_BADGE: Record<string, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  confirmed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  refuted: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  expired: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
  unverifiable: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
};

function kstTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function payloadNum(payload: unknown, key: string): number {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
}

export default async function StockDashboardPage() {
  const query = StockSnapshotQuery.parse({ latest: true, limit: 100 });
  const rows = await searchStockSnapshots(query);
  const items = rows.map(toApiStockSnapshot);
  const analyses = (
    await searchStockAnalysis(StockAnalysisQuery.parse({ limit: 5 }))
  ).map(toApiStockAnalysis);

  // 추이 차트용 이력 — 대시보드는 단일 종목이라 최신 스냅샷의 symbol을 따른다.
  const symbol = items[0]?.symbol ?? '000660';
  const [ohlcvRows, flowRows, health, eventRows, regimeResult, predRows, predStats, signalResult] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', HISTORY_DAYS),
    getStockHistory(symbol, 'investor_flow', HISTORY_DAYS),
    getCollectorHealth(symbol),
    searchMarketEvents(MarketEventQuery.parse({ symbol, limit: 15 })),
    getStockRegime(symbol),
    searchPredictions(PredictionQuery.parse({ symbol, limit: 8 })),
    predictionStats(symbol),
    getStockSignal(symbol),
  ]);
  const events = eventRows.map(toApiMarketEvent);
  const closePoints: ClosePoint[] = ohlcvRows
    .map((r) => ({ date: r.bucketKey, close: payloadNum(r.payload, 'close') }))
    .filter((p) => Number.isFinite(p.close));
  const volumes = new Map(
    ohlcvRows.map((r) => [r.bucketKey, payloadNum(r.payload, 'volume')]),
  );
  const flowPoints: FlowPoint[] = flowRows
    .map((r) => ({
      date: r.bucketKey,
      foreign: payloadNum(r.payload, 'foreign_net'),
      institution: payloadNum(r.payload, 'institution_net'),
      individual: payloadNum(r.payload, 'individual_net'),
    }))
    .filter((p) => [p.foreign, p.institution, p.individual].every(Number.isFinite));

  const firstClose = closePoints[0]?.close;
  const lastClose = closePoints[closePoints.length - 1]?.close;
  const periodChange =
    firstClose && lastClose ? ((lastClose - firstClose) / firstClose) * 100 : null;

  const now = Date.now();
  const marketOpen = isMarketHoursKst(now);
  const cards = CARD_METRICS.map((m) => items.find((i) => i.metric === m)).filter(
    (i): i is ApiStockSnapshot => Boolean(i),
  );
  const lastCaptured = cards.reduce<string | null>(
    (max, i) => (max && max >= i.captured_at ? max : i.captured_at),
    null,
  );

  // ── 히어로: 폰에서 첫 화면에 "지금 얼마, 몇 %"가 보여야 한다 (두 리뷰 공통 1순위).
  //    장중 스냅샷이 오늘 것일 때만 장중 가격을 쓰고, 아니면 최근 마감 종가 + 전일比.
  const todayKst = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  const intradaySnap = items.find((i) => i.metric === 'intraday_price');
  const intradayIsToday =
    intradaySnap?.as_of_at != null &&
    new Date(new Date(intradaySnap.as_of_at).getTime() + 9 * 3_600_000)
      .toISOString()
      .slice(0, 10) === todayKst;
  let hero: { price: number; rate: number | null; label: string } | null = null;
  if (intradayIsToday && intradaySnap) {
    const p = intradaySnap.payload as Record<string, unknown>;
    const price = Number(p.price);
    const rate = Number(p.change_rate);
    if (Number.isFinite(price)) {
      hero = {
        price,
        rate: Number.isFinite(rate) ? rate : null,
        label: `장중 · ${kstTime(intradaySnap.as_of_at)} 기준`,
      };
    }
  } else if (closePoints.length >= 1) {
    const last = closePoints[closePoints.length - 1]!;
    const prev = closePoints[closePoints.length - 2];
    hero = {
      price: last.close,
      rate: prev ? ((last.close - prev.close) / prev.close) * 100 : null,
      label: `${last.date} 마감`,
    };
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Stock — 참고정보</h1>
          <p className="text-xs text-zinc-500 mt-1">reference state, not a signal · 예측 아님</p>
        </div>

        {hero && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <div className="flex items-baseline gap-3 flex-wrap">
              {/* 히어로 숫자는 비례 숫자 그대로 — tabular-nums는 큰 숫자를 헐겁게 만든다 */}
              <span className="text-3xl font-semibold">{won(hero.price)}</span>
              {hero.rate !== null && (
                <span
                  className={`text-lg font-medium ${hero.rate >= 0 ? toneClass.pos : toneClass.neg}`}
                >
                  {hero.rate >= 0 ? '+' : ''}
                  {hero.rate.toFixed(2)}%
                </span>
              )}
              <span className="text-xs text-zinc-400">{hero.label} · 전일比</span>
              <Link
                href="/stock/decisions"
                className="ml-auto shrink-0 text-sm px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                결정 기록
              </Link>
            </div>
            {regimeResult.regime && (
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                {regimeResult.regime.label} · 기준 {regimeResult.indicators?.as_of}
              </div>
            )}
          </section>
        )}

        <div className="text-sm text-zinc-500">
          {lastCaptured ? (
            <>
              마지막 수집{' '}
              <span
                className={`text-xs px-2 py-0.5 rounded ${freshnessBadge(minutesAgo(lastCaptured, now), marketOpen)}`}
              >
                {agoText(minutesAgo(lastCaptured, now))}
              </span>{' '}
              {!marketOpen && <span className="text-xs text-zinc-400"> · 장외</span>}
              {/* 실행 상태는 문제가 있을 때만 노출 — 평상시 '백필 ok' 같은 운영 정보는 노이즈다 */}
              {health.last_run && health.last_run.status !== 'ok' && (
                <>
                  {' '}
                  · 최근 실행 {RUN_KIND_LABEL[health.last_run.kind] ?? health.last_run.kind}{' '}
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${RUN_STATUS_BADGE[health.last_run.status] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
                  >
                    {health.last_run.status}
                  </span>
                </>
              )}
            </>
          ) : (
            '아직 수집된 데이터 없음'
          )}
        </div>

        {health.missed && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-sm">
            <div className="font-medium text-amber-900 dark:text-amber-200">
              마감 수집이 예정 시각까지 성공하지 못했습니다
            </div>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
              예정 {kstTime(health.expected_close_run_at)} · 마지막 성공{' '}
              {health.last_ok_run
                ? `${kstTime(health.last_ok_run.finished_at ?? health.last_ok_run.started_at)} (${Math.round(health.hours_since_ok ?? 0)}시간 전)`
                : '없음'}
              {health.last_run?.error ? ` · ${health.last_run.error.slice(0, 160)}` : ''}
              . KRX 공휴일이면 정상입니다 — 스케줄은 휴장일을 모릅니다.
            </p>
          </div>
        )}

        {signalResult.signal && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-medium">규칙 신호</h2>
              <span
                className={`text-sm px-2.5 py-1 rounded font-medium ${SIGNAL_BADGE[signalResult.signal.signal]}`}
              >
                {SIGNAL_TEXT[signalResult.signal.signal]}
              </span>
              {/* 미검증 라벨은 신호명과 같은 시각 무게 — 떨어뜨리면 권고로 오독된다 */}
              <span className="text-sm px-2.5 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 tabular-nums">
                미검증 ·{' '}
                {signalResult.directional.scored > 0
                  ? `적중 ${Math.round((signalResult.directional.hit_rate ?? 0) * 100)}% (표본 ${signalResult.directional.scored})`
                  : '표본 없음'}
              </span>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              score {signalResult.signal.score >= 0 ? '+' : ''}{signalResult.signal.score}/{signalResult.signal.max_score}
              {signalResult.signal.gated_by_volatility ? ' · 변동성 극단으로 관망 강등' : ''}
              {signalResult.directional.pending > 0 ? ` · 채점 대기 ${signalResult.directional.pending}건` : ''}
            </div>
            <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
              {signalResult.signal.components.map((c) => (
                <li key={c.key}>
                  {c.value > 0 ? '▲' : c.value < 0 ? '▼' : '·'} {c.reason}
                </li>
              ))}
              {signalResult.target?.comparator && signalResult.reference_close !== null && (
                <li className="text-zinc-400">
                  검증 조건: {signalResult.target.bucket} 종가가 기준({signalResult.as_of} ·{' '}
                  {won(signalResult.reference_close)})보다{' '}
                  {signalResult.target.comparator === 'gt' ? '높은지' : '낮은지'} — 자동 채점됨
                </li>
              )}
            </ul>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
              {signalResult.signal.disclaimer}
            </p>
          </section>
        )}

        {regimeResult.regime && regimeResult.indicators && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="font-medium">
                국면{' '}
                <span className="text-xs font-normal text-zinc-400">
                  규칙 기반 · 최근 {regimeResult.indicators.trading_days}거래일
                </span>
              </h2>
              <span className="text-xs text-zinc-400">
                기준 {regimeResult.indicators.as_of}
              </span>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <span
                className={`text-xs px-2 py-0.5 rounded ${TREND_BADGE[regimeResult.regime.trend]}`}
              >
                {TREND_TEXT[regimeResult.regime.trend]}
              </span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${VOL_BADGE[regimeResult.regime.volatility]}`}
              >
                {VOL_TEXT[regimeResult.regime.volatility]}
                {regimeResult.indicators.vol20_percentile !== null
                  ? ` ${regimeResult.indicators.vol20_percentile}%ile`
                  : ''}
              </span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${FLOW_BADGE[regimeResult.regime.flow]}`}
              >
                {FLOW_TEXT[regimeResult.regime.flow]}
              </span>
            </div>
            <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
              {regimeResult.regime.reasons.slice(0, 8).map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
            {regimeResult.regime.reasons.length > 8 && (
              <details>
                <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                  근거 더 보기 ({regimeResult.regime.reasons.length - 8})
                </summary>
                <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
                  {regimeResult.regime.reasons.slice(8).map((r) => (
                    <li key={r}>· {r}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-[11px] text-zinc-400 pt-1">
              {regimeResult.regime.disclaimer} 임계값은 `src/lib/stock-indicators.ts`에 있다.
            </p>
          </section>
        )}

        {analyses.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              최신 브리핑
            </h2>
            <BriefingCard a={analyses[0]!} now={now} prominent />
            {analyses.length > 1 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-zinc-500 select-none py-2">
                  이전 브리핑 {analyses.length - 1}건
                </summary>
                <div className="mt-2 space-y-2">
                  {analyses.slice(1).map((a) => (
                    <BriefingCard key={a.id} a={a} now={now} />
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {cards.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            수집된 스냅샷이 없습니다. 수집기(GitHub Actions)가 POST하면 여기 표시돼요.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((i) => {
              const mins = minutesAgo(i.captured_at, now);
              return (
                <section
                  key={i.id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="font-medium">
                      {METRIC_LABEL[i.metric] ?? i.metric}
                    </h2>
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded ${freshnessBadge(mins, marketOpen)}`}
                    >
                      {agoText(mins)}
                    </span>
                  </div>
                  <dl className="space-y-1.5 text-sm">
                    {metricRows(i).map((r) => (
                      <div key={r.label} className="flex justify-between gap-3">
                        <dt className="text-zinc-500 shrink-0">{r.label}</dt>
                        <dd className="text-right">
                          <span
                            className={`tabular-nums ${r.tone ? toneClass[r.tone] : ''}`}
                          >
                            {r.value}
                          </span>
                          {r.sub && (
                            <span className="block text-[11px] text-zinc-400 tabular-nums">
                              {r.sub}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-900 text-[11px] text-zinc-400">
                    {i.symbol} · {i.source} · {i.trading_date_kst ?? i.bucket_key}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {(closePoints.length >= 2 || flowPoints.length >= 2) && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              추이
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {closePoints.length >= 2 && (
                <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <h3 className="font-medium">
                      종가{' '}
                      <span className="text-xs font-normal text-zinc-400">
                        최근 {closePoints.length}거래일
                      </span>
                    </h3>
                    <div className="text-right">
                      <div className="font-medium">{won(lastClose!)}</div>
                      {periodChange !== null && (
                        <div
                          className={`text-xs tabular-nums ${periodChange >= 0 ? toneClass.pos : toneClass.neg}`}
                        >
                          {periodChange >= 0 ? '+' : ''}
                          {periodChange.toFixed(2)}% / {closePoints.length}거래일
                        </div>
                      )}
                    </div>
                  </div>
                  <CloseTrendChart points={closePoints} />
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                      표로 보기
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs tabular-nums">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="text-left font-normal py-1">날짜</th>
                            <th className="text-right font-normal py-1">종가</th>
                            <th className="text-right font-normal py-1">거래량</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...closePoints].reverse().map((p) => (
                            <tr
                              key={p.date}
                              className="border-t border-zinc-100 dark:border-zinc-900"
                            >
                              <td className="py-1">{p.date}</td>
                              <td className="py-1 text-right">{won(p.close)}</td>
                              <td className="py-1 text-right">
                                {Number.isFinite(volumes.get(p.date))
                                  ? korQty(volumes.get(p.date)!, '주')
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}

              {flowPoints.length >= 2 && (
                <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
                  <h3 className="font-medium mb-2">
                    투자자별 순매수{' '}
                    <span className="text-xs font-normal text-zinc-400">
                      최근 {flowPoints.length}거래일
                    </span>
                  </h3>
                  <NetFlowChart points={flowPoints} />
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                      표로 보기
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs tabular-nums">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="text-left font-normal py-1">날짜</th>
                            <th className="text-right font-normal py-1">외국인</th>
                            <th className="text-right font-normal py-1">기관</th>
                            <th className="text-right font-normal py-1">개인</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...flowPoints].reverse().map((p) => (
                            <tr
                              key={p.date}
                              className="border-t border-zinc-100 dark:border-zinc-900"
                            >
                              <td className="py-1">{p.date}</td>
                              {[p.foreign, p.institution, p.individual].map((v, idx) => (
                                <td
                                  key={idx}
                                  className={`py-1 text-right ${v === 0 ? '' : v > 0 ? toneClass.pos : toneClass.neg}`}
                                >
                                  {v === 0 ? '보합' : `${v > 0 ? '+' : '−'}${moneyMil(v)}`}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}
            </div>
          </section>
        )}

        {predRows.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                예측 채점
              </h2>
              <span className="text-xs text-zinc-400 tabular-nums">
                {predStats.scored > 0
                  ? `적중 ${predStats.confirmed}/${predStats.scored} (${Math.round((predStats.hit_rate ?? 0) * 100)}%)`
                  : '채점 완료 0건'}
                {predStats.pending > 0 ? ` · 대기 ${predStats.pending}` : ''}
                {predStats.expired > 0 ? ` · 만료 ${predStats.expired}` : ''}
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-900">
              {predRows.map(toApiPrediction).map((pr) => (
                <div key={pr.id} className="p-3 flex gap-3 items-baseline">
                  <span
                    className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${PRED_BADGE[pr.status] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
                  >
                    {PRED_TEXT[pr.status] ?? pr.status}
                  </span>
                  <div className="min-w-0 flex-1 text-sm">
                    {pr.claim}
                    <div className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">
                      {pr.metric}.{pr.field} {pr.comparator} {pr.threshold.toLocaleString('ko-KR')} @ {pr.target_bucket}
                      {pr.actual_value !== null
                        ? ` → 실측 ${pr.actual_value.toLocaleString('ko-KR')}`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-400">
              브리핑의 "지켜볼 것"을 기계가 채점한 기록이다. 등록 시점에 결과가 이미 있으면
              접수 자체가 거부된다(사후 예측 방지).
            </p>
          </section>
        )}

        {events.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              공시 · 뉴스
            </h2>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-900">
              {events.map((e) => (
                <div key={e.id} className="p-3 flex gap-3 items-baseline">
                  <span
                    className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${
                      e.source === 'dart'
                        ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-black'
                        : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {e.source === 'dart' ? '공시' : e.category === 'macro' ? '매크로' : '뉴스'}
                  </span>
                  <div className="min-w-0 flex-1">
                    {e.url ? (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm hover:underline"
                      >
                        {e.title}
                      </a>
                    ) : (
                      <span className="text-sm">{e.title}</span>
                    )}
                    <div className="text-[11px] text-zinc-400 mt-0.5">
                      {kstTime(e.published_at)}
                      {e.publisher ? ` · ${e.publisher}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-400">
              사건의 존재와 시각만 모아둔 것이다. 호재·악재 판정이나 인과 해석은 하지 않는다.
              공시는 DART가 날짜만 제공해 09:00로 표기된다.
            </p>
          </section>
        )}

        <p className="text-[11px] text-zinc-400 pt-2">
          수급은 KIS 투자자별 매매대금(백만원→조/억 환산). 순매수 = 매수 − 매도.
          일별 마감 후 수집. 부호 색은 국내 관례(빨강=순매수·상승, 파랑=순매도·하락).
        </p>
      </main>
    </div>
  );
}
