-- Point-in-time marks (moments, period start/end) are stored as scenes with marker = 1 and a
-- minimal range. They are not reviewed, so the review queue skips them.
alter table scenes add column marker integer not null default 0 check (marker in (0, 1));
