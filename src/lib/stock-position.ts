/**
 * 긴 지평의 답 — 방향이 아니라 **위치**.
 *
 * 왜 방향을 안 내나: 6달 지평 예측은 한 종목에서 연 2표본, 1년은 연 1표본이다.
 * 검증에 14~30년이 걸리는 화살표는 영원히 미검증으로 남고, 미검증 화살표는 없느니만
 * 못하다 (horizon-board.ts의 표본 수학 참고).
 *
 * 대신 **오늘 확인 가능한 사실**을 답한다. "PBR이 이력 밴드의 하위 15%"는 예측이 아니라
 * 관측이라 지금 맞는지 틀린지 알 수 있다. 긴 지평에서 사람이 실제로 알고 싶은 것도
 * "지금 싼가 비싼가, 실적은 어느 방향인가"에 가깝지 내년 종가 자체가 아니다.
 *
 * 밴드는 **우리가 가진 이력 안에서만** 잰다. 271거래일이면 1년치라, "5년 밴드의 하위"
 * 같은 말은 할 수 없다. 몇 거래일 기준인지 항상 같이 내보낸다.
 */

export interface QuarterPoint {
  period: string; // YYYYMM
  roe: number;
  eps: number;
  bps: number;
  operatingProfitGrowthPct: number;
  salesGrowthPct: number;
}

export interface BandPosition {
  key: 'pbr' | 'per';
  label: string;
  current: number;
  /** 이력 분포에서 몇 %ile인가 (0=가장 쌈, 100=가장 비쌈) */
  percentile: number;
  low: number;
  high: number;
  /** 몇 거래일치 이력으로 잰 값인가 — 밴드의 신뢰를 정하는 수 */
  sampleDays: number;
  reading: string;
}

export interface EarningsTrend {
  /** 최근 분기부터 과거로. 화면엔 4개까지만 */
  points: QuarterPoint[];
  /** 영업이익 증가율이 몇 분기 연속 플러스인가 (음수면 연속 마이너스) */
  streak: number;
  reading: string;
}

export interface StockPosition {
  bands: BandPosition[];
  earnings: EarningsTrend | null;
  /** 한 줄 요약 — 방향이 아니라 위치 서술이다 */
  headline: string;
  caveats: string[];
  /**
   * 지평별로 **다른 면**을 보여주기 위한 것. 같은 PBR·ROE 문장을 2달·6달·1년 칸에
   * 세 번 쓰면 그건 정보가 아니라 소음이다. 지평이 길수록 느리게 움직이는 지표를 준다.
   */
  facets: Record<string, { short: string; long: string }>;
}

const pctile = (values: number[], v: number): number =>
  Math.round((values.filter((x) => x <= v).length / values.length) * 100);

function bandReading(p: number): string {
  if (p <= 10) return '이력 중 가장 싼 구간';
  if (p <= 30) return '이력 대비 싼 편';
  if (p >= 90) return '이력 중 가장 비싼 구간';
  if (p >= 70) return '이력 대비 비싼 편';
  return '이력의 중간쯤';
}

/**
 * @param closes 일별 종가 (오래된→최신)
 * @param quarters 분기 재무 (최신순)
 * @param currentPer 지금 PER (스냅샷). null이면 PER 밴드를 뺀다.
 */
