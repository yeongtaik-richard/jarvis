import { getStockHistory } from './stock-service';
import {
  classifyRegime,
  computeIndicators,
  type Bar,
  type Flow,
  type Indicators,
  type Regime,
} from './stock-indicators';

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
  const [ohlcv, flowRows] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', days),
    getStockHistory(symbol, 'investor_flow', days),
  ]);

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

  const indicators = computeIndicators(bars, flows);
  return { symbol, indicators, regime: classifyRegime(indicators) };
}
