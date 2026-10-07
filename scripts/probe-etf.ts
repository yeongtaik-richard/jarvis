/**
 * ETF 프로브 — **조회만 하고 아무것도 저장하지 않는다.**
 *
 * KIS의 종목 조회 API들이 ETF 종목코드에도 동작하는지 확인하는 일회성 도구다. 개별
 * 주식에서 되는 게 ETF에서도 된다는 보장이 없고(ETF는 집합투자증권이라 수급·공매도
 * 같은 필드가 아예 비어 올 수 있다), 키가 GitHub Secrets에만 있어 로컬에서 찔러볼
 * 수 없어서 워크플로로 한 번 돌려 확인한다.
 *
 * 저장하지 않는 이유: 되는지 모르는 응답을 그대로 upsert하면 빈 값이나 0이 "수집된
 * 값"으로 DB에 박힌다. 화면이 그걸 0으로 읽으면 "수급이 없는 날"과 "수급을 못 받는
 * 종목"이 구분되지 않는다.
 *
 * 확인 대상:
 *   1. 장중 현재가      currentQuote (inquire-price)
 *   2. 일별 투자자 수급  investorFlows (inquire-investor)
 *   3. 장중 수급 추정    investorTrendEstimate (investor-trend-estimate)
 *
 * Usage: gh workflow run collect-etf.yml -f mode=probe
 */

import {
  currentQuote,
  investorFlows,
  investorTrendEstimate,
  overseasStockDaily,
  type KisCreds,
} from '../src/lib/kis-marketdata';
import { getKisToken } from '../src/lib/kis-token-cache';
import { THEME_UNIVERSE } from '../src/lib/theme-universe';

const BASE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/** 값이 "진짜 온 것"인지. ETF에서 안 되는 필드는 0이나 빈 문자열로 온다. */
const has = (v: unknown): string =>
  v === null || v === undefined || v === '' || v === 0 ? '✗' : '✓';

async function main(): Promise<void> {
  const creds: KisCreds = {
    appKey: required('KIS_APP_KEY'),
    appSecret: required('KIS_APP_SECRET'),
  };
  const apiToken = required('JARVIS_API_TOKEN');
  const { token, reused } = await getKisToken(creds, BASE, apiToken);
  console.log(`[probe] KIS token ${reused ? 'reused' : 'issued'}`);

  // 비교 기준으로 000660을 같이 찍는다. ETF에서 ✗가 나왔을 때 "ETF라서 안 되는 것"과
  // "지금 장이 닫혀서 비어 있는 것"을 구분하려면 되는 종목이 옆에 있어야 한다.
  const targets = [
    { key: 'ref', name: 'SK하이닉스 (비교 기준)', code: '000660' },
    ...THEME_UNIVERSE.map((e) => ({ key: e.key, name: e.name, code: e.code })),
  ];

  for (const t of targets) {
    console.log(`\n──── ${t.code}  ${t.name}`);

    // 1) 장중 현재가
    try {
      const q = await currentQuote(token, creds, t.code);
      console.log(
        `  [현재가]  price=${has(q.price)} ${q.price}  등락=${q.changeRate}%  ` +
          `거래량=${has(q.volume)} ${q.volume}  거래대금=${has(q.amountKrw)}`,
      );
      console.log(
        `  [수급질]  외국인비율=${has(q.foreignRatio)} ${q.foreignRatio}  ` +
          `프로그램=${has(q.programNetQty)} ${q.programNetQty}  ` +
          `공매도=${has(q.shortQty)}  대차잔고율=${has(q.loanBalanceRate)}`,
      );
    } catch (e) {
      console.log(`  [현재가]  ✗ ERROR ${String(e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 300));

    // 2) 일별 투자자 수급 (확정치)
    try {
      const flows = await investorFlows(token, creds, t.code);
      const f = flows[0];
      console.log(
        `  [일별수급] ${flows.length}일` +
          (f
            ? `  최신 ${f.date}  외국인=${has(f.frgnNet)} ${f.frgnNet}  ` +
              `기관=${has(f.orgnNet)} ${f.orgnNet}  개인=${has(f.prsnNet)} ${f.prsnNet} (백만원)`
            : '  (빈 응답)'),
      );
    } catch (e) {
      console.log(`  [일별수급] ✗ ERROR ${String(e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 300));

    // 3) 장중 수급 추정 (가집계)
    try {
      const est = await investorTrendEstimate(token, creds, t.code);
      const last = est.at(-1);
      console.log(
        `  [장중추정] ${est.length}구간` +
          (last
            ? `  최종 외국인=${has(last.foreignQty)} ${last.foreignQty}주  ` +
              `기관=${has(last.institutionQty)} ${last.institutionQty}주`
            : '  (빈 응답 — 장 시작 전이거나 ETF 미지원)'),
      );
    } catch (e) {
      console.log(`  [장중추정] ✗ ERROR ${String(e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 미국 상장 종목은 거래소 코드(EXCD)를 알아야 조회된다. ETHU는 Cboe BZX가 주
  //    상장소인데 KIS가 BZX를 따로 받는지 불명확해서, 후보를 훑어 되는 것을 찾는다.
  //    추측해서 수집기에 박으면 조용히 빈 응답만 쌓인다.
  const overseas = (process.env.PROBE_OVERSEAS ?? '').split(',').filter(Boolean);
  for (const symb of overseas) {
    console.log(`\n──── [해외] ${symb}`);
    for (const excd of ['NAS', 'NYS', 'AMS', 'BAT']) {
      try {
        const bars = await overseasStockDaily(token, creds, excd, symb);
        const last = bars[0];
        console.log(
          `  EXCD=${excd}  ${bars.length}일` +
            (last ? `  최신 ${last.date} close=${last.close} vol=${last.volume}` : '  (빈 응답)'),
        );
      } catch (e) {
        console.log(`  EXCD=${excd}  ✗ ${String(e).slice(0, 90)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(
    '\n[probe] 끝. ✓가 붙은 항목만 수집기에 넣는다 — ✗를 저장하면 "값이 0인 날"과\n' +
      '        "원래 안 나오는 종목"이 DB에서 구분되지 않는다.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
