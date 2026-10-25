create table users (
  id text primary key,
  email text not null unique collate nocase,
  password_hash text not null,
  role text not null check (role in ('tagger', 'analyst')),
  created_at text not null
);

create table auth_sessions (
  token_hash text primary key,
  user_id text not null references users (id) on delete cascade,
  expires_at text not null,
  created_at text not null
);

-- A recorded match/game or a training session. Sport profile fields arrive in milestone 2.
create table sessions (
  id text primary key,
  type text not null check (type in ('match', 'training')),
  title text not null,
  date text,
  meta text not null default '{}' check (json_valid(meta)),
  created_by text references users (id) on delete set null,
  created_at text not null
);

create table video_files (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  part_index integer not null,
  source text not null default 'upload',
  -- Relative object key, so the bucket/provider can change without rewriting rows.
  storage_key text not null unique,
  original_name text not null,
  size_bytes integer not null,
  content_type text,
  status text not null check (status in ('uploading', 'ready', 'failed', 'deleted')),
  -- Multipart upload state while status = 'uploading'.
  upload_id text,
  part_size integer,
  part_count integer,
  -- name:size:lastModified of the local file, used to resume after a reload.
  fingerprint text,
  probe text check (probe is null or json_valid(probe)),
  uploaded_by text references users (id) on delete set null,
  created_at text not null,
  completed_at text,
  deleted_at text
);

create index video_files_session on video_files (session_id, part_index);
create index video_files_resume on video_files (session_id, fingerprint) where status = 'uploading';
