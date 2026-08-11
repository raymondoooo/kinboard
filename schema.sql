-- Kinboard — single-household SQLite schema.
--
-- Applied idempotently on every boot (see server/db.js), so upgrading the
-- container picks up new tables without a migration step. That means changes
-- here must stay additive: `create table if not exists` / `create index if not
-- exists`, never a destructive ALTER.
--
-- There is one household and one shared password, enforced in application code
-- (server/auth.js) — no per-user accounts and no row-level security to model.
-- SQLite has no array/JSON or boolean types, so arrays and JSON live in TEXT
-- columns holding JSON and booleans in INTEGER 0/1; server/db.js converts both
-- transparently on read and write.

-- Single row (id = 1): the shared login. Created by the /setup wizard on first run.
create table if not exists household (
  id             integer primary key check (id = 1),
  password_hash  text not null,
  session_secret text not null,
  created_at     text not null default (datetime('now'))
);

-- Single row (id = 1): everything that used to live on the `tenants` row minus
-- billing/plan/subdomain fields, which don't apply to a self-hosted instance.
create table if not exists settings (
  id                 integer primary key check (id = 1),
  name               text not null default 'Our Family',
  time_zone          text not null default 'America/New_York',
  weeks_to_show      integer not null default 4,
  first_day_of_week  integer not null default 0,        -- 0 = Sunday
  theme              text not null default 'dark',
  zip                text,                                -- weather location (geocoded below)
  latitude           real,                                -- cached geocode of zip
  longitude          real,
  weather_units      text not null default 'fahrenheit',
  holidays           text not null default '[]',          -- JSON array of selected holiday keys
  is_public          integer not null default 0,          -- read-only public calendar?
  share_token        text,                                 -- secret for read-only share page + .ics feed
  share_keywords     text not null default '[]',          -- JSON array of title keywords that auto-share
  point_value_cents  integer not null default 0,          -- what one chore point is worth; 0 = points only, no money
  currency_symbol    text not null default '$',
  created_at         text not null default (datetime('now'))
);

-- Family members shown on the calendar (name/color/emoji tags) — no login of
-- their own; everyone shares the one household password.
create table if not exists members (
  id           text primary key,
  display_name text,
  color        text,                                       -- hex, e.g. "#f472b6"
  emoji        text,                                        -- optional per-person emoji prefix
  member_type  text not null default 'person',              -- 'person' | 'category' (Family/Birthday/…)
  created_at   text not null default (datetime('now'))
);

create table if not exists events (
  id             text primary key,
  title          text not null,
  date           text not null,
  start_time     text,
  end_time       text,
  all_day        integer not null default 1,
  people         text not null default '[]',                -- JSON array, matches members.display_name
  location       text,
  recurring      text,                                       -- 'daily' | 'weekly' | 'monthly' | 'yearly' | 'monthly_dow' | null
  ends_on        text,
  exdates        text not null default '[]',                -- JSON array of excluded/detached occurrence dates
  rrule          text,                                        -- RFC5545 RRULE value, no prefix
  share_override text,                                        -- per-event share escape hatch: always | never | null=follow keywords
  created_at     text not null default (datetime('now')),
  updated_at     text not null default (datetime('now'))
);

create table if not exists feeds (
  id             text primary key,
  name           text not null,
  url            text not null,
  fixed_person   text,
  color          text,
  last_synced_at text,
  emoji          text,                                        -- optional per-feed emoji
  display_name   text,                                        -- UI label (falls back to name)
  category       text not null default 'personal',            -- personal|family|birthday|anniversary|holiday
  never_share    integer not null default 0                   -- exclude this feed from share links entirely
);

create table if not exists meals (
  id         text primary key,
  date       text not null,
  meal_type  text not null,                        -- 'breakfast' | 'lunch' | 'dinner' | 'snack'
  title      text not null,
  people     text not null default '[]',            -- JSON array, matches members.display_name
  notes      text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists todos (
  id           text primary key,
  title        text not null,
  done         integer not null default 0,
  people       text not null default '[]',          -- JSON array, assignees
  due_date     text,
  recurring    text,                                 -- 'daily' | 'weekly' | 'monthly' | null (chores)
  notes        text,
  points       integer not null default 0,          -- reward for completing; 0 = not a paid chore
  created_at   text not null default (datetime('now')),
  updated_at   text not null default (datetime('now')),
  completed_at text
);

-- Every completion of a chore, as an append-only ledger.
--
-- This can't be derived from `todos`: a REPEATING chore never stays done — it
-- advances to its next due date — so the row itself remembers nothing about the
-- times it was completed. Without a ledger, the exact chores you most want to
-- pay out on would be worth nothing. Points are copied in at completion time so
-- editing a chore's value later can't silently rewrite what someone already
-- earned.
create table if not exists chore_completions (
  id           text primary key,
  todo_id      text,                                 -- nullable: history outlives a deleted chore
  title        text not null,                        -- snapshot, so deleting the chore keeps the record readable
  person       text not null,                        -- member display_name credited
  points       integer not null default 0,           -- snapshot of the value at completion time
  completed_at text not null default (datetime('now')),
  paid_out_at  text                                  -- set when a parent settles up; null = still owed
);

create index if not exists chore_completions_person_idx on chore_completions (person, completed_at);

-- Web Push. A subscription is a DEVICE, not a person — Kinboard has one shared
-- household password and no individual logins, so each device declares who it
-- cares about (notify_people) rather than being tied to a user account.
--
-- device_id is a client-generated id kept in the browser's localStorage. It
-- survives the push subscription being recreated (browsers reissue endpoints),
-- and lets a write skip notifying the very device that made it.
create table if not exists push_subscriptions (
  id                text primary key,
  device_id         text,                               -- client-generated, stable across resubscribes
  endpoint          text not null unique,               -- push service URL; the identity of a subscription
  p256dh            text not null,                      -- client public key (payload encryption)
  auth              text not null,                      -- client auth secret (payload encryption)
  label             text,                               -- "Dad's phone"
  notify_people     text not null default '[]',         -- JSON array of member display_names; [] = everything
  digest_enabled    integer not null default 1,
  reminders_enabled integer not null default 1,
  on_add_enabled    integer not null default 1,         -- push when an event is added for a watched person
  reminder_minutes  integer not null default 60,        -- lead time for event reminders
  created_at        text not null default (datetime('now'))
);

-- Single row (id = 1): the server's VAPID keypair. Auto-generated on first use
-- (see server/push.js) so self-hosters have zero key management to do. Kept out
-- of `settings` because these are secrets, not calendar preferences.
create table if not exists push_config (
  id           integer primary key check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  created_at   text not null default (datetime('now'))
);

create index if not exists events_date_idx on events (date);
create index if not exists meals_date_idx on meals (date);
create index if not exists todos_due_date_idx on todos (due_date);
