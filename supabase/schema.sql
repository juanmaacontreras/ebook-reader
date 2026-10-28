-- ebook-reader: full database schema. Idempotent: safe to run again on an
-- existing project (it is how schema changes are applied, see CLAUDE.md).
--
-- Every row belongs to a Supabase Auth user (user_id) and RLS limits each user to
-- their own rows. The TTS worker on the PC uses the secret (service role) key,
-- which bypasses RLS.
--
-- Conflict rule for everything the devices write: last writer wins by the
-- client-side updated_at. The lww_guard trigger silently drops an UPDATE that is
-- older than what is stored, so a device that was offline can never overwrite a
-- newer position or highlight with stale data.

-- ===== Helpers ===============================================================

create or replace function public.lww_guard() returns trigger
language plpgsql as $$
begin
  if new.updated_at < old.updated_at then
    return null;  -- skip this row's update, keep the newer one
  end if;
  return new;
end $$;

-- Only allow-listed emails can create an account: the URL and the public key
-- ship inside the app (public repo), so open sign-ups would let anyone use the
-- free storage quota.
create table if not exists public.allowed_emails (email text primary key);
alter table public.allowed_emails enable row level security;

create or replace function public.check_allowed_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_emails where lower(email) = lower(new.email)) then
    raise exception 'Sign-ups are closed for this email';
  end if;
  return new;
end $$;

drop trigger if exists only_allowed_emails on auth.users;
create trigger only_allowed_emails before insert on auth.users
  for each row execute function public.check_allowed_email();

-- ===== Books =================================================================

create table if not exists public.books (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  sha256 text not null,
  title text not null,
  author text,
  language text,                       -- BCP 47 from the EPUB (es, en, es-AR...)
  -- Where the files live. 'supabase' today; 'gdrive' is the planned overflow
  -- (see client/src/data/files.ts). Paths are relative to that provider.
  storage text not null default 'supabase',
  epub_path text not null,
  cover_path text,
  text_path text,                      -- sentence manifest (gzipped JSON)
  size_bytes bigint,
  section_count int,
  status text not null default 'to_read' check (status in ('to_read', 'reading', 'finished')),
  added_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, sha256)
);

-- ===== Reading position ======================================================

create table if not exists public.positions (
  book_id uuid primary key references public.books on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  cfi text not null,                   -- CFI of the current sentence's start
  section int,
  sentence int,                        -- index in the manifest's section
  fraction real,                       -- 0..1 through the whole book
  device text,
  updated_at timestamptz not null default now()
);

-- ===== Highlights and notes ==================================================

