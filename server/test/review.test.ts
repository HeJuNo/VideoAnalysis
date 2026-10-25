import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { VideoProbe } from '../../shared/mp4-probe.ts';
import type {
  AthleteDto,
  CreateUploadResponse,
  ReviewQueueItemDto,
  SceneDetailDto,
  SceneDto,
  SessionDto,
  VideoDto,
} from '../../shared/types.ts';
import { ensureSeedProfiles } from '../src/seed-profiles.ts';
import { json, MIB, setup, type TestContext } from './helpers.ts';

let ctx: TestContext;
let profileId: string;

const probe: VideoProbe = {
  container: 'mp4',
  videoCodec: 'avc1',
  codecFamily: 'h264',
  width: 1920,
  height: 1080,
  durationSec: 1200,
  fps: 25,
  variableFrameRate: false,
  faststart: true,
  fragmented: false,
  audioCodec: 'mp4a',
};

beforeEach(async () => {
  ctx = await setup();
  ensureSeedProfiles(ctx.db);
  profileId = String(ctx.db.prepare('select id from sport_profiles').get()!.id);
});

async function newSession(body: Record<string, unknown> = {}): Promise<SessionDto> {
  const res = await ctx.request('/api/sessions', {
    cookie: ctx.tagger,
    body: { title: 'Game', type: 'match', sportProfileId: profileId, ...body },
  });
  return (await json<{ session: SessionDto }>(res, 201)).session;
}

async function readyVideo(sessionId: string): Promise<VideoDto> {
  const created = await json<CreateUploadResponse>(
    await ctx.request(`/api/sessions/${sessionId}/uploads`, {
      cookie: ctx.tagger,
      body: { name: 'p1.mp4', size: MIB, contentType: 'video/mp4', fingerprint: `p:${Math.random()}`, probe },
    }),
    201,
  );
  ctx.storage.putPart(ctx.storage.onlyUploadId(), 1, MIB);
  const done = await ctx.request(`/api/uploads/${created.video.id}/complete`, {
    cookie: ctx.tagger,
    body: { parts: [{ partNumber: 1, etag: '"etag-1"' }] },
  });
  return (await json<{ video: VideoDto }>(done)).video;
}

async function mark(videoId: string, startSec: number, eventTypeKey: string | null = 'save'): Promise<SceneDto> {
  const res = await ctx.request('/api/scenes', {
    cookie: ctx.tagger,
    body: { videoId, startSec, endSec: startSec + 10, eventTypeKey },
  });
  return (await json<{ scene: SceneDto }>(res, 201)).scene;
}

const review = (ref: string, body: Record<string, unknown>, cookie = ctx.analyst) =>
  ctx.request(`/api/scenes/${ref}`, { cookie, method: 'PATCH', body });

test('athletes are records shared across sessions; names match ignoring case', async () => {
  const first = await newSession({ athletes: ['Mia K.', 'Leo B.'] });
  const second = await newSession({ athletes: ['mia k.'] });
  assert.equal(second.athletes[0].id, first.athletes[0].id);

  const { athletes } = await json<{ athletes: AthleteDto[] }>(await ctx.request('/api/athletes', { cookie: ctx.tagger }));
  assert.deepEqual(
    athletes.map((a) => a.name),
    ['Leo B.', 'Mia K.'],
  );

  const mia = await json<{ athlete: AthleteDto }>(
    await ctx.request(`/api/athletes/${first.athletes[0].id}`, { cookie: ctx.analyst, method: 'PATCH', body: { catchHand: 'left' } }),
  );
  assert.equal(mia.athlete.catchHand, 'left');
  const clash = await ctx.request(`/api/athletes/${first.athletes[0].id}`, {
    cookie: ctx.analyst,
    method: 'PATCH',
    body: { name: 'LEO B.' },
  });
  assert.equal(clash.status, 409);

  const session = await json<{ session: SessionDto }>(await ctx.request(`/api/sessions/${second.id}`, { cookie: ctx.tagger }));
  assert.equal(session.session.athletes[0].catchHand, 'left');
});

test('a scene in a single-athlete session is assigned to that athlete', async () => {
  const solo = await newSession({ athletes: ['Mia K.'] });
  const scene = await mark((await readyVideo(solo.id)).id, 30);
  assert.equal(scene.athleteId, solo.athletes[0].id);

  const pair = await newSession({ athletes: ['Mia K.', 'Leo B.'] });
  const unassigned = await mark((await readyVideo(pair.id)).id, 30);
  assert.equal(unassigned.athleteId, null);
  assert.equal((await review(unassigned.id, { athleteId: pair.athletes[1].id })).status, 200);
  assert.equal((await review(unassigned.id, { athleteId: 'someone-else' })).status, 400);
});

