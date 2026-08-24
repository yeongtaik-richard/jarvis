/**
 * 일시적 실패 재시도.
 *
 * ## 왜 필요한가
 * 수집기는 Azure(미국) 러너에서 한국 호스트(KIS·DART)를 부른다. 연결이 가끔 끊기는데,
 * 재시도가 한 군데도 없어서 **TCP 타임아웃 한 번이 그 실행 전체를 죽였다.**
 * 2026-08-18~24 실패 6건이 전부 이 한 가지 종류였다:
 *
 * | 실패 | 원인 |
 * |---|---|
 * | intraday_price: fetch failed ×2 | KIS 연결 실패 (한 번은 posted 0/0 — 그 시간 표본 통째로 유실) |
 * | dart: fetch failed ×2 | DART 연결 실패 |
 * | issueToken: ConnectTimeoutError | KIS 연결 실패, 수집 시작도 못 함 |
 * | fx_usdkrw·usdjpy: 초당 거래건수 초과 | KIS 초당 호출 제한 |
 *
 * ## 무엇을 재시도하지 않는가
 * 자격증명 오류, 잘못된 파라미터, 없는 종목 — 다시 물어도 같은 답이 온다. 재시도는
 * **다음 시도에 달라질 이유가 있는 실패**에만 쓴다. 아니면 실패를 늦게 알게 될 뿐이다.
 */

/** 요청이 서버에 닿지도 못한 경우. 부작용이 없는 게 확실해서 무조건 재시도해도 안전하다. */
const NETWORK =
  /fetch failed|ConnectTimeout|socket hang up|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_|terminated/i;

/**
 * 서버가 답은 했지만 잠시 뒤엔 달라질 답.
 *
 * 상태 코드는 **`http <코드>` 형태로만** 인식한다. 숫자만 찾으면 `1,502,000원` 같은
 * 값이 섞인 메시지가 502로 오인된다 — 그래서 던지는 쪽이 전부 이 형태를 쓴다.
 */
const RETRYABLE_RESPONSE = /초당 거래건수|\bhttp (?:429|5\d\d)\b/;

export function isNetworkError(e: unknown): boolean {
  const s = e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : String(e);
  return NETWORK.test(s);
}

export function isTransient(e: unknown): boolean {
  if (isNetworkError(e)) return true;
  const s = e instanceof Error ? e.message : String(e);
  return RETRYABLE_RESPONSE.test(s);
}

export interface RetryOptions {
  /** 총 시도 횟수 (첫 시도 포함). */
  attempts?: number;
  /**
   * 재시도 간격(ms). 기본값의 첫 칸이 1초인 건 KIS의 "초당 거래건수" 제한 때문이다 —
   * 그보다 빨리 다시 던지면 같은 오류를 한 번 더 받는다.
   */
  delaysMs?: number[];
  /**
   * `'network'`면 요청이 서버에 닿지 못한 경우만 재시도한다. **토큰 발급처럼 재시도가
   * 사용자에게 보이는 부작용(카카오톡 알림)을 만드는 호출**에 쓴다 — 서버가 응답했다는
   * 것은 발급이 일어났을 수도 있다는 뜻이라 다시 던지면 안 된다.
   */
  only?: 'network' | 'transient';
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const delays = opts.delaysMs ?? [1000, 3000];
  const attempts = opts.attempts ?? delays.length + 1;
  const retryable = opts.only === 'network' ? isNetworkError : isTransient;

  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !retryable(e)) break;
      const wait = delays[Math.min(i, delays.length - 1)]!;
      console.warn(
        `[retry] ${label} 실패 (${i + 1}/${attempts}), ${wait}ms 뒤 재시도: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
