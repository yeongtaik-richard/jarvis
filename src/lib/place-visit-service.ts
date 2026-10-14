import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { placeVisits, places, type Place, type PlaceVisit } from '@/db/schema';
import type { PlaceVisitQuery } from './schemas';

const TYPE_FILTER: Record<NonNullable<PlaceVisitQuery['type']>, SQL> = {
  home: sql`${placeVisits.semanticType} = 'INFERRED_HOME'`,
  work: sql`${placeVisits.semanticType} = 'INFERRED_WORK'`,
  other: sql`coalesce(${placeVisits.semanticType}, '') not in ('INFERRED_HOME', 'INFERRED_WORK')`,
};

export async function searchVisits(query: PlaceVisitQuery) {
  const conds: SQL[] = [];
  if (query.from) conds.push(sql`${placeVisits.endTime} >= ${query.from}`);
  if (query.to) conds.push(sql`${placeVisits.startTime} <= ${query.to}`);
  if (query.type) conds.push(TYPE_FILTER[query.type]);
  if (query.min_minutes > 0) {
    conds.push(
      sql`${placeVisits.endTime} - ${placeVisits.startTime} >= make_interval(mins => ${query.min_minutes})`,
    );
  }
  if (query.q) {
    conds.push(
      sql`(coalesce(${places.name}, '') ilike ${`%${query.q}%`}
        or coalesce(${places.address}, '') ilike ${`%${query.q}%`})`,
    );
  }

  return db
    .select({ visit: placeVisits, place: places })
    .from(placeVisits)
    .innerJoin(places, eq(places.placeId, placeVisits.placeId))
    .where(conds.length ? sql.join(conds, sql` and `) : undefined)
    .orderBy(desc(placeVisits.startTime))
    .limit(query.limit);
}

export function toApiVisit({ visit, place }: { visit: PlaceVisit; place: Place }) {
  return {
    id: visit.id,
    start_time: visit.startTime.toISOString(),
    end_time: visit.endTime.toISOString(),
    minutes: Math.round((visit.endTime.getTime() - visit.startTime.getTime()) / 60000),
    semantic_type: visit.semanticType,
    hierarchy_level: visit.hierarchyLevel,
    place: {
      place_id: place.placeId,
      name: place.name,
      address: place.address,
      primary_type: place.primaryType,
      lat: place.lat,
      lng: place.lng,
    },
  };
}
