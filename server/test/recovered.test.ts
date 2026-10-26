import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Hono } from 'hono';
import type { OrphanedGroupDto, SessionDto, VideoDto } from '../../shared/types.ts';
import type { AppEnv } from '../src/context.ts';
import { json, setup, type FakeStorage, type RequestOptions } from './helpers.ts';

let app: Hono<AppEnv>;
let storage: FakeStorage;
let analyst: string;
let tagger: string;
let request: (path: string, options?: RequestOptions) => Promise<Response>;

beforeEach(async () => {
  ({ app, storage, analyst, tagger, request } = await setup());
});

async function createSession(cookie: string): Promise<SessionDto> {
  const res = await request('/api/sessions', { cookie, body: { title: 'HC Test vs. Demo', type: 'match', date: '2026-10-18' } });
  return (await json<{ session: SessionDto }>(res, 201)).session;
}

async function groups(cookie: string): Promise<OrphanedGroupDto[]> {
  return (await json<{ groups: OrphanedGroupDto[] }>(await request('/api/recovered-videos', { cookie, method: 'GET' })))
    .groups;
}

test('an empty bucket has no recovered groups', async () => {
  assert.deepEqual(await groups(analyst), []);
});

test('an object with no matching video row shows up grouped by its old session id', async () => {
  storage.putObject('sessions/old-session-1/vid-a.mp4', 1000);
  storage.putObject('sessions/old-session-1/vid-b.mp4', 2000);
  storage.putObject('sessions/old-session-2/vid-c.mov', 500);

  const found = await groups(tagger);
  assert.equal(found.length, 2);
  const group1 = found.find((g) => g.sourceSessionId === 'old-session-1')!;
  assert.equal(group1.videos.length, 2);
  assert.equal(group1.totalBytes, 3000);
});

test('objects outside sessions/ or with an unrecognized shape are ignored', async () => {
  storage.putObject('assets/some-image.png', 123);
  storage.putObject('sessions/no-extension', 10);
  assert.deepEqual(await groups(analyst), []);
});

test('an object backing a real video row is not treated as orphaned', async () => {
  const session = await createSession(analyst);
  const startRes = await request(`/api/sessions/${session.id}/uploads`, {
    cookie: analyst,
    body: { name: 'game.mp4', size: 10, contentType: 'video/mp4', fingerprint: 'f:10:1', probe: null },
  });
  const created = await json<{ video: VideoDto }>(startRes, 201);
  storage.putPart(storage.onlyUploadId(), 1, 10);
  await request(`/api/uploads/${created.video.id}/complete`, {
    cookie: analyst,
    body: { parts: [{ partNumber: 1, etag: '"etag-1"' }] },
  });

  // Same prefix pattern as an orphan, but it's a real, known video.
  assert.deepEqual(await groups(analyst), []);
});

test('importing attaches the object to the target session as a ready video, without re-uploading it', async () => {
  const session = await createSession(analyst);
  storage.putObject('sessions/old-session/vid-a.mp4', 4096);

  const res = await request(`/api/sessions/${session.id}/recovered-videos`, {
    cookie: tagger, // any signed-in user, not just analysts
    body: { storageKeys: ['sessions/old-session/vid-a.mp4'] },
  });
  const { videos } = await json<{ videos: VideoDto[] }>(res, 201);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].status, 'ready');
  assert.equal(videos[0].sizeBytes, 4096);
  assert.equal(videos[0].sessionId, session.id);

  const detail = await json<{ session: { videos: VideoDto[] } }>(
    await request(`/api/sessions/${session.id}`, { cookie: analyst, method: 'GET' }),
  );
  assert.equal(detail.session.videos.length, 1);

  // No longer orphaned once imported.
  assert.deepEqual(await groups(analyst), []);
});

test('a file that cannot be probed still imports, just without probe data', async () => {
  const session = await createSession(analyst);
  storage.putObject('sessions/old-session/vid-a.mp4', 4, new Uint8Array([1, 2, 3, 4]));

  const res = await request(`/api/sessions/${session.id}/recovered-videos`, {
    cookie: analyst,
    body: { storageKeys: ['sessions/old-session/vid-a.mp4'] },
  });
  const { videos } = await json<{ videos: VideoDto[] }>(res, 201);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].probe, null);
});

test('importing into an unknown session is rejected', async () => {
  storage.putObject('sessions/old-session/vid-a.mp4', 10);
  const res = await request('/api/sessions/does-not-exist/recovered-videos', {
    cookie: analyst,
    body: { storageKeys: ['sessions/old-session/vid-a.mp4'] },
  });
  assert.equal(res.status, 404);
});

test('a storage key already attached to a video is skipped rather than duplicated', async () => {
  const session = await createSession(analyst);
  storage.putObject('sessions/old-session/vid-a.mp4', 10);
  await request(`/api/sessions/${session.id}/recovered-videos`, {
    cookie: analyst,
    body: { storageKeys: ['sessions/old-session/vid-a.mp4'] },
  });

  const again = await request(`/api/sessions/${session.id}/recovered-videos`, {
    cookie: analyst,
    body: { storageKeys: ['sessions/old-session/vid-a.mp4'] },
  });
  const { videos } = await json<{ videos: VideoDto[] }>(again, 201);
  assert.equal(videos.length, 0);
});
