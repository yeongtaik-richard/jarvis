// 폼에서 받은 datetime-local + timezone offset을 ISO 8601(오프셋 포함) 문자열로 합성.

export function parseTags(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAttributes(input: string | null | undefined): Record<string, unknown> {
  if (!input) return {};
  const trimmed = input.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('attributes must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// "2026-05-03T15:00" + "Asia/Seoul" → "2026-05-03T15:00:00+09:00"
// timezone에 IANA 이름이 들어오면 해당 시점의 offset을 계산해 붙인다.
export function localInputToIso(
  local: string | null | undefined,
  timeZone: string,
): string | null {
  if (!local) return null;
  // "YYYY-MM-DDTHH:mm" 또는 "YYYY-MM-DDTHH:mm:ss"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) {
    throw new Error(`invalid datetime input: ${local}`);
  }
  const [, y, mo, d, hh, mm, ss = '00'] = m;
  const offset = offsetFor(timeZone, Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${offset}`;
}

// 주어진 IANA 타임존이 특정 UTC 시각에 가지는 오프셋을 ±HH:MM 형식으로 반환.
function offsetFor(timeZone: string, utcMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset', // "GMT+09:00"
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
  if (!m) return '+00:00';
  const sign = m[1];
  const hh = m[2].padStart(2, '0');
  const mm = (m[3] ?? '00').padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
