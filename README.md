# Sport Video Analysis

Lean, sport-agnostic web app for uploading match and training videos, marking scenes, analysing them
and sharing playlists. Original brief: [docs/brief.md](docs/brief.md) · Plan and decisions:
[docs/plan.md](docs/plan.md).

**Status:** Milestones 1 (upload & storage), 1b (rotate & trim), 2 (sport profiles, session
setup, analysis player), 3 (tagging) and 4 (analyst review, athletes) implemented.

## Requirements

- Node.js 24 or newer (runs TypeScript directly and includes SQLite — nothing else to install)
- An S3-compatible bucket: Cloudflare R2 with EU jurisdiction (now), Hetzner Object Storage (later)

## Setup

```sh
npm install
cp .env.example .env          # then fill in the S3_* values (see below)
npm run user:create -- --email you@example.com --role analyst
npm run storage:setup         # checks bucket access, sets CORS (needs an admin token, see below)
npm run dev                   # API on :8787, web app on http://localhost:5173
```

Roles: `analyst` (everything, incl. deleting) and `tagger` (create sessions, upload). Running
`user:create` again for an existing email resets the password and role.

### Cloudflare R2 (EU)

1. Cloudflare dashboard → **R2** → **Create bucket**. Under *Location* choose **Specify
   jurisdiction → European Union**. This cannot be changed later.
2. **R2 → Manage API tokens → Create API token**. *Object Read & Write* scoped to the bucket is
   enough for the app. `npm run storage:setup` additionally needs *Admin Read & Write*. Either use a
   temporary admin token for setup, or set CORS by hand (step 4).
3. Put into `.env`:
   ```
   S3_ENDPOINT=https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com
   S3_BUCKET=<bucket name>
   S3_ACCESS_KEY_ID=<token access key id>
   S3_SECRET_ACCESS_KEY=<token secret>
   ```
   The dashboard shows the S3 API URL with the bucket name appended (`…/video-coach`). Leave that
   part off, or every request returns 404. For a bucket without EU jurisdiction, use the endpoint
   without `.eu`.
