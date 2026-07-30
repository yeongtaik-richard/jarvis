/**
 * 결정론적 지표·국면 계산. **DB를 모르는 순수 함수**만 둔다 (테스트·재현 용이).
 *
 * ⚠️ 여기서 나오는 라벨은 **과거 데이터의 서술**이다. "하락 추세"는 지금까지 내려왔다는
 * 뜻이고 앞으로 내려간다는 뜻이 아니다. 예측·매매 판단은 이 모듈의 일이 아니며,
 * 규칙과 임계값이 코드에 드러나 있어야 나중에 적중률을 채점할 수 있다
 * (docs/stock.md §정직성 규칙).
 */

export interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 벤치마크 종가 시계열. 종목과 같은 거래일 축을 쓴다. */
export interface BenchmarkSeries {
  key: string; // 'sox' | 'samsung' | 'kospi' ...
  label: string;
  bars: { date: string; close: number }[];
  /**
   * 벤치마크 구성에 **종목 자신이 들어가는가.** KOSPI·업종지수는 하이닉스 비중이 커서
   * 지수가 종목 때문에 움직인다 → 초과수익이 축소 편향된다. SOX·삼성전자처럼 종목이
   * 안 들어간 벤치마크만 상대강도를 액면대로 읽을 수 있다.
   */
  containsStock: boolean;
}

export interface RelativeStrength {
  key: string;
  label: string;
  contains_stock: boolean;
  /** 종목 수익률 − 벤치마크 수익률 (%p). 양수면 벤치마크보다 덜 빠지거나 더 올랐다. */
  excess_5d: number | null;
  excess_20d: number | null;
  excess_60d: number | null;
  stock_20d_pct: number | null;
  benchmark_20d_pct: number | null;
  /**
   * **벤치마크를 종목으로 회귀**한 계수와 R². 순환 정도를 수치로 드러내려고 같이 준다.
   * 2026-07-30 실측: KOSPI 0.51/R² 0.78, 전기·전자 0.72/R² 0.86 —
   * 즉 KOSPI 일간 변동의 78%가 하이닉스 하나로 설명된다.
   */
  index_on_stock_beta: number | null;
  index_on_stock_r2: number | null;
  overlap_days: number;
}

export interface Flow {
  date: string;
  foreign: number; // 순매수 대금 (백만원)
  institution: number;
  individual: number;
}

// ── 임계값. 바꾸면 국면 라벨이 바뀌므로 근거를 함께 남길 것. ──────────────────
/** 추세 판정에서 '가격이 MA에 붙어 있다'고 볼 허용 범위(%). 이 안이면 횡보로 본다. */
const TREND_FLAT_PCT = 3;
/** 변동성 백분위 구간 경계. */
const VOL_CALM = 25;
const VOL_ELEVATED = 75;
const VOL_EXTREME = 90;
/** 수급 방향을 '연속'으로 부르기 위한 최소 거래일. */
const FLOW_STREAK_MIN = 2;

