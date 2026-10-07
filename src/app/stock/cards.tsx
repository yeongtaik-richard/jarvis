/**
 * 원천 지표 카드 — 수집된 payload를 사람이 읽는 줄로 편다.
 *
 * `/stock`(장중)에서 내려 `/stock/data`로 옮겼다. 이 카드들은 **값을 확인하러 오는
 * 것**이지 훑으며 지나가는 게 아니다. 장중에 폰으로 3초 보는 화면에 여덟 장이
 * 세로로 쌓이면, 그 아래 있어야 할 공시·뉴스가 스크롤 저편으로 밀린다.
 */

import { korQty, moneyKrw, moneyMil, won } from './format';
import {
  agoText,
  freshnessBadge,
  kstTime,
  minutesAgo,
  toneClass,
  type Row,
} from './ui';
import type { ApiStockSnapshot } from '@/lib/stock-service';

const METRIC_LABEL: Record<string, string> = {
  investor_flow: '수급 · 투자자별 순매수',
  investor_flow_estimate: '수급 · 오늘 장중 추정',
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
export const CARD_METRICS = [
  'intraday_price',
  // 추정이 확정보다 앞에 온다 — 장중에 보는 사람이 알고 싶은 건 오늘이고, 두 카드가
  // 붙어 있어야 "오늘 추정 vs 어제 확정"이 한눈에 대비된다.
  'investor_flow_estimate',
  'investor_flow',
  'daily_ohlcv',
  'valuation',
  'foreign_holding',
] as const;

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

  if (item.metric === 'investor_flow_estimate') {
    const price = num('price');
    const n = num('bucket_count');
    return [
      { label: '현재가', value: price === null ? '—' : won(price) },
      flowQtyRow('외국인', num('foreign_qty')),
      flowQtyRow('기관', num('institution_qty')),
      flowQtyRow('둘 합계', num('sum_qty')),
      // 개인이 없다는 걸 카드가 스스로 말해야 한다. 확정 카드에는 개인 줄이 있어서,
      // 여기서 비워두면 "개인이 0"으로 읽힌다.
      { label: '개인', value: '장중 미제공', tone: 'neutral' },
      {
        label: '발표 구간',
        value: n === null ? '—' : `${n}개`,
        sub: '장중에 구간이 늘어난다',
      },
    ];
  }
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
      // 외국인 줄은 뺐다 — KIS frgn_ntby_qty를 "장중 외국인 순매수"로 표시했는데
      // 실제로는 보유수량 일별 변화라 장중 내내 고정이고 자릿수도 실제 순매수와 다르다.
      // 보유수량 자체는 아래 '외국인 보유' 카드가 보여준다.
      flowQtyRow('프로그램 순매수(주)', num('program_net_qty')),
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

/**
 * 카드가 "언제 것"인지 제목 바로 밑에 명시한다. 같은 '외국인 순매수' 라벨이
 * 장중 카드(오늘·수량)와 수급 카드(전 거래일 마감·대금)에 동시에 있어서,
 * 기준일이 푸터 작은 글씨에만 있으면 두 값이 모순처럼 읽힌다 (2026-08-03 실제 혼동).
 */
function cardBasis(i: ApiStockSnapshot): string {
  const d = i.trading_date_kst ?? i.bucket_key.slice(0, 10);
  if (i.metric === 'intraday_price') return `${d} 장중 누적 · 수량 기준`;
  if (i.metric === 'foreign_holding') return `${d} 기준`;
  // 밸류에이션은 현재가에서 파생돼 장중 매 수집마다 갱신된다. 기본 분기의 '마감 확정'을
  // 물려받으면 10시에 찍힌 PER이 마감값으로 읽힌다 — 조회 시각을 그대로 쓴다.
  if (i.metric === 'valuation') return `${kstTime(i.as_of_at)} 기준 · 현재가에서 계산`;
  if (i.metric === 'investor_flow_estimate') {
    // 버킷 시각까지 보여준다 — 장중 값은 "몇 시 기준"인지가 값 자체만큼 중요하다.
    const hhmm = i.bucket_key.slice(11, 16);
    // '추정'을 두 번 쓴다(제목·기준선). 확정 카드와 나란히 놓이는 자리라 한 번은
    // 스크롤에 묻힌다. 방향만 읽고 크기는 믿지 말라는 게 이 줄의 일이다.
    return `${d}${hhmm ? ` ${hhmm}` : ''} · 수량 기준 · 외국인·기관 추정(가집계)`;
  }
  // '확정'이라고 쓰지 않는다: 8/10 행을 마감 후 재조회하니 기관/개인이 각각 7,100
  // (백만원)씩 옮겨가 있었다. 마감 집계는 나중에 정정된다.
  if (i.metric === 'investor_flow') return `${d} 마감 집계 · 대금 기준`;
  return `${d} 마감 확정`;
}

export function MetricCards({
  cards,
  now,
  marketOpen,
}: {
  cards: ApiStockSnapshot[];
  now: number;
  marketOpen: boolean;
}) {
  if (cards.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        수집된 스냅샷이 없습니다. 수집기(GitHub Actions)가 POST하면 여기 표시돼요.
      </div>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
        원천 지표 {cards.length}종{' '}
        <span className="font-normal text-zinc-400">수집된 값 그대로</span>
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((i) => {
          const mins = minutesAgo(i.captured_at, now);
          return (
            <section
              key={i.id}
              className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-medium">{METRIC_LABEL[i.metric] ?? i.metric}</h3>
                <span
                  className={`shrink-0 text-xs px-2 py-0.5 rounded ${freshnessBadge(mins, marketOpen)}`}
                >
                  {agoText(mins)}
                </span>
              </div>
              <div className="text-[11px] text-zinc-400 mb-3">{cardBasis(i)}</div>
              <dl className="space-y-1.5 text-sm">
                {metricRows(i).map((r) => (
                  <div key={r.label} className="flex justify-between gap-3">
                    <dt className="text-zinc-500 shrink-0">{r.label}</dt>
                    <dd className="text-right">
                      <span className={`tabular-nums ${r.tone ? toneClass[r.tone] : ''}`}>
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
      {/* 수급 단위 주의는 **이 카드들 옆**에 있어야 한다. 페이지 최하단에 두면
          해당 카드에서 서너 번 스크롤 아래라 아무도 같이 읽지 않는다. */}
      <p className="text-[11px] text-zinc-400">
        수급은 KIS의 투자자별 매매대금이다. 순매수는 매수에서 매도를 뺀 값이고, 마감 후 하루
        한 번 모은다. 빨강이 상승·순매수, 파랑이 하락·순매도다(국내 관례). 마감 집계는 다음날
        아침에 한 번 더 받아 정정을 반영한다 — 8/10 기관·개인이 각 7,100(백만원)씩 옮겨간 적이
        있다. <strong>장중 추정 카드는 다른 물건이다</strong>: 대금이 아니라 수량, 개인 없이
        외국인·기관만, 그리고 가집계다. 8/11 마감 구간은 외국인 −345,000주로 나왔는데 확정치는
        −2,998억(≈ −21만주)이었다 — 방향만 읽고 크기는 믿지 말 것.
      </p>
    </section>
  );
}