test('an analyst reviews a scene: answers, status and audit trail', async () => {
  const session = await newSession({ athletes: ['Mia K.'] });
  const scene = await mark((await readyVideo(session.id)).id, 60);

  const annotation = {
    values: { 'shot-type': 'wrist', 'save-technique': ['glove'], 'danger-level': 4 },
    points: { 'goal-placement': { x: 0.7, y: 0.3 } },
    valueFlags: { screen: 'unknown' },
    pointFlags: { 'shot-location': 'unknown' },
  };
  assert.equal((await review(scene.id, { annotation: { ...annotation, values: { 'shot-type': 'lob' } } })).status, 400);
  assert.equal((await review(scene.id, { annotation }, ctx.tagger)).status, 403);

  const reviewed = await json<{ scene: SceneDto }>(await review(scene.id, { annotation, status: 'reviewed', startSec: 58.04 }));
  assert.deepEqual(reviewed.scene.annotation, annotation);
  assert.equal(reviewed.scene.status, 'reviewed');
  assert.ok(reviewed.scene.reviewedAt);
  assert.equal(reviewed.scene.startSec, 58.04);

  // Reviewed scenes are locked for their tagger.
  assert.equal((await review(scene.id, { comment: 'x' }, ctx.tagger)).status, 403);

  const detail = await json<SceneDetailDto>(await ctx.request(`/api/scenes/${scene.id}`, { cookie: ctx.tagger }));
  assert.deepEqual(
    detail.events.map((e) => e.action),
    ['created', 'reviewed'],
  );
  assert.deepEqual(detail.events[0].changes.startSec, { from: null, to: 60 });
  assert.equal(detail.events[1].userEmail, 'analyst@test.dev');
  assert.deepEqual(detail.events[1].changes.status, { from: 'unreviewed', to: 'reviewed' });
  assert.deepEqual(detail.events[1].changes.startSec, { from: 60, to: 58.04 });
  assert.ok(detail.events[1].changes.annotation);
  assert.equal(detail.users[detail.scene.reviewedBy!], 'analyst@test.dev');

  const reopened = await json<{ scene: SceneDto }>(await review(scene.id, { status: 'unreviewed' }));
  assert.deepEqual([reopened.scene.reviewedBy, reopened.scene.reviewedAt], [null, null]);
});

test('duplicates point to another scene of the same session', async () => {
  const session = await newSession();
  const video = await readyVideo(session.id);
  const original = await mark(video.id, 100);
  const copy = await mark(video.id, 102);
  const elsewhere = await mark((await readyVideo((await newSession()).id)).id, 100);

  assert.equal((await review(copy.id, { status: 'duplicate' })).status, 400);
  assert.equal((await review(copy.id, { status: 'duplicate', duplicateOf: copy.id })).status, 400);
  assert.equal((await review(copy.id, { status: 'duplicate', duplicateOf: elsewhere.id })).status, 400);
  const dup = await json<{ scene: SceneDto }>(await review(copy.id, { status: 'duplicate', duplicateOf: original.id }));
  assert.equal(dup.scene.duplicateOf, original.id);

  const rejected = await json<{ scene: SceneDto }>(await review(copy.id, { status: 'rejected' }));
  assert.equal(rejected.scene.duplicateOf, null);
});

test('the queue lists unreviewed scenes per session in time order', async () => {
  const older = await newSession({ title: 'Older', date: '2026-10-01' });
  const newer = await newSession({ title: 'Newer', date: '2026-10-20' });
  const olderVideo = await readyVideo(older.id);
  const newerVideo = await readyVideo(newer.id);
  const late = await mark(newerVideo.id, 500);
  await mark(newerVideo.id, 100);
  await mark(olderVideo.id, 50);

  const queue = async (query = '') =>
    (await json<{ items: ReviewQueueItemDto[] }>(await ctx.request(`/api/review/queue${query}`, { cookie: ctx.analyst }))).items;

  assert.deepEqual(
    (await queue()).map((i) => [i.sessionTitle, i.scene.startSec]),
    [
      ['Newer', 100],
      ['Newer', 500],
      ['Older', 50],
    ],
  );
  assert.equal((await queue(`?sessionId=${older.id}`)).length, 1);

  await json(await review(late.id, { status: 'reviewed' }));
  assert.equal((await queue()).length, 2);
  assert.deepEqual(
    (await queue('?status=reviewed')).map((i) => i.scene.id),
    [late.id],
  );
});

test('queue items carry the event type label', async () => {
  const session = await newSession();
  await mark((await readyVideo(session.id)).id, 10, 'goal-against');
  const { items } = await json<{ items: ReviewQueueItemDto[] }>(await ctx.request('/api/review/queue', { cookie: ctx.analyst }));
  assert.equal(items[0].eventTypeLabel, 'Goal against');
});

test('athletes can be deleted only when nothing refers to them', async () => {
  const session = await newSession({ athletes: ['Mia K.', 'Leo B.'] });
  const [mia, leo] = session.athletes;
  await mark((await readyVideo(session.id)).id, 10);
  await json(await review((await mark((await readyVideo(session.id)).id, 20)).id, { athleteId: mia.id }));

  const { athletes } = await json<{ athletes: (AthleteDto & { sessionCount: number; sceneCount: number })[] }>(
    await ctx.request('/api/athletes', { cookie: ctx.tagger }),
  );
  assert.deepEqual(
    athletes.map((a) => [a.name, a.sessionCount, a.sceneCount]),
    [
      ['Leo B.', 1, 0],
      ['Mia K.', 1, 1],
    ],
  );

  assert.equal((await ctx.request(`/api/athletes/${leo.id}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 409);
  await json(await ctx.request(`/api/sessions/${session.id}`, { cookie: ctx.tagger, method: 'PATCH', body: { athletes: ['Mia K.'] } }));
  assert.equal((await ctx.request(`/api/athletes/${leo.id}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 204);
  assert.equal((await ctx.request(`/api/athletes/${mia.id}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 409);
});