export interface Indicators {
  trading_days: number;
  as_of: string;
  close: number;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  dist_ma20_pct: number | null;
  dist_ma60_pct: number | null;
  dist_ma120_pct: number | null;
  peak_250: number | null;
  drawdown_pct: number | null;
  consecutive_down_days: number;
  consecutive_up_days: number;
  vol20_pct: number | null;
  /** 20일 실현변동성이 보유 이력 분포에서 몇 %ile인지. 표본이 짧으면 null. */
  vol20_percentile: number | null;
  /** 최근 5일 평균 거래량 / 60일 평균 거래량. */
  volume_ratio: number | null;
  foreign_net_20d: number | null; // 백만원
  institution_net_20d: number | null;
  individual_net_20d: number | null;
  foreign_streak_days: number; // 같은 방향 연속 (양수=순매수, 음수=순매도)
  /** 벤치마크 대비 초과수익. 벤치마크가 없으면 빈 배열. */
  relative: RelativeStrength[];
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function sd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

const round = (n: number, d = 1) => Number(n.toFixed(d));

/**
 * 기간 수익률(%). 표본이 창보다 짧으면 null — 3일치로 20일 수익률을 만들지 않는다.
 * 날짜 축이 어긋난 벤치마크를 그냥 붙이면 초과수익이 거짓이 되므로, 비교는 **종목의
 * 시작·끝 거래일과 같은 날짜가 벤치마크에도 있을 때만** 한다.
 */
function pctChange(series: { date: string; close: number }[], days: number): number | null {
  if (series.length < days + 1) return null;
  const from = series[series.length - 1 - days]!;
  const to = series[series.length - 1]!;
  if (!from.close) return null;
  return (to.close / from.close - 1) * 100;
}

/** 두 시계열의 공통 거래일에서 일간 수익률 쌍을 만든다. */
function alignedReturns(
  a: { date: string; close: number }[],
  b: { date: string; close: number }[],
): { ra: number[]; rb: number[] } {
  const mb = new Map(b.map((x) => [x.date, x.close]));
  const dates = a.filter((x) => mb.has(x.date)).map((x) => x.date);
  const ma = new Map(a.map((x) => [x.date, x.close]));
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const p0 = ma.get(dates[i - 1]!)!;
    const p1 = ma.get(dates[i]!)!;
    const q0 = mb.get(dates[i - 1]!)!;
    const q1 = mb.get(dates[i]!)!;
    if (!p0 || !q0) continue;
    ra.push(p1 / p0 - 1);
    rb.push(q1 / q0 - 1);
  }
  return { ra, rb };
}

function covar(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  return mean(a.map((x, i) => (x - ma) * (b[i]! - mb)));
}

/**
 * `date` 이하의 가장 최근 세션(as-of). 미국 지수는 KRX와 달력이 달라 — 시차로 KRX '오늘'
 * 세션이 아직 없고 휴장일도 다르다 — 정확 일치를 요구하면 크로스마켓 비교가 항상 실패한다.
 * 5일 이상 벌어지면 다른 구간을 비교하는 셈이라 포기한다(연휴보다 긴 갭은 데이터 구멍).
 */
function asOf(
  series: { date: string; close: number }[],
  date: string,
): { date: string; close: number } | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i]!.date <= date) {
      const gap =
        (Date.parse(date) - Date.parse(series[i]!.date)) / 86_400_000;
      return gap <= 5 ? series[i]! : null;
    }
  }
  return null;
}

function excess(
  stock: { date: string; close: number }[],
  bench: { date: string; close: number }[],
  days: number,
): number | null {
  if (stock.length < days + 1) return null;
  const startDate = stock[stock.length - 1 - days]!.date;
  const endDate = stock[stock.length - 1]!.date;
  const bStart = asOf(bench, startDate);
  const bEnd = asOf(bench, endDate);
  if (!bStart || !bEnd || !bStart.close || bStart.date === bEnd.date) return null;
  const s = pctChange(stock, days);
  if (s === null) return null;
  return round(s - (bEnd.close / bStart.close - 1) * 100);
}

