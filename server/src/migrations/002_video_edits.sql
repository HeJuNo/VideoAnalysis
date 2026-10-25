-- Non-destructive edits, applied by the player at playback. The stored file is never changed.
alter table video_files add column rotation integer not null default 0
  check (rotation in (0, 90, 180, 270));
alter table video_files add column trim_start_sec real
  check (trim_start_sec is null or trim_start_sec >= 0);
alter table video_files add column trim_end_sec real
  check (trim_end_sec is null or trim_end_sec > coalesce(trim_start_sec, 0));
