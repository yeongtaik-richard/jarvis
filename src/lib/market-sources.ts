import { createHash } from 'node:crypto';
import { withRetry } from './retry';

/**
 * 이벤트(공시·뉴스) 수집 소스. **읽기 전용 HTTP만** 한다.
 *
 * 두 소스의 성격이 다르다:
 * - OpenDART 공시: 법적 1차 사실. 노이즈가 없지만 `rcept_dt`가 **날짜뿐이라 시각이 없다**
 *   → "13~14시 급락 구간" 같은 장중 대조에는 쓸 수 없다.
 * - 뉴스 RSS: 시각(`pubDate`)이 있어서 장중 대조가 되지만, 채용·일반 기사가 섞인다.
 *
 * 그래서 둘을 함께 쓴다: 공시는 "그날 무슨 사건이 있었나", 뉴스는 "몇 시에".
 */

export interface MarketEvent {
  source: 'dart' | 'news';
  external_id: string; // 멱등 키 (공시 rcept_no / 뉴스 링크 해시)
  published_at: string; // ISO
  title: string;
  url: string | null;
  publisher: string | null;
  category: string | null;
  raw: Record<string, unknown>;
}

const DART_LIST = 'https://opendart.fss.or.kr/api/list.json';

/** KST 날짜 문자열(YYYYMMDD). DART는 KST 기준 접수일자를 쓴다. */
function kstCompact(daysAgo: number): string {
  const d = new Date(Date.now() + 9 * 3_600_000 - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 최근 `days`일 공시 목록. 시각이 없으므로 접수일 09:00 KST로 고정해 저장한다
 * (장 시작 시각 — 정확한 시각을 아는 척하지 않기 위한 명시적 근사).
 */
export async function fetchDartDisclosures(
  apiKey: string,
  corpCode: string,
  days = 7,
): Promise<MarketEvent[]> {
  const url = new URL(DART_LIST);
  url.searchParams.set('crtfc_key', apiKey);
  url.searchParams.set('corp_code', corpCode);
  url.searchParams.set('bgn_de', kstCompact(days));
  url.searchParams.set('end_de', kstCompact(0));
  url.searchParams.set('page_count', '100');

  const body = await withRetry('DART list', async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DART list http ${res.status}`);
    return (await res.json()) as {
      status?: string;
      message?: string;
      list?: Record<string, string>[];
    };
  });
  // 013 = 조회된 데이터 없음. 에러가 아니다.
  if (body.status === '013') return [];
  if (body.status !== '000') {
    throw new Error(`DART list failed: ${body.status} ${body.message ?? ''}`);
  }

  return (body.list ?? []).map((r) => {
    const d = r.rcept_dt ?? '';
    return {
      source: 'dart' as const,
      external_id: r.rcept_no ?? '',
      published_at: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T09:00:00+09:00`,
      title: (r.report_nm ?? '').trim(),
      url: r.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}` : null,
      publisher: (r.flr_nm ?? '').trim() || null, // 제출인
      category: r.corp_cls ?? null, // 법인구분 Y/K/N/E
      raw: r,
    };
  });
}

/**
 * 구글 뉴스 RSS. 키가 필요 없고 발행 시각이 온다. 정식 RSS 엔드포인트라 스크래핑이 아니다.
 * 파서는 정규식이다 — 항목이 `<item>`뿐인 단순 피드라 XML 라이브러리를 새로 넣지 않았다.
 */
export async function fetchNewsHeadlines(
  query: string,
  withinHours = 48,
  cap = 40,
  category: string | null = null,
): Promise<MarketEvent[]> {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'ko');
  url.searchParams.set('gl', 'KR');
  url.searchParams.set('ceid', 'KR:ko');

  const xml = await withRetry('news rss', async () => {
    const res = await fetch(url, { headers: { 'user-agent': 'jarvis-collector' } });
    // 'http <코드>' 형태 — 재시도 분류기가 이 모양으로 상태 코드를 읽는다 (retry.ts).
    if (!res.ok) throw new Error(`news rss http ${res.status}`);
    return res.text();
  });

  const pick = (block: string, tag: string): string | null => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
    return m ? decodeEntities(m[1]!.trim()) : null;
  };

  const cutoff = Date.now() - withinHours * 3_600_000;
  const out: MarketEvent[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const link = pick(block, 'link');
    const rawTitle = pick(block, 'title');
    const pubDate = pick(block, 'pubDate');
    if (!link || !rawTitle || !pubDate) continue;

    const ts = new Date(pubDate);
    if (!Number.isFinite(ts.getTime()) || ts.getTime() < cutoff) continue;

    const publisher = pick(block, 'source');
    // 구글은 제목 끝에 ' - 언론사'를 붙인다. 언론사는 <source>에 따로 있으니 떼어낸다.
    // 대시 문자가 하이픈/en dash/em dash로 섞이고, 원문 제목에 이미 언론사가 붙어 있으면
    // 구글이 하나 더 붙여 '- 머니투데이 - 머니투데이'가 된다 → 반복 제거한다.
    const title = publisher
      ? rawTitle.replace(new RegExp(`(?:\\s*[-–—]\\s*${escapeRe(publisher)})+\\s*$`), '').trim()
      : rawTitle;

    out.push({
      source: 'news',
      // 구글 뉴스 링크는 수백 자라 그대로 키로 쓰면 유니크 인덱스에 부담이다. 해시로 고정.
      external_id: createHash('sha256').update(link).digest('hex'),
      published_at: ts.toISOString(),
      title,
      url: link,
      publisher,
      category,
      raw: { pubDate, rawTitle, query },
    });
  }
  // 최신순으로 잘라낸다 (피드가 관련도 순으로 섞여 오기 때문).
  out.sort((a, b) => b.published_at.localeCompare(a.published_at));
  return out.slice(0, cap);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
