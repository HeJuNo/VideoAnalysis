import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Hono } from 'hono';
import type { VideoProbe } from '../../shared/mp4-probe.ts';
import type { CreateUploadResponse, SessionDetailDto, SessionDto, VideoDto } from '../../shared/types.ts';
import type { AppEnv } from '../src/context.ts';
import { json, MIB, ORIGIN, setup, type FakeStorage, type RequestOptions } from './helpers.ts';

let app: Hono<AppEnv>;
let storage: FakeStorage;
let analyst: string;
let tagger: string;
let request: (path: string, options?: RequestOptions) => Promise<Response>;

beforeEach(async () => {
  ({ app, storage, analyst, tagger, request } = await setup());
});

async function createSession(cookie: string, type = 'match'): Promise<SessionDto> {
  const res = await request('/api/sessions', { cookie, body: { title: 'HC Test vs. Demo', type, date: '2026-10-18' } });
  return (await json<{ session: SessionDto }>(res, 201)).session;
}

async function startUpload(
  sessionId: string,
  cookie: string,
  size: number,
  fingerprint = `game.mp4:${size}:1`,
  probe: VideoProbe | null = null,
) {
  return request(`/api/sessions/${sessionId}/uploads`, {
    cookie,
    body: { name: 'game.mp4', size, contentType: 'video/mp4', fingerprint, probe },
  });
}

/** A single-part upload taken all the way to `ready`. */
async function readyVideo(cookie: string, probe: VideoProbe | null = null): Promise<VideoDto> {
  const session = await createSession(cookie);
  const created = await json<CreateUploadResponse>(
    await startUpload(session.id, cookie, MIB, `clip.mp4:${MIB}:1`, probe),
    201,
  );
  storage.putPart(storage.onlyUploadId(), 1, MIB);
  const done = await request(`/api/uploads/${created.video.id}/complete`, {
    cookie,
    body: { parts: [{ partNumber: 1, etag: '"etag-1"' }] },
  });
  return (await json<{ video: VideoDto }>(done)).video;
}

const probe60s: VideoProbe = {
  container: 'mp4',
  videoCodec: 'avc1',
  codecFamily: 'h264',
  width: 1920,
  height: 1080,
  durationSec: 60,
  fps: 25,
  variableFrameRate: false,
  faststart: true,
  fragmented: false,
  audioCodec: 'mp4a',
};

test('rejects wrong passwords and anonymous requests', async () => {
  const res = await request('/api/auth/login', { body: { email: 'analyst@test.dev', password: 'nope' } });
  assert.equal(res.status, 401);
  assert.equal((await request('/api/sessions')).status, 401);
  assert.equal((await request('/api/auth/me', { cookie: 'sid=forged' })).status, 401);
  assert.equal((await request('/api/auth/me', { cookie: analyst })).status, 200);
});

test('logout ends the session', async () => {
  assert.equal((await request('/api/auth/logout', { cookie: analyst, method: 'POST' })).status, 204);
  assert.equal((await request('/api/auth/me', { cookie: analyst })).status, 401);
});

test('rejects cross-site form posts and non-JSON bodies', async () => {
  const crossSite = await app.request('/api/sessions', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded', cookie: analyst },
    body: 'title=x&type=match',
  });
  assert.equal(crossSite.status, 403);

  const plainText = await app.request('/api/sessions', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain', cookie: analyst },
    body: '{"title":"x","type":"match"}',
  });
  assert.equal(plainText.status, 415);
});

