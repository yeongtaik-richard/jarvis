-- 구글 지도 타임라인의 방문 기록.
--
-- 타임라인은 폰에만 저장되고 API가 없어서, 폰에서 내보낸 Timeline.json을
-- scripts/import-timeline.ts로 가져온다. 파일에는 장소 이름이 없고 place ID와
-- 좌표만 있으므로, 이름은 Places API (New)로 한 번 조회해 places에 캐시한다.
--
-- 메모리(event_versions)와 분리한다. 방문은 하루에도 여러 건이라 메모리에 섞으면
-- 묻히고, 의미 있는 방문만 사용자 확인을 거쳐 메모리로 옮긴다.
-- Idempotent: safe to re-run.

create table if not exists places (
  place_id        text primary key,
  name            text,
  address         text,
  primary_type    text,
  lat             double precision,
  lng             double precision,
  -- Places API 조회 시각. null이면 아직 이름을 못 가져온 것.
  fetched_at      timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists place_visits (
  id              uuid primary key default gen_random_uuid(),
  place_id        text not null references places(place_id),
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  -- 타임라인의 semanticType: INFERRED_HOME | INFERRED_WORK | UNKNOWN 등
  semantic_type   text,
  probability     double precision,
  -- 0 = 최상위 방문, 1 = 상위 방문 안의 하위 장소(예: 쇼핑몰 안 매장)
  hierarchy_level smallint not null default 0,
  imported_at     timestamptz not null default now()
);

-- 같은 파일이나 기간이 겹치는 파일을 다시 가져와도 중복되지 않게 한다.
create unique index if not exists ux_place_visits_natural
  on place_visits (place_id, start_time);

create index if not exists ix_place_visits_start
  on place_visits (start_time desc);
