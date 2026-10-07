/**
 * 테마 ETF 일봉 수집기.
 *
 * `collect-stock.ts`와 **일부러 분리했다.** 저쪽은 한 종목에 대해 수급·밸류에이션·
 * 벤치마크·공시까지 받는 복잡한 파이프라인이고, 벤치마크를 `symbol='000660'` 아래
 * metric으로 저장하는 등 단일 종목을 전제한 구조가 섞여 있다. 거기에 다종목 루프를
 * 끼워 넣으면 돌아가는 파이프라인을 건드리게 된다. 이쪽은 **일봉만** 받는다.
 *
 * 저장은 기존 스냅샷 API를 그대로 쓴다 — 자연키가 `(symbol, source, metric,
 * bucket_key)`라 ETF는 그냥 다른 symbol이다. 스키마 변경이 필요 없다.
 *
 * Usage:
 *   pnpm collect:etf                  # 최근 확정일만
 *   pnpm collect:etf --backfill=900   # 900일치 백필 (2년 3개월)
 *   gh workflow run collect-etf.yml -f backfill_days=900
 *
 * Env: KIS_APP_KEY, KIS_APP_SECRET, JARVIS_API_TOKEN, JARVIS_BASE_URL
 */

import { randomUUID } from 'node:crypto';
import {
  currentQuote,
  dailyCandles,
  dailyCandlesRange,
  domesticBusinessDays,
  investorFlows,
  overseasStockDaily,
  type KisCreds,
} from '../src/lib/kis-marketdata';
import { getKisToken } from '../src/lib/kis-token-cache';
import { THEME_UNIVERSE, type ThemeEtf } from '../src/lib/theme-universe';

const BASE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';
const KST = 9 * 3600 * 1000;

