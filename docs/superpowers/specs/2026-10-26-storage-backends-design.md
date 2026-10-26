# Multiple storage backends (Local + Cloud/S3)

## Intent and why

Today every video lives in one Cloudflare R2 bucket via the plain S3 API (`server/src/storage.ts`'s
`ObjectStorage`). The user wants the option — not the default — to keep some videos on a locally
mounted drive instead, on a per-upload basis. Motivation: wanting some videos to stay local rather
than in the cloud, but local is secondary to Cloud/S3, which remains the default and primary
backend. The mount is a separate drive/NAS attached to the server, not the same disk the app and
SQLite database live on, so it doesn't compete with the app for space.

## Goals

- A new "Storage" settings page (in-app, not env vars) where an analyst configures a local path,
  enables/disables it, sees free/used space on that mount, and tests that it's actually writable
  before it can be turned on.
- A storage picker shown when starting an upload: Cloud (always available) or Local (only shown
  when enabled and its last test passed). Each video remembers which backend it used.
- Local-backed videos play back correctly (seeking/scrubbing works, i.e. HTTP range requests are
  honored) and can be deleted, same as Cloud-backed ones.
- The existing recovered-videos (orphan import) and health-check features extend to cover the
  local backend too, not just Cloud.
- A per-video **"Move to Cloud"** action that copies a Local video's bytes to S3 and switches it
  over, for when Local gets disabled (see below) or an operator just wants something off the NAS.

## Non-goals

- No move from Cloud to Local — only Local → Cloud (see Goals) is supported.
- No per-session or per-team default backend preference — the picker is manual, every time.
- No replication/mirroring of a video across both backends.
- No support for more than one local mount at a time, or more than one S3 bucket at a time.

## Anti-goals (would make this a failure even if it technically works)

- Local storage must never be able to fill the disk the app/database live on. (Mitigated by this
  being a separate mount, but the settings page's free-space display and test-before-enable step
  exist specifically so a nearly-full mount is visible before it causes a failed upload.)
- A local video's playback must not silently fall back to downloading the whole file — range
  requests must work, or scrubbing a large match recording becomes unusable.
- A `key`/path derived from user or video data must never let server-side file access escape the
  configured local root (path traversal).

## Constraints

- Single Node process, same deployment model as today (Docker Compose via Arcane); the local mount
  is a bind mount or volume added to that container, configured by the server operator outside the
  app (the app only needs a path *inside the container* to point at).
- Must fit the existing `ObjectStorage` interface shape where practical, since `videos.ts`,
  `uploads.ts`, `recovered.ts`, and the health check all code against it already.
- `node:sqlite` migrations convention (`server/src/migrations/NNN_*.sql`), applied at startup.

## Decided design

### Why uploads can't stay "direct-to-storage" for Local

Cloud uploads today are browser → presigned S3 URL → bucket; the Node server never sees the bytes.
There's no presigned-URL equivalent for a local filesystem. For Local uploads, each multipart chunk
is PUT by the browser to the Node server itself (a same-origin, cookie-authenticated request — no
separate signing scheme needed, since the browser already carries the session cookie), and the
server writes it to the mount. This is slower and uses server bandwidth/CPU that Cloud uploads
don't, which is expected and fine given Local is the secondary, occasional path.

### Schema

```sql
-- One row per setting; starts empty (Local disabled) until configured in the Storage page.
create table app_settings (
  key text primary key,
  value text not null
);
-- keys used: 'local_storage_enabled' ('true'/'false'), 'local_storage_path'

alter table video_files add column storage_kind text not null default 's3' check (storage_kind in ('s3', 'local'));
```

### `ObjectStorage` per backend

Two implementations of the existing `ObjectStorage` interface (`server/src/storage.ts`):
`createS3Storage` (already exists, unchanged) and a new `createLocalStorage(rootPath)`. The app
holds both behind a small lookup, e.g. `type StorageByKind = Record<'s3' | 'local', ObjectStorage>`,
and every route that currently takes a single `storage: ObjectStorage` picks the right one by the
video's (or request's) `storage_kind`.

`createLocalStorage`:

- `createMultipartUpload` / `listParts` / `completeMultipartUpload` / `abortMultipartUpload`: parts
  land in a temp dir under the root (e.g. `<root>/.uploads/<uploadId>/<partNumber>`);
  `completeMultipartUpload` concatenates them in order into `<root>/<key>` and removes the temp dir.
- A new route (e.g. `PUT /api/local-storage/parts/:uploadId/:partNumber`, normal cookie auth, under
  `/api/*`) receives each part's raw body and writes it to that temp dir — this is what
  `presignUploadPart`/`presignPut` return a URL *to*, instead of a signed S3 URL.
- `presignGet` returns a same-origin, cookie-authed URL (e.g. `/api/local-storage/objects/<key>`)
  that streams the file and **must** support `Range` requests (HTTP 206) for playback scrubbing.