create table if not exists public.highlights (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  book_id uuid not null references public.books on delete cascade,
  cfi text not null,                   -- range CFI
  text text not null,
  note text,
  color text not null default 'yellow',
  section int,
  chapter text,
  deleted boolean not null default false,  -- soft delete, so it syncs
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists highlights_book on public.highlights (book_id);

-- ===== Narration =============================================================

-- One row per book. Two owners, never writing the same column:
--   the app:    voice, status (what the user wants), scope, start/priority_section,
--               started_at, requested_at, updated_at (its clock; LWW between devices)
--   the worker: state, error, current_section, stopped_at (it never touches
--               updated_at, so it can't win or lose a LWW race against a device)
-- Narration happens only on purpose: a job runs while status = 'active' and
-- nobody stopped it after it was started (stopped_at < started_at). A stop from
-- the PC itself (Waybar) is the worker's stopped_at; a stop from the app is status.
create table if not exists public.narrations (
  book_id uuid primary key references public.books on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  voice text not null,                 -- "<engine>:<voice>", e.g. kokoro:ef_dora
  status text not null default 'active' check (status in ('active', 'paused')),
  -- What the user asked for, counted from start_section: 'chapter' (that one),
  -- 'next' (that one and the next two), 'all' (the whole book). 'ahead' is the
  -- old automatic narration, never run again.
  scope text not null default 'all' check (scope in ('ahead', 'all', 'chapter', 'next')),
  start_section int,                   -- where the user was when they asked
  priority_section int,                -- the user jumped here: generate it next
  requested_at timestamptz not null default now(),
  started_at timestamptz,              -- the user's last "Generar ahora"
  updated_at timestamptz not null default now(),
  state text not null default 'waiting'
    check (state in ('waiting', 'generating', 'ready', 'error', 'purged')),
  current_section int,
  stopped_at timestamptz,              -- stopped from the PC (Waybar click)
  error text
);
alter table public.narrations add column if not exists scope text not null default 'all';
alter table public.narrations add column if not exists started_at timestamptz;
alter table public.narrations add column if not exists stopped_at timestamptz;
alter table public.narrations alter column scope set default 'all';
alter table public.narrations drop constraint if exists narrations_scope_check;
alter table public.narrations add constraint narrations_scope_check
  check (scope in ('ahead', 'all', 'chapter', 'next'));

-- One row per finished chapter. Written only by the worker.
create table if not exists public.narration_chapters (
  book_id uuid not null references public.books on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  voice text not null,
  section int not null,
  audio_path text not null,
  duration real not null,
  bytes int not null,
  -- Sentence map: [{"i": sentence index, "cfi": "...", "s": start, "e": end}]
  timings jsonb not null,
  created_at timestamptz not null default now(),
  primary key (book_id, voice, section)
);

-- ===== Reading sessions (stats) ==============================================
-- One row per stretch of reading or listening on one device. Only the device
-- that started it writes it (upserted while it lasts). book_id survives the
-- book's deletion as null, so time already read still counts in the totals.
create table if not exists public.reading_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  book_id uuid references public.books on delete set null,
  kind text not null check (kind in ('read', 'listen')),
  device text,
  device_kind text,                    -- phone / tablet / pc
  started_at timestamptz not null,
  ended_at timestamptz not null,
  seconds int not null default 0,      -- active time, idle gaps left out
  words int not null default 0,        -- words advanced (sentence manifest)
  updated_at timestamptz not null default now()
);
-- Reading speed comes only from "clean" pages (not skimmed, not left open,
-- app in the foreground): their words and time, kept apart from the totals.
alter table public.reading_sessions add column if not exists pace_words int not null default 0;
alter table public.reading_sessions add column if not exists pace_seconds int not null default 0;
create index if not exists reading_sessions_book on public.reading_sessions (book_id);

-- What the PC is doing, so the app can show it ("PC conectada", voices).
create table if not exists public.worker_status (
  user_id uuid primary key references auth.users on delete cascade,
  heartbeat timestamptz not null default now(),
  voices jsonb not null default '[]',
  current jsonb,
  notice text,                         -- why the PC can't generate right now (GPU busy)
  audio_bytes bigint
);
alter table public.worker_status add column if not exists notice text;

-- ===== Triggers ==============================================================
-- synced_at is the server clock at the last write. Devices pull "everything with
-- synced_at after my cursor": client clocks (updated_at) decide conflicts but
-- can't be used for that, an edit made offline arrives with an old updated_at.

create or replace function public.set_synced_at() returns trigger
language plpgsql as $$
begin
  new.synced_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['books', 'positions', 'highlights', 'narrations', 'narration_chapters', 'reading_sessions'] loop
    execute format('alter table public.%I add column if not exists synced_at timestamptz not null default now()', t);
    execute format('create index if not exists %I on public.%I (user_id, synced_at)', t || '_synced', t);
    -- Trigger names fire in alphabetical order: lww (may skip the row) before synced.
    execute format('drop trigger if exists synced on public.%I', t);
    execute format('create trigger synced before insert or update on public.%I for each row execute function public.set_synced_at()', t);
  end loop;
  foreach t in array array['books', 'positions', 'highlights', 'narrations', 'reading_sessions'] loop
    execute format('drop trigger if exists lww on public.%I', t);
    execute format('create trigger lww before update on public.%I for each row execute function public.lww_guard()', t);
  end loop;
end $$;

-- Chapter rows are deleted when a book's audio is purged; devices learn about
-- it from this log (a pull can't see a row that no longer exists).
-- No foreign key on user_id: deleting a user cascades to its chapters, whose
-- delete trigger writes here while the user row is already gone.
create table if not exists public.deleted_chapters (
  book_id uuid not null,
  user_id uuid not null,
  voice text not null,
  section int not null,
  synced_at timestamptz not null default now()
);
alter table public.deleted_chapters drop constraint if exists deleted_chapters_user_id_fkey;
create index if not exists deleted_chapters_synced on public.deleted_chapters (user_id, synced_at);

create or replace function public.log_deleted_chapter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.deleted_chapters (book_id, user_id, voice, section) values (old.book_id, old.user_id, old.voice, old.section);
  -- Devices only need this log until their next pull; keep two months.
  delete from public.deleted_chapters where synced_at < now() - interval '60 days';
  return old;
end $$;

drop trigger if exists log_delete on public.narration_chapters;
create trigger log_delete after delete on public.narration_chapters
  for each row execute function public.log_deleted_chapter();

-- ===== Row level security ====================================================

do $$
declare t text;
begin
  foreach t in array array['books', 'positions', 'highlights', 'narrations', 'narration_chapters', 'worker_status', 'deleted_chapters', 'reading_sessions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ===== Realtime ==============================================================

do $$
declare t text;
begin
  foreach t in array array['books', 'positions', 'highlights', 'narrations', 'narration_chapters', 'worker_status'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===== Storage ===============================================================
-- library/<user>/<book>/{book.epub, cover.jpg, text.json.gz}
-- audio/<user>/<book>/<voice>/<section>.opus

insert into storage.buckets (id, name, public, file_size_limit)
values ('library', 'library', false, 52428800), ('audio', 'audio', false, 52428800)
on conflict (id) do nothing;

drop policy if exists own_files on storage.objects;
create policy own_files on storage.objects for all to authenticated
  using (bucket_id in ('library', 'audio') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('library', 'audio') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Keep-alive: the free tier pauses a project after a week without requests.
-- .github/workflows/keepalive.yml calls this every 3 days with the public key.
create or replace function public.ping() returns text language sql stable as $$ select 'pong' $$;
grant execute on function public.ping() to anon;
