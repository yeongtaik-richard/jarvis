/**
 * 구글 지도 타임라인 방문 기록 가져오기.
 *
 * 타임라인은 폰에만 저장되고 API가 없다. 폰에서 내보낸 파일을 읽어 방문(visit)만
 * place_visits에 넣고, 처음 보는 장소는 Places API (New)로 이름을 조회해 places에
 * 캐시한다. 이동 경로·원시 신호·활동(걷기/차량)은 버린다.
 *
 *   폰: 설정 → 위치 → 위치 서비스 → 타임라인 → 타임라인 데이터 내보내기
 *   맥: pnpm timeline:import ~/Downloads/타임라인.json
 *
 * Env: DATABASE_URL, GOOGLE_MAPS_API_KEY (.env.local). 원본 파일은 레포에 두지 않는다.
 * 같은 파일이나 기간이 겹치는 파일을 다시 넣어도 (place_id, start_time)으로 중복을 막는다.
 */
import { readFileSync } from 'node:fs';
import { isNull, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { placeVisits, places } from '../src/db/schema';

type TimelineVisit = {
  startTime: string;
  endTime: string;
  visit: {
    hierarchyLevel?: number;
    probability?: number;
    topCandidate?: {
      placeId?: string;
      semanticType?: string;
      placeLocation?: { latLng?: string };
    };
  };
};

const PLACES_FIELDS = 'id,displayName,formattedAddress,primaryType,primaryTypeDisplayName,location';
const CHUNK = 200;

// "37.3953071°, 127.1111641°" → [lat, lng]
function parseLatLng(s: string | undefined): [number, number] | [null, null] {
  const m = s?.match(/(-?[\d.]+)°?,\s*(-?[\d.]+)°?/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function fetchPlace(placeId: string, key: string) {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=ko&regionCode=KR`,
    { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS } },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    primaryType?: string;
    primaryTypeDisplayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: pnpm timeline:import <Timeline.json>');
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  const data = JSON.parse(readFileSync(file, 'utf8')) as { semanticSegments?: unknown[] };
  const visits = (data.semanticSegments ?? []).filter(
    (s): s is TimelineVisit =>
      typeof s === 'object' && s !== null && 'visit' in s &&
      Boolean((s as TimelineVisit).visit.topCandidate?.placeId),
  );
  console.log(`visits in file: ${visits.length}`);

  // 1. 장소 행을 먼저 만든다 (좌표는 타임라인 값, 이름은 4단계에서 채움).
  const placeRows = new Map<string, { placeId: string; lat: number | null; lng: number | null }>();
  for (const v of visits) {
    const c = v.visit.topCandidate!;
    if (placeRows.has(c.placeId!)) continue;
    const [lat, lng] = parseLatLng(c.placeLocation?.latLng);
    placeRows.set(c.placeId!, { placeId: c.placeId!, lat, lng });
  }
  for (const batch of chunks([...placeRows.values()], CHUNK)) {
    await db.insert(places).values(batch).onConflictDoNothing();
  }

  // 2. 방문을 넣는다. 이미 있는 방문은 건너뛴다.
  let inserted = 0;
  const visitRows = visits.map((v) => ({
    placeId: v.visit.topCandidate!.placeId!,
    startTime: new Date(v.startTime),
    endTime: new Date(v.endTime),
    semanticType: v.visit.topCandidate!.semanticType ?? null,
    probability: v.visit.probability ?? null,
    hierarchyLevel: v.visit.hierarchyLevel ?? 0,
  }));
  for (const batch of chunks(visitRows, CHUNK)) {
    const rows = await db
      .insert(placeVisits)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: placeVisits.id });
    inserted += rows.length;
  }
  console.log(`visits inserted: ${inserted} (skipped ${visitRows.length - inserted} already imported)`);

  // 3. 이름이 없는 장소만 Places API로 조회한다. 이전 실행에서 실패한 것도 다시 시도된다.
  const pending = await db.select({ placeId: places.placeId }).from(places).where(isNull(places.fetchedAt));
  console.log(`places to look up: ${pending.length}`);
  let ok = 0;
  const failed: string[] = [];
  for (const { placeId } of pending) {
    try {
      const p = await fetchPlace(placeId, key);
      await db
        .update(places)
        .set({
          name: p.displayName?.text ?? null,
          address: p.formattedAddress ?? null,
          primaryType: p.primaryTypeDisplayName?.text ?? p.primaryType ?? null,
          ...(p.location?.latitude != null && p.location?.longitude != null
            ? { lat: p.location.latitude, lng: p.location.longitude }
            : {}),
          fetchedAt: new Date(),
        })
        .where(sql`${places.placeId} = ${placeId}`);
      ok++;
    } catch (e) {
      failed.push(`${placeId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`places looked up: ${ok}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  ! ${f}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
