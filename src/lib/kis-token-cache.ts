/**
 * KIS 접근 토큰 캐시 — 하루 한 번만 발급받게 만드는 물건.
 *
 * ## 왜
 * 수집기가 실행마다 `issueToken`을 불렀다. 하루 14~16회 돌고, KIS는 발급할 때마다
 * 카카오톡 알림을 보낸다. 토큰은 24시간짜리라 그 발급의 15분의 14는 낭비였다.
 *
 * ## 왜 서버에 평문으로 안 두나
 * KIS 접근 토큰은 앱키와 마찬가지로 **주문 권한이 있다**. 평문으로 DB에 넣으면
 * "주문 가능한 자격증명은 GitHub Secrets와 로컬에만 두고 Vercel엔 두지 않는다"는
 * 제약이 그대로 무너진다 — DB URL은 Vercel에 있으니까.
 *
 * 그래서 **수집기가 암호화해서 올리고 수집기가 내려받아 복호화한다.** 서버와 DB는
 * 열 수 없는 덩어리만 본다. 새 시크릿을 만들지 않고 키를 `KIS_APP_SECRET`에서
 * 파생하는 이유도 같다: 그 값을 가진 쪽은 어차피 토큰을 직접 발급할 수 있으므로
 * 복호화 능력이 새로운 권한을 주지 않는다. 설정할 것이 늘지도 않는다.
 *
 * ## 실패하면 그냥 발급한다
 * 캐시는 최적화지 의존성이 아니다. API가 죽었든 복호화가 깨졌든 만료가 임박했든,
 * 어느 경우에나 새로 발급받고 수집을 계속한다. 캐시 때문에 수집이 멈추면 알림
 * 몇 통 아끼려다 그날 표본을 잃는다.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { issueToken, type KisCreds } from './kis-marketdata';

const NAME = 'kis_access_token';
/**
 * 만료 여유. KIS 토큰은 24시간이라 이만큼 잘라내도 하루 1회 발급이 유지된다.
 * 수집 도중 만료돼 절반쯤 실패하는 쪽이 한 번 더 발급받는 것보다 나쁘다.
 */
const MARGIN_MS = 30 * 60 * 1000;

const keyOf = (creds: KisCreds): Buffer =>
  createHash('sha256').update(`jarvis:kis-token:v1:${creds.appSecret}`).digest();

/** 앱키 지문 — 키가 바뀌면 캐시를 복호화해보지 않고 버린다. */
const fingerprintOf = (creds: KisCreds): string =>
  createHash('sha256').update(creds.appKey).digest('hex').slice(0, 16);

export function encryptToken(token: string, creds: KisCreds): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(creds), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decryptToken(blob: string, creds: KisCreds): string {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyOf(creds), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

type CachedToken = {
  ciphertext: string;
  key_fingerprint: string;
  expires_at: string;
};

/**
 * 캐시된 토큰을 쓰거나, 없으면 발급받아 캐시에 올린다.
 *
 * @param base    jarvis API 베이스 URL
 * @param apiToken jarvis API 전권 토큰
 */
export async function getKisToken(
  creds: KisCreds,
  base: string,
  apiToken: string,
): Promise<{ token: string; reused: boolean }> {
  const fp = fingerprintOf(creds);

  try {
    const res = await fetch(`${base}/api/kis/token`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (res.ok) {
      const row = (await res.json()) as CachedToken | null;
      const freshEnough =
        row && Date.parse(row.expires_at) - Date.now() > MARGIN_MS && row.key_fingerprint === fp;
      if (freshEnough) return { token: decryptToken(row.ciphertext, creds), reused: true };
    }
  } catch (e) {
    // 조회 실패든 복호화 실패든(키 교체 후 남은 덩어리) 여기로 온다. 어느 쪽이든
    // 새로 발급받으면 되는 일이라 수집을 막지 않는다.
    console.warn(`[kis-token] 캐시를 못 썼다, 새로 발급한다: ${String(e)}`);
  }

  const issued = await issueToken(creds);
  try {
    await fetch(`${base}/api/kis/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ciphertext: encryptToken(issued.token, creds),
        key_fingerprint: fp,
        expires_at: new Date(issued.expiresAt).toISOString(),
      }),
    });
  } catch (e) {
    // 저장에 실패해도 이번 실행은 방금 받은 토큰으로 진행한다. 다음 실행이 다시 시도한다.
    console.warn(`[kis-token] 캐시 저장 실패: ${String(e)}`);
  }
  return { token: issued.token, reused: false };
}