4. CORS (only if not set by `storage:setup`): bucket → **Settings → CORS policy**:
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["content-type", "range"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Add the production URL to `AllowedOrigins` when deploying. Without `ExposeHeaders: ETag` uploads
   fail with a clear message.

### Hetzner (later)

Same app, different `.env`: `S3_ENDPOINT=https://<location>.your-objectstorage.com`, region e.g.
`fsn1`, keys from the Hetzner console, then `npm run storage:setup`. Moving existing videos is a
bucket-to-bucket copy (e.g. `rclone sync`). Object keys are relative, so the database stays as is.
Hetzner's multipart upload support is still to be verified before switching.

## Deploy

Docker Compose on a server that already runs Traefik (for TLS/routing) and is managed by
[Arcane](https://getarcane.app). Arcane pulls this repo itself (Git Sync) — there is no GitHub
Actions workflow and nothing SSHes in from CI.

**This isn't fully automatic.** This app has a `build:` in its Compose file, not an `image:`
reference, and Arcane's Git Sync (Auto Sync, Redeploy After Sync, Auto Updates) only pulls files
and restarts containers from whatever image already exists — none of it rebuilds the image from
the Dockerfile. So after a sync brings in new code, **Build & Deploy** still has to be triggered
by hand on the project page in Arcane; otherwise the old image keeps running indefinitely.

One-time setup, in Arcane:

1. **Customization → Git Repositories → Add Repository** — this repo's URL (public, no auth needed).
2. **Projects → Create from Git Repo → Pull** — Compose File Path: `docker-compose.yml`.
3. Enable **Auto Sync** (pick an interval) and **Redeploy After Sync** so the container picks up
   non-code changes (e.g. env/compose edits) on its own; otherwise click **Sync from Git** manually.
4. After every push that changes app code, open the project and click **Build & Deploy** to
   actually rebuild the image — Sync alone will not do this.
5. In that project's environment settings, set the real values: `COOKIE_SECURE=true`,
   `APP_ORIGIN=https://<your domain>`, `APP_DOMAIN=<your domain>`, and the `S3_*` keys. These are
   never committed — Arcane merges them into `.env` on the host itself.

`docker-compose.yml` is read-only once synced from git — edit it in this repo, push, then
**Sync from Git** in Arcane to pick up the change. The Traefik network name is the literal
`core-web` in that file (edit and push if yours differs).

There is no CI test gate before deploy: Arcane pulls and redeploys whatever is on `main`, so run
`npm test && npm run typecheck && npm run build` yourself before pushing to `main`.

The image has a Docker `HEALTHCHECK` that polls `GET /api/health` (unauthenticated; checks the
database and S3 are both reachable), so Docker/Arcane show the container as unhealthy if either
breaks. The same check is visible in the app itself under **Status**.

## HTTPS without a domain

The app needs a real secure context — plain HTTP only satisfies that for `http://localhost`.
Anything else over plain HTTP (e.g. a LAN IP) breaks `crypto.randomUUID()` (uploads won't start)
and `Secure` cookies (`COOKIE_SECURE=true` logins won't stick). If there's no domain/Traefik in
front of the app (e.g. `docker-compose.local.yml`), generate a self-signed certificate and have the
app terminate HTTPS itself:

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=video-analysis.local" \
  -addext "subjectAltName=DNS:video-analysis.local,IP:<your LAN IP>,IP:127.0.0.1"
```

Then in `.env`: `TLS_CERT_PATH=/app/certs/cert.pem`, `TLS_KEY_PATH=/app/certs/key.pem`,
`COOKIE_SECURE=true`, and `APP_ORIGIN=https://<your LAN IP or video-analysis.local>:8787`. The
browser will show an untrusted-certificate warning the first time (expected for a self-signed
cert) — proceeding past it still gives a real secure context, so the app works. To avoid the
warning entirely, generate the cert with [mkcert](https://github.com/FiloSottile/mkcert) instead
and trust its local CA on each device.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (auto-restart) + Vite dev server |
| `npm test` | Unit and API tests (`node --test`, fake storage, in-memory DB) |
| `npm run typecheck` | TypeScript check for server and web |
| `npm run build` then `npm start` | Production: one Node process serves API and built web app on `PORT` |
| `npm run user:create -- --email … --role analyst\|tagger` | Create user / reset password |
| `npm run storage:setup [-- https://extra-origin]` | Check bucket, set CORS and the 7-day cleanup of unfinished uploads |

Data lives in `data/app.db` (SQLite). Back it up by copying the file while the app is stopped,
or with `sqlite3 data/app.db ".backup backup.db"` while it runs.

## Testing milestone 1 by hand

1. Sign in, create a *Match* session, drop a large MP4 (2–4 GB). Progress, speed and ETA appear.
2. **Pause** and **Resume**. Then switch Wi-Fi off for ~30 s and on again: the upload waits and
   continues.
3. Close the tab mid-upload, reopen the session: it shows under *Interrupted uploads*. Drop the
   same file again → it continues from the stored parts (marked "resumed").
4. Create a *Training* session and drop 5–10 clips at once. They upload one after another.
5. Check the *Format* column: H.264 shows green, HEVC (e.g. iPhone default) shows a warning that
   says whether this browser can play it.
6. **Play** a video, seek around (HTTP range requests). Try the same video in Chrome and Safari.
7. As analyst, **Delete** a video and the session. The files disappear from the R2 bucket.

## Testing milestone 1b (rotate & trim) by hand

1. Open a video, click **Edit**. Rotate right: the picture turns 90° and fits the frame (portrait).
   Rotate further to 180° and 270°, then **Save**. Reload: the rotation is kept.
2. Play to a point and click **Set to …** for *Start*, then for *End*. The cut-off parts are shaded
   on the timeline. **Save**.
3. Outside edit mode, playback starts at the start point and stops at the end point. The time shows
   the trimmed length, and the slider can't leave the range.
4. **Fullscreen** works with rotation. The session list shows the trimmed duration and the edits.

## Testing milestone 2 (profiles, session setup, analysis player) by hand

1. **Profiles** (top navigation): "Ice Hockey Goalie" exists on first start. Open it, rename an
   attribute, add a choice, change an event type's colour or hotkey. The preview on the right
   updates live. Try the tagger buttons, the form and the click diagrams. **Save**: the version goes up.
2. Create a profile from scratch ("Start empty") and one as a copy. Add a diagram from a template
   and one with your own image (PNG/JPEG/WebP). **Archive** a profile: it no longer appears when
   creating sessions.
3. Invalid input is caught before saving, e.g. the same hotkey twice or a choice attribute
   without choices.
4. **Sessions**: create one with a profile, team and athletes. On the session page, **Edit**
   changes title, type, date, profile, team and athletes. Rename a video with ✎.
5. **Analysis player**: speed 0.25–2×, frame steps, ±5/±10 s, keyboard shortcuts (shown below the
   player). For a match with several files, the part tabs switch between files.
   **Pan & zoom** (all players): Ctrl/⌘ + scroll or trackpad pinch zooms around the pointer, two-finger
   pinch on tablets, −/+ buttons or `=`/`-`. Drag to pan while zoomed; a plain click still plays/pauses.
   Double-click or the % button resets. Works with rotated videos and in fullscreen.
6. **Training**: "Mark whole clip as scene" on a clip, or "Mark all clips without scenes" on the
   session page. Clicking again does not create duplicates (the Scenes column shows the count).
7. Upload a new video and check the bucket: the file is named by its id, not the original name.

## Testing milestone 3 (tagging) by hand

1. On a session with a sport profile, click **Tag** next to a video. Play with **Enter**.
2. Press **Space** while it plays: a grey mark appears on the timeline, playback continues. Press
   an event hotkey (e.g. **S** for Save): a coloured mark appears.
3. Switch the range preset (±5, ±10, ±20 s, −10/+5 s). Then try **Manual**: press Space at the
   start and again at the end; Esc cancels.
4. Click a mark (timeline or list): set or change its category, type a comment, Enter saves.
   **Undo** (or Ctrl/⌘+Z) removes the last mark.
5. Offline test: switch Wi-Fi off (or DevTools → Network → Offline) and make a few marks. The
   badge shows they are kept on this device. Reload the page: they are still there. Go online:
   the badge turns to "All marks saved". Reload again: nothing is missing or duplicated.
6. Sign in as a tagger in another browser: marks by others can be seen but not changed.

## Testing milestone 4 (review, athletes) by hand

1. **Athletes** (top navigation): names entered on sessions appear here. Set the catching hand of
   a goalie (Left/Right). Rename one with ✎.
2. Tag a few moments in a session with one goalie. They are assigned to that goalie automatically.
3. **Review** (analysts only): the queue lists unreviewed scenes per session in time order.
   Click **Start reviewing**.
4. On a scene: **Play scene** plays exactly the marked range. Drag the start/end handles or use
   ±1 frame and "Set to playhead". Change the event type, fill in the form, click positions in
   the diagrams. On the goal diagram the zone reads e.g. "High glove side" (with a catching hand
   set). Mark answers as **Uncertain** or **Unknown**.
5. **Reviewed → next** saves and opens the next scene. Also try **Reject**, **Mark duplicate**
   (choose the original) and **Reopen**. The history at the bottom lists every change with user
   and time.
6. As a tagger: a reviewed scene can no longer be changed in the tagger.
