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

Docker Compose on a server that already runs Traefik (for TLS/routing). GitHub Actions runs the
test/typecheck/build gate on every push to `main`, then SSHes in and redeploys.

One-time setup on the server:

```sh
git clone <repo-url> && cd <repo-dir>
cp .env.example .env   # fill in real values: COOKIE_SECURE=true, APP_ORIGIN=https://<your domain>,
                       # APP_DOMAIN=<your domain>, TRAEFIK_NETWORK=<your Traefik network name>, S3_*
mkdir -p data          # bind-mounted so the SQLite db survives redeploys
```

`docker-compose.yml` itself is never edited — the Traefik network name and `Host(...)` domain come
from `APP_DOMAIN`/`TRAEFIK_NETWORK` in `.env`, so `git pull` never collides with local changes to it.

GitHub Actions secrets needed (repo → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_SSH_HOST` | server's address |
| `DEPLOY_SSH_USER` | SSH user on the server |
| `DEPLOY_SSH_KEY` | private half of a dedicated deploy key (not your personal key) — add the public half to that user's `authorized_keys` |
| `DEPLOY_PATH` | absolute path to the cloned repo on the server |

After that, `git push` to `main` builds, tests and redeploys automatically.

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