/** `bars`는 **오래된 것부터** 정렬돼 있어야 한다. */
export function computeIndicators(
  bars: Bar[],
  flows: Flow[] = [],
  benchmarks: BenchmarkSeries[] = [],
): Indicators | null {
  if (!bars.length) return null;
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const last = closes[n - 1]!;

  // 표본이 창 길이보다 짧으면 평균을 내지 않는다 — MA20을 5일로 계산해 놓고
  // MA20이라 부르면 이후 모든 판단이 조용히 틀어진다.
  const ma = (k: number): number | null =>
    n >= k ? mean(closes.slice(-k)) : null;
  const dist = (m: number | null): number | null =>
    m === null ? null : round((last / m - 1) * 100);

  const rets = closes.slice(1).map((c, i) => (c - closes[i]!) / closes[i]!);
  const vol20 = rets.length >= 20 ? sd(rets.slice(-20)) : null;

  // 20일 변동성의 과거 분포 대비 위치. 창이 30개는 모여야 백분위가 의미를 가진다.
  let volPct: number | null = null;
  if (vol20 !== null) {
    const hist: number[] = [];
    for (let i = 20; i <= rets.length; i++) hist.push(sd(rets.slice(i - 20, i)));
    if (hist.length >= 30) {
      volPct = round((hist.filter((x) => x <= vol20).length / hist.length) * 100, 0);
    }
  }

  let down = 0;
  for (let i = n - 1; i > 0; i--) {
    if (closes[i]! < closes[i - 1]!) down++;
    else break;
  }
  let up = 0;
  for (let i = n - 1; i > 0; i--) {
    if (closes[i]! > closes[i - 1]!) up++;
    else break;
  }

  const vols = bars.map((b) => b.volume);
  const volumeRatio =
    n >= 60 ? round(mean(vols.slice(-5)) / mean(vols.slice(-60)), 2) : null;

  const window250 = closes.slice(-250);
  const peak = window250.length ? Math.max(...window250) : null;

  // 수급: 오래된 것부터 정렬 후 최근 20거래일
  const f = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const recent = f.slice(-20);
  const sum = (pick: (x: Flow) => number) =>
    recent.length ? Math.round(recent.reduce((a, b) => a + pick(b), 0)) : null;

  let streak = 0;
  if (f.length) {
    const sign = Math.sign(f[f.length - 1]!.foreign);
    for (let i = f.length - 1; i >= 0; i--) {
      if (Math.sign(f[i]!.foreign) === sign && sign !== 0) streak++;
      else break;
    }
    streak *= sign;
  }

  return {
    trading_days: n,
    as_of: bars[n - 1]!.date,
    close: last,
    ma5: ma(5) === null ? null : Math.round(ma(5)!),
    ma20: ma(20) === null ? null : Math.round(ma(20)!),
    ma60: ma(60) === null ? null : Math.round(ma(60)!),
    ma120: ma(120) === null ? null : Math.round(ma(120)!),
    dist_ma20_pct: dist(ma(20)),
    dist_ma60_pct: dist(ma(60)),
    dist_ma120_pct: dist(ma(120)),
    peak_250: peak,
    drawdown_pct: peak === null ? null : round((last / peak - 1) * 100),
    consecutive_down_days: down,
    consecutive_up_days: up,
    vol20_pct: vol20 === null ? null : round(vol20 * 100, 2),
    vol20_percentile: volPct,
    volume_ratio: volumeRatio,
    foreign_net_20d: sum((x) => x.foreign),
    institution_net_20d: sum((x) => x.institution),
    individual_net_20d: sum((x) => x.individual),
    foreign_streak_days: streak,
    relative: benchmarks.map((b) => {
      const series = [...b.bars].sort((x, y) => x.date.localeCompare(y.date));
      const stock = bars.map((x) => ({ date: x.date, close: x.close }));
      // 순환 정도: 벤치마크 수익률을 종목 수익률로 회귀한다.
      const { ra: rStock, rb: rBench } = alignedReturns(stock, series);
      let beta: number | null = null;
      let r2: number | null = null;
      if (rStock.length >= 30 && covar(rStock, rStock) > 0) {
        beta = round(covar(rBench, rStock) / covar(rStock, rStock), 3);
        const denom = Math.sqrt(covar(rStock, rStock) * covar(rBench, rBench));
        if (denom > 0) r2 = round((covar(rStock, rBench) / denom) ** 2, 3);
      }
      const s20 = pctChange(stock, 20);
      const b20 =
        series.length && s20 !== null
          ? (() => {
              const startDate = stock[stock.length - 1 - 20]?.date;
              const endDate = stock[stock.length - 1]?.date;
              const bs = startDate ? asOf(series, startDate) : null;
              const be = endDate ? asOf(series, endDate) : null;
              return bs && be && bs.close && bs.date !== be.date
                ? round((be.close / bs.close - 1) * 100)
                : null;
            })()
          : null;
      return {
        key: b.key,
        label: b.label,
        contains_stock: b.containsStock,
        excess_5d: excess(stock, series, 5),
        excess_20d: excess(stock, series, 20),
        excess_60d: excess(stock, series, 60),
        stock_20d_pct: s20 === null ? null : round(s20),
        benchmark_20d_pct: b20,
        index_on_stock_beta: beta,
        index_on_stock_r2: r2,
        overlap_days: rStock.length,
      };
    }),
  };
}

