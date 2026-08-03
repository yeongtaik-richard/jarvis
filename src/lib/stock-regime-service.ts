import { getStockHistory } from './stock-service';
import {
  classifyRegime,
  computeIndicators,
  type Bar,
  type BenchmarkSeries,
  type Flow,
  type FxSeries,
  type Indicators,
  type Regime,
} from './stock-indicators';

/**
 * 환율은 벤치마크가 아니라 매크로 지표다 — 초과수익 비교 대상이 아니므로 BENCHMARKS와
 * 분리한다. up_means/down_means는 오독 방지용: USD/JPY **하락**이 엔 **강세**다
 * (엔캐리 청산 압력은 엔 강세 쪽에서 커진다).
 */
const FX: { metric: string; key: string; label: string; up: string; down: string }[] = [
  { metric: 'fx_usdjpy', key: 'usdjpy', label: 'USD/JPY', up: '엔 약세', down: '엔 강세' },
  { metric: 'fx_usdkrw', key: 'usdkrw', label: 'USD/KRW', up: '원 약세', down: '원 강세' },
];

/**
 * 수집기의 `benchmark_*` metric ↔ 화면 라벨.
 *
 * `containsStock`이 핵심이다. 하이닉스는 KOSPI·전기전자 지수에서 비중이 커서
 * (2026-07-30 실측: 지수를 종목으로 회귀했을 때 KOSPI 계수 0.51·R² 0.78,
 * 전기·전자 0.72·R² 0.86) 그 지수 대비 초과수익은 자기 자신을 뺀 나머지와 비교하는
 * 셈이라 **축소 편향**된다. 액면대로 읽을 수 있는 건 종목이 안 들어간 SOX·삼성전자·나스닥뿐.
 * 오염된 벤치마크도 지우지 않고 남긴다 — 회귀계수 자체가 "지수가 종목에 끌려간다"는 정보다.
 */
const BENCHMARKS: {
  metric: string;
  key: string;
  label: string;
  containsStock: boolean;
}[] = [
  { metric: 'benchmark_sox', key: 'sox', label: '필라델피아 반도체(SOX)', containsStock: false },
  { metric: 'benchmark_samsung', key: 'samsung', label: '삼성전자', containsStock: false },
  { metric: 'benchmark_nasdaq', key: 'nasdaq', label: '나스닥 종합', containsStock: false },
  { metric: 'benchmark_kospi', key: 'kospi', label: 'KOSPI', containsStock: true },
  { metric: 'benchmark_electronics', key: 'electronics', label: '전기·전자 업종', containsStock: true },
];

export type RegimeResult = {
  symbol: string;
  indicators: Indicators | null;
  regime: Regime | null;
};

const num = (payload: unknown, key: string): number => {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * 저장된 스냅샷에서 국면을 **매번 계산한다.** 결과를 따로 저장하지 않는 이유:
 * 파생값이라 원천 데이터와 어긋나면 그게 곧 버그이고, 규칙을 고치는 순간 저장분은
 * 전부 낡은 값이 된다. 269일 계산은 밀리초 단위라 캐싱할 이유도 없다.
 */
export async function getStockRegime(symbol: string, days = 300): Promise<RegimeResult> {
  const [ohlcv, flowRows, ...rest] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', days),
    getStockHistory(symbol, 'investor_flow', days),
    ...BENCHMARKS.map((b) => getStockHistory(symbol, b.metric, days)),
    ...FX.map((f) => getStockHistory(symbol, f.metric, days)),
  ]);
  const benchRows = rest.slice(0, BENCHMARKS.length);
  const fxRows = rest.slice(BENCHMARKS.length);

  const bars: Bar[] = ohlcv
    .map((r) => ({
      date: r.bucketKey,
      close: num(r.payload, 'close'),
      high: num(r.payload, 'high'),
      low: num(r.payload, 'low'),
      volume: num(r.payload, 'volume'),
    }))
    .filter((b) => Number.isFinite(b.close));

  const flows: Flow[] = flowRows
    .map((r) => ({
      date: r.bucketKey,
      foreign: num(r.payload, 'foreign_net'),
      institution: num(r.payload, 'institution_net'),
      individual: num(r.payload, 'individual_net'),
    }))
    .filter((f) => Number.isFinite(f.foreign));

  // 아직 수집 안 된 벤치마크는 빈 시계열이 되고, 지표 쪽에서 null로 떨어진다.
  const benchmarks: BenchmarkSeries[] = BENCHMARKS.map((b, i) => ({
    key: b.key,
    label: b.label,
    containsStock: b.containsStock,
    bars: (benchRows[i] ?? [])
      .map((r) => ({ date: r.bucketKey, close: num(r.payload, 'close') }))
      .filter((x) => Number.isFinite(x.close)),
  })).filter((b) => b.bars.length > 0);

  const fxSeries: FxSeries[] = FX.map((f, i) => ({
    key: f.key,
    label: f.label,
    up_means: f.up,
    down_means: f.down,
    bars: (fxRows[i] ?? [])
      .map((r) => ({ date: r.bucketKey, close: num(r.payload, 'close') }))
      .filter((x) => Number.isFinite(x.close) && x.close > 0),
  }));

  const indicators = computeIndicators(bars, flows, benchmarks, fxSeries);
  return { symbol, indicators, regime: classifyRegime(indicators) };
}
