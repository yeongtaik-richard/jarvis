-- Jarvis initial schema
-- Idempotent: safe to re-run

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

do $$ begin
  create type sync_state as enum ('pending', 'synced', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type op as enum ('create', 'update', 'delete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type time_precision as enum ('exact', 'date', 'month', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type source as enum ('gpt', 'web', 'sync');
exception when duplicate_object then null; end $$;

create table if not exists event_threads (
  id                  uuid primary key default gen_random_uuid(),
  current_version_id  uuid,
  google_event_id     text,
  google_etag         text,
  sync_state          sync_state not null default 'pending',
  last_synced_at      timestamptz,
  created_at          timestamptz not null default now()
);

create table if not exists event_versions (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references event_threads(id),
  supersedes_id   uuid references event_versions(id),
  is_canonical    boolean not null default false,
  op              op not null,
  title           text not null,
  body            text,
  event_time      timestamptz,
  timezone        text,
  time_precision  time_precision not null default 'exact',
  raw_time_text   text,
  importance      smallint not null default 0,
  tags            text[] not null default '{}',
  source          source not null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  search_tsv      tsvector generated always as
                  (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))) stored
);

-- thread당 canonical 1개만 허용
create unique index if not exists ux_canonical_per_thread
  on event_versions(thread_id) where is_canonical;

create index if not exists ix_versions_event_time on event_versions(event_time desc nulls last);
create index if not exists ix_versions_created_at on event_versions(created_at desc);
create index if not exists ix_versions_thread     on event_versions(thread_id);
create index if not exists ix_versions_search     on event_versions using gin(search_tsv);
create index if not exists ix_versions_tags       on event_versions using gin(tags);

-- event_threads.current_version_id → event_versions(id) 순환 참조이므로 deferrable로 추가
alter table event_threads
  drop constraint if exists fk_threads_current_version;
alter table event_threads
  add constraint fk_threads_current_version
  foreign key (current_version_id) references event_versions(id)
  deferrable initially deferred;