export type Trend = 'up' | 'down' | 'sideways' | 'unknown';
export type Volatility = 'calm' | 'normal' | 'elevated' | 'extreme' | 'unknown';
export type FlowState = 'foreign_buying' | 'foreign_selling' | 'mixed' | 'unknown';

export interface Regime {
  trend: Trend;
  volatility: Volatility;
  flow: FlowState;
  /** 사람이 읽는 한 줄. 예: "하락 추세 · 변동성 극단(96%ile) · 외국인 순매도 4일" */
  label: string;
  /** 각 판정의 근거가 된 실제 숫자. 라벨만 믿지 말고 이걸 보게 하려고 같이 준다. */
  reasons: string[];
  /** 이 라벨은 예측이 아니라는 사실을 소비하는 쪽에 강제로 노출시킨다. */
  disclaimer: string;
}

const TREND_LABEL: Record<Trend, string> = {
  up: '상승 추세',
  down: '하락 추세',
  sideways: '횡보',
  unknown: '추세 판단 불가',
};
const VOL_LABEL: Record<Volatility, string> = {
  calm: '변동성 낮음',
  normal: '변동성 보통',
  elevated: '변동성 높음',
  extreme: '변동성 극단',
  unknown: '변동성 판단 불가',
};

/**
 * 규칙 기반 국면 분류. 규칙은 이 함수 안에 전부 드러나 있다.
 *
 * - 추세: 가격이 MA20에서 ±3% 밖이고 MA20과 MA60의 순서가 같은 방향일 때만 추세로 본다.
 *   (둘이 어긋나면 횡보 — 최근 급반전 구간에서 방향을 단정하지 않기 위함)
 * - 변동성: 20일 실현변동성의 **자기 이력 백분위**로만 판단한다. 절대 %는 종목마다
 *   기준이 달라 비교가 안 된다.
 * - 수급: 외국인 20일 누적 부호 + 같은 방향 연속일. 기관과 방향이 갈리면 mixed.
 */