export function computeStockPosition(
  closes: number[],
  quarters: QuarterPoint[],
  currentPer: number | null,
): StockPosition | null {
  if (closes.length < 60 || quarters.length === 0) return null;
  const last = closes[closes.length - 1]!;
  const caveats: string[] = [];
  const bands: BandPosition[] = [];

  // PBR 밴드 — 분기 BPS를 그 분기 이후 종가에 붙여 시계열을 만든다.
  // BPS는 분기마다 바뀌므로 종가 하나에 최신 BPS를 곱하는 건 틀린다.
  const asc = [...quarters].reverse().filter((q) => q.bps > 0);
  if (asc.length > 0) {
    const bpsFor = (idx: number): number => {
      // 대략적 매핑: 이력 구간을 분기 수로 균등 분할한다. 정확한 발표일이 없어서
      // 근사이고, 그래서 "밴드 위치"까지만 말하고 절대 PBR을 단정하지 않는다.
      const share = Math.floor((idx / closes.length) * asc.length);
      return asc[Math.min(share, asc.length - 1)]!.bps;
    };
    const series = closes.map((c, i) => c / bpsFor(i)).filter((x) => Number.isFinite(x) && x > 0);
    if (series.length >= 60) {
      const cur = last / asc[asc.length - 1]!.bps;
      const p = pctile(series, cur);
      bands.push({
        key: 'pbr',
        label: 'PBR',
        current: Number(cur.toFixed(2)),
        percentile: p,
        low: Number(Math.min(...series).toFixed(2)),
        high: Number(Math.max(...series).toFixed(2)),
        sampleDays: series.length,
        reading: bandReading(p),
      });
      caveats.push('분기 BPS 발표일을 몰라 구간을 균등 분할해 근사했다 — 밴드 위치까지만 볼 것');
    }
  }

  if (currentPer !== null && currentPer > 0) {
    // PER 이력은 분기 EPS로 만들면 적자 분기에서 부호가 뒤집혀 쓸 수 없다.
    // 지금 값만 내보내고 밴드는 만들지 않는다.
    caveats.push('PER은 적자 분기가 섞이면 이력 밴드가 성립하지 않아 현재값만 본다');
  }

  // 실적 추세 — 영업이익 증가율의 연속 부호
  const recent = quarters.slice(0, 8);
  let streak = 0;
  for (const q of recent) {
    const v = q.operatingProfitGrowthPct;
    if (v === 0) break; // 0은 미공시로 오는 경우가 있어 연속을 끊는다
    if (streak === 0) streak = v > 0 ? 1 : -1;
    else if (v > 0 && streak > 0) streak++;
    else if (v < 0 && streak < 0) streak--;
    else break;
  }
  const latest = quarters[0]!;
  const earnings: EarningsTrend = {
    points: recent.slice(0, 4),
    streak,
    reading:
      streak >= 2
        ? `영업이익이 ${streak}분기 연속 늘었다`
        : streak <= -2
          ? `영업이익이 ${-streak}분기 연속 줄었다`
          : '영업이익 방향이 일정하지 않다',
  };

  const pbr = bands.find((b) => b.key === 'pbr');
  const headline = [
    pbr ? `PBR ${pbr.current}배 — ${pbr.reading}(하위 ${pbr.percentile}%)` : null,
    `ROE ${latest.roe}%`,
    earnings.reading,
  ]
    .filter(Boolean)
    .join(' · ');

  const pbrTxt = pbr
    ? `PBR ${pbr.current}배 · 하위 ${pbr.percentile}%`
    : 'PBR 밴드 계산 불가';
  const drawdown = ((last / Math.max(...closes) - 1) * 100).toFixed(1);
  const facets: StockPosition['facets'] = {
    // 2달 — 다음 분기 실적이 지배하는 구간
    m2: {
      short:
        streak >= 2
          ? `영업이익 ${streak}분기 연속 ↑`
          : streak <= -2
            ? `영업이익 ${-streak}분기 연속 ↓`
            : '영업이익 방향 일정치 않음',
      long: `다음 분기 실적이 지배하는 구간이다. ${earnings.reading} (최근 ROE ${latest.roe}%, 영업이익 증가율 ${latest.operatingProfitGrowthPct}%). 실적 방향이 바뀌면 이 칸이 먼저 바뀐다.`,
    },
    // 6달 — 밸류에이션이 지배
    m6: {
      short: pbrTxt,
      long: pbr
        ? `${pbrTxt} — ${pbr.reading}. 우리가 가진 ${pbr.sampleDays}거래일 안에서 잰 것이라 "역사적 저평가"라고는 말할 수 없다. 밴드 ${pbr.low}~${pbr.high}배.`
        : 'BPS 이력이 부족해 밴드를 못 만든다.',
    },
    // 1년 — 사이클 위치
    y1: {
      short: `고점 대비 ${drawdown}%`,
      long: `이력 고점 대비 ${drawdown}%. ROE는 ${latest.roe}%로 ${quarters.filter((q) => q.roe < latest.roe).length}/${quarters.length}분기보다 높다. 1년 뒤는 메모리 사이클이 지배하는데 그 재료(현물가·설비투자)는 아직 안 모은다.`,
    },
  };

  return { bands, earnings, headline, caveats, facets };
}
