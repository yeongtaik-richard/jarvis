-- 접근 토큰 캐시. 수집기가 실행마다 KIS 토큰을 새로 발급받아 하루 14~16통의
-- 카카오톡 발급 알림이 오고 있었다. 토큰은 24시간짜리라 하루 한 번이면 충분하다.
--
-- **암호문만 저장한다.** KIS 접근 토큰은 앱키와 마찬가지로 주문 권한이 있어서,
-- 평문으로 두면 "주문 가능한 자격증명은 Vercel에 두지 않는다"는 제약이 깨진다.
-- 복호화 키는 KIS_APP_SECRET에서 파생되고 그건 수집기(GitHub Secrets/로컬)에만
-- 있으므로, 서버와 DB는 열어볼 수 없는 덩어리만 들고 있게 된다.
create table if not exists service_tokens (
  name text primary key,
  -- base64(iv | authTag | ciphertext)
  ciphertext text not null,
  -- 어느 앱키로 받은 토큰인지. 키가 바뀌면 복호화 시도 없이 무효로 판정한다.
  key_fingerprint text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