export function classifyRegime(ind: Indicators | null): Regime | null {
  if (!ind) return null;
  const reasons: string[] = [];

  let trend: Trend = 'unknown';
  if (ind.ma20 !== null && ind.ma60 !== null && ind.dist_ma20_pct !== null) {
    const near = Math.abs(ind.dist_ma20_pct) <= TREND_FLAT_PCT;
    const stacked = Math.sign(ind.ma20 - ind.ma60);
    if (near || stacked === 0) trend = 'sideways';
    else if (ind.dist_ma20_pct > 0 && stacked > 0) trend = 'up';
    else if (ind.dist_ma20_pct < 0 && stacked < 0) trend = 'down';
    else trend = 'sideways'; // 가격 방향과 MA 배열이 어긋남 → 단정하지 않는다
    reasons.push(
      `종가가 MA20 대비 ${ind.dist_ma20_pct > 0 ? '+' : ''}${ind.dist_ma20_pct}%, MA20 ${
        stacked > 0 ? '>' : stacked < 0 ? '<' : '='
      } MA60`,
    );
  } else {
    reasons.push(`이력 ${ind.trading_days}거래일 — MA20/MA60을 채우지 못했다`);
  }

  let volatility: Volatility = 'unknown';
  if (ind.vol20_percentile !== null) {
    volatility =
      ind.vol20_percentile >= VOL_EXTREME
        ? 'extreme'
        : ind.vol20_percentile >= VOL_ELEVATED
          ? 'elevated'
          : ind.vol20_percentile <= VOL_CALM
            ? 'calm'
            : 'normal';
    reasons.push(
      `20일 실현변동성 ${ind.vol20_pct}% (보유 이력 ${ind.vol20_percentile}%ile)`,
    );
  }

  let flow: FlowState = 'unknown';
  if (ind.foreign_net_20d !== null) {
    const streak = ind.foreign_streak_days;
    const enough = Math.abs(streak) >= FLOW_STREAK_MIN;
    if (ind.foreign_net_20d < 0 && enough && streak < 0) flow = 'foreign_selling';
    else if (ind.foreign_net_20d > 0 && enough && streak > 0) flow = 'foreign_buying';
    else flow = 'mixed';
    const tril = (v: number) => `${(v / 1_000_000).toFixed(2)}조`;
    reasons.push(
      `외국인 20일 누적 ${ind.foreign_net_20d < 0 ? '순매도' : '순매수'} ${tril(
        Math.abs(ind.foreign_net_20d),
      )}, 최근 ${Math.abs(streak)}거래일 연속 ${streak < 0 ? '순매도' : '순매수'}`,
    );
    if (ind.institution_net_20d !== null) {
      reasons.push(
        `기관 20일 누적 ${ind.institution_net_20d < 0 ? '순매도' : '순매수'} ${tril(
          Math.abs(ind.institution_net_20d),
        )}`,
      );
    }
  }

  if (ind.drawdown_pct !== null) {
    reasons.push(`250일 고점(${ind.peak_250?.toLocaleString('ko-KR')}) 대비 ${ind.drawdown_pct}%`);
  }
  if (ind.volume_ratio !== null) {
    reasons.push(`최근 5일 거래량이 60일 평균의 ${ind.volume_ratio}배`);
  }
  // 종목이 안 들어간 벤치마크를 먼저 보여준다 — 이쪽이 액면대로 읽을 수 있는 값이다.
  for (const r of [...ind.relative].sort((a, b) => Number(a.contains_stock) - Number(b.contains_stock))) {
    if (r.excess_20d === null) continue;
    const base = `${r.label} 대비 20일 초과수익 ${r.excess_20d > 0 ? '+' : ''}${r.excess_20d}%p (종목 ${r.stock_20d_pct}% vs ${r.benchmark_20d_pct}%)`;
    if (r.contains_stock && r.index_on_stock_r2 !== null) {
      // 순환 비교라는 사실을 숫자와 함께 붙인다. 이 문구 없이 인용되면 오독된다.
      reasons.push(
        `${base} — 단, 이 지수는 종목을 포함한다(지수를 종목으로 회귀: 계수 ${r.index_on_stock_beta}, R² ${r.index_on_stock_r2}) → 초과수익이 축소 편향`,
      );
    } else {
      reasons.push(base);
    }
  }

  const parts = [TREND_LABEL[trend]];
  if (volatility !== 'unknown') {
    parts.push(`${VOL_LABEL[volatility]}(${ind.vol20_percentile}%ile)`);
  }
  if (flow === 'foreign_selling' || flow === 'foreign_buying') {
    parts.push(
      `외국인 ${flow === 'foreign_selling' ? '순매도' : '순매수'} ${Math.abs(
        ind.foreign_streak_days,
      )}일`,
    );
  }

  return {
    trend,
    volatility,
    flow,
    label: parts.join(' · '),
    reasons,
    disclaimer:
      '과거 데이터의 서술이다. 앞으로의 방향을 뜻하지 않으며 매매 판단이 아니다.',
  };
}