- `headObject` → `fs.stat`; `deleteObject` → `fs.unlink`; `listObjects(prefix)` → recursive
  `fs.readdir` under `<root>/<prefix>`; `getObjectRange` → read at a byte offset (reused by
  recovered-videos' server-side MP4 probing, same as the S3 implementation).
- `ping()` writes and removes a small probe file under the root (not just a stat), so "Test" on the
  settings page actually proves write access, not just that the path exists.
- **Every path built from a `key` is resolved and checked to stay inside `<root>`** (reject any key
  that normalizes outside it) — this is the path-traversal guard from the anti-goals above.

### Settings page

New page (nav item, analyst-only to change; read-only view for others is fine, or just restrict the
whole page to analysts — left to the builder, see below). Shows:

- Cloud (S3): status from the existing health check (`GET /api/health`'s `storage` field already
  covers this — no new check needed here, just display it).
- Local: enabled toggle, path field, free/used space (read via `fs.statfs` on the configured path),
  and a "Test" button that calls `ping()` and reports pass/fail before the toggle can be turned on.
  Settings are read/written through a small new endpoint backed by the `app_settings` table.

### Upload picker

Wherever an upload is started today (`web/src/uploads/`), add a Cloud/Local choice, hidden down to
just "Cloud" when Local isn't enabled. The chosen backend is sent with the upload-start request and
stored as that video's `storage_kind`.

### Disabling Local, changing its path, and moving videos to Cloud

Resolved with the user directly (not left to the builder):

- **Turning Local off** makes existing local videos fully inaccessible (no playback, no delete)
  until it's turned back on — it is *not* just "hidden from new uploads." Re-enabling with the same
  path restores access; nothing is deleted by disabling.
- **Changing the configured path** is blocked outright while any `video_files` row has
  `storage_kind = 'local'` and `status != 'deleted'` (a guard query before saving the new path in
  `app_settings`) — the operator must move or delete those videos first. This is stricter than
  disabling because an old path can be restored by re-entering it, but a *changed* path orphans
  every existing local key with no way back short of moving the mount again.
- **"Move to Cloud"** (per video, shown wherever a local video's actions are — e.g. the session
  page) is the escape hatch for both of the above: it reads the local object (reusing
  `getObjectRange`/`headObject` against the local `ObjectStorage`), uploads those bytes to S3 via
  the server's own S3 client (a normal server-side `PutObject`/multipart upload — not a browser
  presigned flow, since this is server-initiated, not a user's file picker), then — only once the
  upload is confirmed (matching `headObject` size check, same pattern as `uploads.ts`'s own
  complete handler) — updates that row's `storage_kind` to `'s3'` and deletes the local file. If
  anything fails partway, the row is left as-is (`storage_kind` still `'local'`) and the operation
  can be retried; it never deletes the local copy before the S3 copy is verified.

### Health check and recovered-videos extensions

- `GET /api/health`: add a `localStorage: { ok, enabled }` field alongside `database`/`storage`.
  **When Local is enabled**, its `ping()` result participates in the overall `ok`/503 exactly like
  Cloud's does today (confirmed with the user: an enabled-but-unreachable NAS should fail health
  the same way an unreachable bucket does, even though Local is the secondary backend). **When
  disabled**, it's skipped and reported as `ok: true` — a disabled backend being unreachable isn't
  a failure.
- `recovered.ts`: scan both backends' `listObjects('sessions/')`, tag each found object with which
  backend it came from, and carry that through `OrphanedVideoDto`/`OrphanedGroupDto` so import
  writes the correct `storage_kind`. Also tightens an existing gap found during review: the import
  endpoint currently accepts any `storageKeys` string without requiring it to match the expected
  `sessions/<id>/<id>.<ext>` shape (`KEY_PATTERN`) — it should reject (not silently default the
  extension for) a key that doesn't match, for both backends, so it can't be used to pull an
  arbitrary file under the storage root into the app as a "video."

## Calls made without going back to the user (settled, not open)

- **Path safety guard:** rather than relying on "trust the analyst," saving a local path rejects
  one that resolves to the same directory as, or an ancestor/descendant of, the directory holding
  `DATABASE_PATH` (already resolvable via `loadDatabasePath()` in `config.ts`). Cheap, no normal
  user-facing effect, and it's the concrete version of the stated anti-goal rather than just a
  documentation note.
- **"Last test passed" isn't a separate stored flag.** Enabling the toggle requires a passing
  `Test` click in the same save; after that, the upload picker's "show Local" condition is simply
  `local_storage_enabled = true` (no extra `app_settings` key). A later failure shows up through
  the health check / Settings page, not by the picker silently hiding itself mid-session.

## What's left to the builder

- Exact routing/naming for the new local-storage part-upload, object-serving, and move-to-cloud
  endpoints.
- Exact settings-page layout/copy, and whether non-analysts can view it read-only or not at all.
- Whether the temp-upload directory under the local root needs its own cleanup-on-startup pass
  (e.g. for uploads abandoned mid-way after a crash) — reasonable to add, not required for v1.
- Test coverage approach for the new `ObjectStorage` implementation (a temp-directory-backed test,
  parallel to how `FakeStorage` stands in for S3 in existing tests).
- Whether "Move to Cloud" needs its own progress/queue UI (large files) or can be a simple
  synchronous button-click-and-wait for v1 — the design only commits to the server-side mechanism
  (verify-then-switch-then-delete) and to it being retryable, not to the UI's shape.
