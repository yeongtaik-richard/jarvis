// Number formatting shared by the /stock server page and its client charts.

export const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

export function korQty(n: number, suffix = ''): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(2)}억${suffix}`;
  if (a >= 1e4) return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만${suffix}`;
  return `${n.toLocaleString('ko-KR')}${suffix}`;
}

// 투자자 매매대금은 백만원(million KRW) 단위로 저장됨 → 조/억으로 환산.
export function moneyMil(pbmn: number): string {
  const a = Math.abs(pbmn);
  if (a >= 1_000_000) return `${(a / 1_000_000).toFixed(2)}조`;
  if (a >= 100) return `${Math.round(a / 100).toLocaleString('ko-KR')}억`;
  return `${Math.round(a).toLocaleString('ko-KR')}백만`;
}

/**
 * **원 단위** 금액 → 조/억. `moneyMil`(백만원)과 단위가 다르니 섞지 말 것.
 * `korQty`는 억까지만 알아서 12조를 '124934.30억'으로 찍는다 — 금액엔 이걸 쓴다.
 */
export function moneyKrw(krw: number): string {
  const a = Math.abs(krw);
  if (a >= 1e12) return `${(krw / 1e12).toFixed(2)}조`;
  if (a >= 1e8) return `${Math.round(krw / 1e8).toLocaleString('ko-KR')}억`;
  return `${Math.round(krw).toLocaleString('ko-KR')}원`;
}

/** 'YYYY-MM-DD' → 'M/D' for axis ticks. */
export function shortDate(bucketKey: string): string {
  const [, m, d] = bucketKey.split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : bucketKey;
}
