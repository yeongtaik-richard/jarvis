// Google Calendar API 저레벨 클라이언트.
// - refresh_token으로 access_token을 가져온다 (메모리 캐시).
// - 캘린더 이벤트 CRUD (insert/patch/delete) 래퍼.

type TokenCache = { accessToken: string; expiresAt: number };
let tokenCache: TokenCache | null = null;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth env not configured');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}

export type CalendarEventInput = {
  summary: string;
  description?: string | null;
  // 시간은 둘 중 하나의 형태:
  // - dateTime + timeZone (점/기간 이벤트)
  // - date (종일 이벤트)
  start:
    | { dateTime: string; timeZone?: string }
    | { date: string; timeZone?: string };
  end:
    | { dateTime: string; timeZone?: string }
    | { date: string; timeZone?: string };
  location?: string | null;
  extendedProperties?: { private?: Record<string, string> };
  source?: { title: string; url: string };
};

export type CalendarEvent = CalendarEventInput & { id: string; etag?: string };

async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Calendar API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

export async function insertEvent(event: CalendarEventInput): Promise<CalendarEvent> {
  return callApi<CalendarEvent>(`/calendars/${encodeURIComponent(calendarId())}/events`, {
    method: 'POST',
    body: JSON.stringify(event),
  });
}

export async function patchEvent(
  eventId: string,
  patch: Partial<CalendarEventInput>,
): Promise<CalendarEvent> {
  return callApi<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteEvent(eventId: string): Promise<void> {
  await callApi<void>(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  );
}