test('uploads a multi-part file, then plays and deletes it', async () => {
  const session = await createSession(tagger);
  const size = 40 * MIB;
  const created = await json<CreateUploadResponse>(await startUpload(session.id, tagger, size), 201);
  assert.equal(created.partCount, 3);
  assert.equal(created.resumed, false);
  assert.equal(created.video.status, 'uploading');

  const { urls } = await json<{ urls: { partNumber: number; url: string }[] }>(
    await request(`/api/uploads/${created.video.id}/part-urls`, { cookie: tagger, body: { partNumbers: [1, 2, 3] } }),
  );
  assert.deepEqual(
    urls.map((u) => u.partNumber),
    [1, 2, 3],
  );
  const outOfRange = await request(`/api/uploads/${created.video.id}/part-urls`, {
    cookie: tagger,
    body: { partNumbers: [4] },
  });
  assert.equal(outOfRange.status, 400);

  const uploadId = storage.onlyUploadId();
  const sizes = [created.partSize, created.partSize, size - 2 * created.partSize];
  sizes.forEach((s, i) => storage.putPart(uploadId, i + 1, s));
  const parts = sizes.map((_, i) => ({ partNumber: i + 1, etag: `"etag-${i + 1}"` })).reverse();

  const done = await json<{ video: { status: string } }>(
    await request(`/api/uploads/${created.video.id}/complete`, { cookie: tagger, body: { parts } }),
  );
  assert.equal(done.video.status, 'ready');

  const detail = await json<{ session: SessionDetailDto }>(await request(`/api/sessions/${session.id}`, { cookie: tagger }));
  assert.equal(detail.session.videoCount, 1);
  assert.equal(detail.session.totalBytes, size);

  const playback = await json<{ url: string }>(await request(`/api/videos/${created.video.id}/playback`, { cookie: tagger }));
  assert.match(playback.url, /signed/);

  assert.equal((await request(`/api/videos/${created.video.id}`, { cookie: tagger, method: 'DELETE' })).status, 403);
  assert.equal((await request(`/api/videos/${created.video.id}`, { cookie: analyst, method: 'DELETE' })).status, 204);
  assert.equal(storage.objects.size, 0);
  const after = await json<{ session: SessionDetailDto }>(await request(`/api/sessions/${session.id}`, { cookie: tagger }));
  assert.equal(after.session.videos.length, 0);
});

test('resumes an interrupted upload of the same file', async () => {
  const session = await createSession(tagger, 'training');
  const size = 40 * MIB;
  const first = await json<CreateUploadResponse>(await startUpload(session.id, tagger, size), 201);
  storage.putPart(storage.onlyUploadId(), 1, first.partSize);

  const again = await json<CreateUploadResponse>(await startUpload(session.id, tagger, size));
  assert.equal(again.resumed, true);
  assert.equal(again.video.id, first.video.id);
  assert.deepEqual(
    again.completedParts.map((p) => p.partNumber),
    [1],
  );

  // A different file starts a new upload with the next part index.
  const other = await json<CreateUploadResponse>(await startUpload(session.id, tagger, size, 'other.mp4:1:1'), 201);
  assert.equal(other.video.partIndex, 1);
});

test('starts over when the stored upload has expired', async () => {
  const session = await createSession(tagger);
  const first = await json<CreateUploadResponse>(await startUpload(session.id, tagger, MIB), 201);
  storage.uploads.clear();
  const again = await json<CreateUploadResponse>(await startUpload(session.id, tagger, MIB), 201);
  assert.notEqual(again.video.id, first.video.id);
  assert.equal(again.resumed, false);
});

test('refuses to complete with missing parts or a size mismatch', async () => {
  const session = await createSession(tagger);
  const created = await json<CreateUploadResponse>(await startUpload(session.id, tagger, 40 * MIB), 201);
  const missing = await request(`/api/uploads/${created.video.id}/complete`, {
    cookie: tagger,
    body: { parts: [{ partNumber: 1, etag: '"a"' }] },
  });
  assert.equal(missing.status, 400);

  const uploadId = storage.onlyUploadId();
  [1, 2, 3].forEach((n) => storage.putPart(uploadId, n, MIB));
  const parts = [1, 2, 3].map((n) => ({ partNumber: n, etag: `"etag-${n}"` }));
  const res = await request(`/api/uploads/${created.video.id}/complete`, { cookie: tagger, body: { parts } });
  assert.equal(res.status, 409);
  assert.equal(storage.objects.size, 0);
});

test('rejects oversized files and access to other users’ uploads', async () => {
  const session = await createSession(tagger);
  assert.equal((await startUpload(session.id, tagger, 11 * 1024 * MIB)).status, 400);

  const created = await json<CreateUploadResponse>(await startUpload(session.id, analyst, MIB), 201);
  const res = await request(`/api/uploads/${created.video.id}/part-urls`, { cookie: tagger, body: { partNumbers: [1] } });
  assert.equal(res.status, 403);
});

