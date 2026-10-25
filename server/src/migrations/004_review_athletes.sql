-- Athletes become records (with catching/dominant hand); sessions link to them and scenes can be
-- assigned to one. Existing session athlete names are converted, merging names that differ only
-- in case or surrounding spaces.
create table athletes (
  id text primary key,
  name text not null unique collate nocase,
  catch_hand text check (catch_hand in ('left', 'right')),
  created_at text not null
);

create table session_athletes (
  session_id text not null references sessions (id) on delete cascade,
  athlete_id text not null references athletes (id) on delete cascade,
  position integer not null,
  primary key (session_id, athlete_id)
);

insert into athletes (id, name, created_at)
  select lower(hex(randomblob(16))), min(trim(j.value)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  from sessions s, json_each(s.athletes) j
  where trim(j.value) != ''
  group by lower(trim(j.value));

insert or ignore into session_athletes (session_id, athlete_id, position)
  select s.id, a.id, j.key
  from sessions s, json_each(s.athletes) j
  join athletes a on a.name = trim(j.value) collate nocase;

alter table sessions drop column athletes;

-- Analyst review. `annotation` holds the profile-driven answers:
-- { values: {attributeKey: value}, points: {diagramKey: {x, y}},
--   valueFlags / pointFlags: {key: "unknown" | "uncertain"} }
alter table scenes add column athlete_id text references athletes (id) on delete set null;
alter table scenes add column annotation text not null default '{}' check (json_valid(annotation));
alter table scenes add column duplicate_of text references scenes (id) on delete set null;
alter table scenes add column reviewed_by text references users (id) on delete set null;
alter table scenes add column reviewed_at text;
alter table scenes add column updated_at text;

-- Audit trail: who changed what, and when.
create table scene_events (
  id integer primary key autoincrement,
  scene_id text not null references scenes (id) on delete cascade,
  user_id text references users (id) on delete set null,
  action text not null,
  changes text not null check (json_valid(changes)),
  at text not null
);

create index scene_events_scene on scene_events (scene_id, id);
create index scenes_status on scenes (status, session_id);