function ymd(kisDate: string): string {
  return `${kisDate.slice(0, 4)}-${kisDate.slice(4, 6)}-${kisDate.slice(6, 8)}`;
}
function kstDay(daysAgo = 0): { compact: string; dashed: string } {
  const s = new Date(Date.now() + KST - daysAgo * 86400000).toISOString().slice(0, 10);
  return { compact: s.replace(/-/g, ''), dashed: s };
}
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function backfillDays(): number {
  const arg = process.argv
    .slice(2)
    .find((a) => a === '--backfill' || a.startsWith('--backfill='));
  const raw = arg ? (arg.split('=')[1] ?? '30') : (process.env.ETF_BACKFILL_DAYS ?? '0');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid backfill days: ${raw}`);
  return Math.min(Math.floor(n), 1500);
}

/**
 * 유니버스 전체를 받는다 — 테마도 기준선(나스닥100·S&P500)도.
 *
 * 한때 `--pending`으로 일부를 빼는 분기가 있었다. 로테이션 백테스트가 공통 구간을
 * 필요로 해서 어린 ETF를 제외해야 했기 때문인데, 추이 보드로 방향을 틀면서 그 제약이
 * 사라졌다. 각자 가진 만큼만 그리면 된다.
 */
function universe(): ThemeEtf[] {
  return THEME_UNIVERSE;
}

// KRX 정규장 마감 + 종가단일가 정리. 이 시각 전의 "오늘"은 확정 일봉이 아니다.
const SETTLE_HOUR_KST = 16;
function todaySettled(): boolean {
  return new Date(Date.now() + KST).getUTCHours() >= SETTLE_HOUR_KST;
}

/**
 * 장중 버킷 = KST 정시(`YYYY-MM-DDTHH:00+09:00`).
 *
 * 조회 시각이 아니라 **정시로 내려** 저장한다. cron이 13:00 예정인데 13:17에 떠도
 * `13:00` 버킷 하나로 덮어쓰므로, 재시도하거나 수동 실행을 겹쳐도 점이 늘지 않는다.
 * 실제 조회 시각은 `as_of_at`에 남아 정보가 사라지지도 않는다. 000660 수집기와 같은
 * 규약이라 두 파이프라인의 장중 데이터가 같은 격자에 놓인다.
 */
function kstHourBucket(at: Date): string {
  const kst = new Date(at.getTime() + KST);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  return `${kst.toISOString().slice(0, 10)}T${hh}:00+09:00`;
}

/** 장중 수집 창 — 09:00~16:30 KST. 그 밖에는 호출할 이유가 없다. */
function intradayWindow(): boolean {
  const kst = new Date(Date.now() + KST);
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 9 * 60 && min <= 16 * 60 + 30;
}
/** 15:30 이후 실행이면 그날 마지막 시간대(15:00) 버킷에 넣는다. */
function afterCloseNow(): boolean {
  const kst = new Date(Date.now() + KST);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes() > 15 * 60 + 30;
}

/**
 * 오늘 증시가 열리는가.
 *
 * **휴장일에 장중 수집을 돌리면 직전 장의 값이 오늘 것처럼 쌓인다.** 000660 쪽에서
 * 실제로 당한 사고다 — 2026-08-17(대체공휴일) 장중 버킷 6개가 전부 08-14 종가의
 * 복사본이었다. 요일만 보는 가드로는 안 막힌다.
 *
 * **판정을 못 하면 수집한다.** 달력 조회 실패로 정상 거래일 표본을 버리는 쪽이
 * 휴장일에 한 줄 더 쌓는 것보다 나쁘다.
 */
async function marketOpenToday(
  token: string,
  creds: KisCreds,
  today: { compact: string; dashed: string },
): Promise<boolean> {
  try {
    const days = await domesticBusinessDays(token, creds, today.compact, { maxPages: 1 });
    const row = days.find((d) => d.date === today.dashed);
    if (!row) {
      console.warn('[etf] 휴장일 판정: 달력에 오늘이 없다 — 수집을 진행한다');
      return true;
    }
    return row.openMarket;
  } catch (e) {
    console.warn(`[etf] 휴장일 판정 실패, 수집을 진행한다: ${String(e)}`);
    return true;
  }
}

interface SnapshotInput {
  symbol: string;
  source: string;
  metric: string;
  bucket_key: string;
  trading_date_kst: string;
  as_of_at?: string;
  collector_run_id: string;
  payload: Record<string, unknown>;
}

/** `--intraday` 또는 ETF_MODE=intraday → 현재가 한 점만 남기는 장중 모드. */
function isIntraday(): boolean {
  return process.argv.includes('--intraday') || process.env.ETF_MODE === 'intraday';
}

async function postSnapshot(token: string, snap: SnapshotInput): Promise<void> {
  const res = await fetch(`${BASE}/api/stock/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${snap.symbol} ${snap.bucket_key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const creds: KisCreds = {
    appKey: required('KIS_APP_KEY'),
    appSecret: required('KIS_APP_SECRET'),
  };
  const apiToken = required('JARVIS_API_TOKEN');
  const intraday = isIntraday();
  const backfill = intraday ? 0 : backfillDays();
  const etfs = universe();
  // 배치 묶음 키다. `collector_runs`에 짝이 되는 행은 **만들지 않는다** — 저 테이블은
  // `symbol` 단위 실행 기록인데 이 수집기는 한 번에 여러 종목을 돈다. 억지로 한 행에
  // 욱여넣으면 `/api/stock/health`의 종목별 생존 판정이 망가진다. 컬럼에 FK가 없어
  // (`drizzle/0004_stock_snapshots.sql`) 값만 남겨도 안전하고, "이 백필이 쓴 것"을
  // 조인 없이 추적하는 용도로는 그대로 쓸모가 있다.
  const runId = randomUUID();
  const today = kstDay();
  const settled = todaySettled();

  console.log(
    `[etf] run ${runId} · ${etfs.length} ETF · ` +
      `${intraday ? 'intraday' : backfill ? `backfill=${backfill}d` : 'latest only'}` +
      `${!intraday && !settled ? ' · 오늘은 미확정이라 제외' : ''}`,
  );

  const { token: kisToken, reused } = await getKisToken(creds, BASE, apiToken);
  console.log(`[etf] KIS token ${reused ? 'reused' : 'issued'}`);

  const errors: string[] = [];
  let posted = 0;

  // ── 장중 모드: 현재가 한 점만 남긴다. 일봉·수급은 장중에 확정이 아니라서 받아봐야
  //    버려지고 KIS 호출만 낭비된다. 미국 기초자산 ETF도 국내 거래소에서 원화로
  //    거래되므로 똑같이 받는다 — 움직임의 뜻(환율·괴리 섞임)은 화면이 'us' 라벨로
  //    이미 알려준다.
  if (intraday) {
    if (!intradayWindow()) {
      console.log('[etf] intraday: 수집 창(09:00~16:30 KST) 밖이라 수집하지 않음');
      return;
    }
    if (!(await marketOpenToday(kisToken, creds, today))) {
      console.log('[etf] intraday: 오늘은 휴장일이라 수집하지 않음');
      return;
    }
    // 마감 후 실행은 **15:00 버킷**에 넣는다. 현재 시각 버킷(16:00 등)에 넣으면 장이
    // 끝난 뒤에도 거래가 이어진 것처럼 궤적이 늘어난다.
    const bucket = afterCloseNow() ? `${today.dashed}T15:00+09:00` : kstHourBucket(new Date());
    for (const etf of etfs) {
      // 국내 현재가 API라 미국 상장은 못 받는다. 기초자산 장도 한국 장중엔 닫혀 있다.
      if (etf.overseas) continue;
      try {
        const at = new Date();
        const q = await currentQuote(kisToken, creds, etf.code);
        await postSnapshot(apiToken, {
          symbol: etf.code,
          source: 'kis',
          metric: 'intraday_price',
          bucket_key: bucket,
          trading_date_kst: today.dashed,
          as_of_at: at.toISOString(),
          collector_run_id: runId,
          payload: {
            price: q.price,
            change: q.change,
            change_rate: q.changeRate,
            open: q.open,
            high: q.high,
            low: q.low,
            volume: q.volume,
            amount_krw: q.amountKrw,
            amount_unit: 'krw',
            theme_key: etf.key,
            theme_label: etf.label,
            etf_name: etf.name,
            market: etf.market,
            kind: etf.kind,
          },
        });
        posted++;
      } catch (e) {
        errors.push(`${etf.code} intraday: ${String(e)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`[etf] intraday ${bucket}: ${posted}/${etfs.length}종목`);
    for (const e of errors.slice(0, 10)) console.error(`  ! ${e}`);
    if (posted === 0) process.exit(1);
    return;
  }

  for (const etf of etfs) {
    try {
      // 상장 전 구간을 달라고 하면 KIS가 빈 응답이나 엉뚱한 값을 줄 수 있어, 창을
      // 상장일로 잘라서 요청한다.
      const wantFrom = kstDay(Math.max(backfill, 15)).dashed;
      const from = wantFrom < etf.listedOn ? etf.listedOn : wantFrom;
      const start = from.replace(/-/g, '');

      // 미국 상장은 조회 API가 다르다. 기간 지정이 없어 **최근 100일 고정**으로 오는데,
      // 보드가 보는 창(3개월)에는 충분하다.
      const bars = etf.overseas
        ? await overseasStockDaily(kisToken, creds, etf.overseas.excd, etf.overseas.symb)
        : backfill
          ? await dailyCandlesRange(kisToken, creds, etf.code, start, today.compact, {
              maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
            })
          : await dailyCandles(kisToken, creds, etf.code, start, today.compact);

      // 오늘이 미확정이면 진행 중인 부분 봉이 섞여 들어온다 — 그대로 저장하면
      // 종가가 아닌 값이 종가 자리에 박힌다.
      const usable = bars.filter((b) => settled || ymd(b.date) !== today.dashed);
      if (!usable.length) {
        errors.push(`${etf.code} ${etf.name}: no bars`);
        continue;
      }

      // 오래된 것부터 올린다 — 중간에 실패해도 앞쪽 구간은 연속으로 남는다.
      const ordered = [...usable].sort((a, b) => a.date.localeCompare(b.date));
      for (const b of ordered) {
        const day = ymd(b.date);
        try {
          await postSnapshot(apiToken, {
            symbol: etf.code,
            source: 'kis',
            metric: 'daily_ohlcv',
            bucket_key: day,
            trading_date_kst: day,
            collector_run_id: runId,
            payload: {
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              // 테마 식별자를 payload에 같이 둔다 — 백테스트가 코드를 외우지 않아도
              // 되고, 나중에 ETF를 교체해도 테마 시계열이 이어진다.
              theme_key: etf.key,
              theme_label: etf.label,
              etf_name: etf.name,
              market: etf.market,
              kind: etf.kind,
            },
          });
          posted++;
        } catch (e) {
          errors.push(`${etf.code} ${day}: ${String(e)}`);
        }
      }
      console.log(
        `[etf] ${etf.code} ${etf.name}: ${ordered.length}일 ` +
          `(${ymd(ordered[0]!.date)}..${ymd(ordered.at(-1)!.date)})`,
      );
    } catch (e) {
      errors.push(`${etf.code} ${etf.name}: ${String(e)}`);
    }

    // 투자자별 순매수는 국내 조회 API라 미국 상장에는 안 쓴다.
    if (etf.overseas) continue;

    // ── 투자자별 순매수. ETF에도 **일별 수급은 나온다** (probe-etf.ts로 확인).
    //    장중 추정(investor-trend-estimate)은 ETF에서 빈 응답이라 아예 안 부른다 —
    //    같은 시각 개별 종목은 구간이 나오는데 ETF만 0이었으므로 미지원이 확실하다.
    //    KIS가 최근 30일만 주므로 백필 깊이와 무관하게 창이 고정이다.
    try {
      const flows = await investorFlows(kisToken, creds, etf.code);
      const usableFlows = flows.filter((f) => settled || ymd(f.date) !== today.dashed);
      for (const f of usableFlows) {
        const day = ymd(f.date);
        try {
          await postSnapshot(apiToken, {
            symbol: etf.code,
            source: 'kis',
            metric: 'investor_flow',
            bucket_key: day,
            trading_date_kst: day,
            collector_run_id: runId,
            payload: {
              close: f.close,
              amount_unit: 'million_krw', // 대금 단위: 백만원
              foreign_net: f.frgnNet,
              institution_net: f.orgnNet,
              individual_net: f.prsnNet,
              foreign_buy: f.frgnBuy,
              foreign_sell: f.frgnSell,
              institution_buy: f.orgnBuy,
              institution_sell: f.orgnSell,
              individual_buy: f.prsnBuy,
              individual_sell: f.prsnSell,
            },
          });
          posted++;
        } catch (e) {
          errors.push(`${etf.code} flow ${day}: ${String(e)}`);
        }
      }
      console.log(`[etf] ${etf.code} investor_flow ${usableFlows.length}일`);
    } catch (e) {
      errors.push(`${etf.code} investor_flow: ${String(e)}`);
    }
  }

  console.log(`[etf] posted ${posted} snapshot(s), ${errors.length} error(s)`);
  for (const e of errors.slice(0, 20)) console.error(`  ! ${e}`);
  // 일부 실패는 재실행하면 멱등하게 메워진다. 전부 실패했을 때만 실패로 끝낸다.
  if (posted === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
