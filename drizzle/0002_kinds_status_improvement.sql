-- Phase 1: kind/status, time fields, attributes, improvement_notes
-- Idempotent: safe to re-run.

do $$ begin
  create type kind as enum ('event', 'fact', 'relationship', 'trigger');
exception when duplicate_object then null; end $$;

do $$ begin
  create type status as enum ('planned', 'actual', 'cancelled', 'active', 'resolved', 'na');
exception when duplicate_object then null; end $$;

do $$ begin
  create type note_status as enum ('open', 'triaged', 'applied', 'wontfix');
exception when duplicate_object then null; end $$;

alter table event_versions
  add column if not exists kind        kind   not null default 'event',
  add column if not exists status      status not null default 'na',
  add column if not exists start_time  timestamptz,
  add column if not exists end_time    timestamptz,
  add column if not exists actual_time timestamptz,
  add column if not exists attributes  jsonb  not null default '{}'::jsonb;

create index if not exists ix_versions_kind_status   on event_versions(kind, status);
create index if not exists ix_versions_start_time    on event_versions(start_time desc nulls last);
create index if not exists ix_versions_actual_time   on event_versions(actual_time desc nulls last);
create index if not exists ix_versions_attributes    on event_versions using gin(attributes);

-- (월-일 매칭 인덱스는 timestamptz IMMUTABLE 제약 때문에 보류.
--  데이터량이 작은 동안은 sequential scan으로 충분. 필요해지면 나중에
--  date 형 보조 컬럼 + IMMUTABLE 표현식 인덱스 추가.)

create table if not exists improvement_notes (
  id                   uuid primary key default gen_random_uuid(),
  observed_request     text not null,
  missing_capability   text not null,
  proposed_fix         text,
  priority             smallint not null default 0,
  status               note_status not null default 'open',
  example_memory_id    uuid references event_versions(id),
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  resolution_note      text
);

create index if not exists ix_improvement_status on improvement_notes(status, created_at desc);
create index if not exists ix_improvement_priority on improvement_notes(priority desc, created_at desc)
  where status in ('open', 'triaged');