test('cancelling an upload aborts it in storage', async () => {
  const session = await createSession(tagger);
  const created = await json<CreateUploadResponse>(await startUpload(session.id, tagger, MIB), 201);
  assert.equal((await request(`/api/uploads/${created.video.id}`, { cookie: tagger, method: 'DELETE' })).status, 204);
  assert.equal(storage.uploads.size, 0);
  assert.equal((await request(`/api/videos/${created.video.id}`, { cookie: tagger })).status, 404);
});

test('deleting a session removes its stored files and pending uploads', async () => {
  const session = await createSession(tagger);
  await startUpload(session.id, tagger, MIB);
  assert.equal(storage.uploads.size, 1);
  assert.equal((await request(`/api/sessions/${session.id}`, { cookie: tagger, method: 'DELETE' })).status, 403);
  assert.equal((await request(`/api/sessions/${session.id}`, { cookie: analyst, method: 'DELETE' })).status, 204);
  assert.equal(storage.uploads.size, 0);
  assert.equal((await request(`/api/sessions/${session.id}`, { cookie: analyst })).status, 404);
});

test('rotates and trims a video without touching the stored file', async () => {
  const video = await readyVideo(tagger, probe60s);
  assert.deepEqual([video.rotation, video.trimStartSec, video.trimEndSec], [0, null, null]);

  const patch = (body: unknown) => request(`/api/videos/${video.id}`, { cookie: tagger, method: 'PATCH', body });

  const rotated = await json<{ video: VideoDto }>(await patch({ rotation: 90 }));
  assert.equal(rotated.video.rotation, 90);

  const trimmed = await json<{ video: VideoDto }>(await patch({ trimStartSec: 12.34567, trimEndSec: 45 }));
  assert.deepEqual([trimmed.video.rotation, trimmed.video.trimStartSec, trimmed.video.trimEndSec], [90, 12.346, 45]);

  // Omitted fields keep their value; null clears; a start of 0 means "from the beginning".
  const cleared = await json<{ video: VideoDto }>(await patch({ trimStartSec: 0, trimEndSec: null }));
  assert.deepEqual([cleared.video.rotation, cleared.video.trimStartSec, cleared.video.trimEndSec], [90, null, null]);
  assert.equal(storage.objects.size, 1);
});

test('rejects invalid edits', async () => {
  const video = await readyVideo(tagger, probe60s);
  const patch = (body: unknown) => request(`/api/videos/${video.id}`, { cookie: tagger, method: 'PATCH', body });

  assert.equal((await patch({ rotation: 45 })).status, 400);
  assert.equal((await patch({ trimStartSec: 30, trimEndSec: 20 })).status, 400);
  assert.equal((await patch({ trimStartSec: 30, trimEndSec: 30.5 })).status, 400);
  assert.equal((await patch({ trimStartSec: 61 })).status, 400);
  assert.equal((await patch({ trimEndSec: 75 })).status, 400);
  assert.equal((await patch({ trimEndSec: 60.5 })).status, 200);
  assert.equal((await patch({ speed: 2 })).status, 400);
  assert.equal((await request(`/api/videos/${video.id}`, { method: 'PATCH', body: { rotation: 90 } })).status, 401);
});

test('only finished uploads can be edited', async () => {
  const session = await createSession(tagger);
  const created = await json<CreateUploadResponse>(await startUpload(session.id, tagger, MIB), 201);
  const res = await request(`/api/videos/${created.video.id}`, { cookie: tagger, method: 'PATCH', body: { rotation: 180 } });
  assert.equal(res.status, 409);
});

test('stored files are named by id, not by the original file name', async () => {
  const session = await createSession(tagger);
  const res = await request(`/api/sessions/${session.id}/uploads`, {
    cookie: tagger,
    body: { name: 'Mia Keller – Game 1.MOV', size: MIB, contentType: 'video/quicktime', fingerprint: 'mia:1', probe: null },
  });
  const created = await json<CreateUploadResponse>(res, 201);
  assert.equal(created.video.name, 'Mia Keller – Game 1.MOV');
  const [{ key }] = [...storage.uploads.values()];
  assert.equal(key, `sessions/${session.id}/${created.video.id}.mov`);
});
