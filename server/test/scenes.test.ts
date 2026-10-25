import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { VideoProbe } from '../../shared/mp4-probe.ts';
import type { CreateUploadResponse, ProfileDto, SceneDto, SessionDto, VideoDto } from '../../shared/types.ts';
import { ensureSeedProfiles } from '../src/seed-profiles.ts';
import { json, MIB, setup, type TestContext } from './helpers.ts';

let ctx: TestContext;
let video: VideoDto;

const probe: VideoProbe = {
  container: 'mp4',
  videoCodec: 'avc1',
  codecFamily: 'h264',
  width: 1920,
  height: 1080,
  durationSec: 3600,
  fps: 25,
  variableFrameRate: false,
  faststart: true,
  fragmented: false,
  audioCodec: 'mp4a',
};

beforeEach(async () => {
  ctx = await setup();
  ensureSeedProfiles(ctx.db);
  const profileId = String(ctx.db.prepare('select id from sport_profiles').get()!.id);
  const session = (
    await json<{ session: SessionDto }>(
      await ctx.request('/api/sessions', { cookie: ctx.tagger, body: { title: 'Game', type: 'match', sportProfileId: profileId } }),
      201,
    )
  ).session;
  const created = await json<CreateUploadResponse>(
    await ctx.request(`/api/sessions/${session.id}/uploads`, {
      cookie: ctx.tagger,
      body: { name: 'p1.mp4', size: MIB, contentType: 'video/mp4', fingerprint: 'p1', probe },
    }),
    201,
  );
  ctx.storage.putPart(ctx.storage.onlyUploadId(), 1, MIB);
  video = (
    await json<{ video: VideoDto }>(
      await ctx.request(`/api/uploads/${created.video.id}/complete`, {
        cookie: ctx.tagger,
        body: { parts: [{ partNumber: 1, etag: '"etag-1"' }] },
      }),
    )
  ).video;
});

const mark = (cookie: string, body: Record<string, unknown>) =>
  ctx.request('/api/scenes', { cookie, body: { videoId: video.id, startSec: 100, endSec: 110, ...body } });

test('a mark made offline can be edited and undone by its clientId', async () => {
  const clientId = 'c0ffee00-0000-4000-8000-000000000001';
  const created = await json<{ scene: SceneDto }>(await mark(ctx.tagger, { clientId }), 201);
  assert.deepEqual([created.scene.clientId, created.scene.eventTypeKey], [clientId, null]);

  const patched = await json<{ scene: SceneDto }>(
    await ctx.request(`/api/scenes/${clientId}`, {
      cookie: ctx.tagger,
      method: 'PATCH',
      body: { eventTypeKey: 'save', comment: ' glove side ' },
    }),
  );
  assert.deepEqual([patched.scene.eventTypeKey, patched.scene.comment], ['save', 'glove side']);

  const { scenes } = await json<{ scenes: SceneDto[] }>(await ctx.request(`/api/videos/${video.id}/scenes`, { cookie: ctx.tagger }));
  assert.equal(scenes.length, 1);

  assert.equal((await ctx.request(`/api/scenes/${clientId}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 204);
  assert.equal((await ctx.request(`/api/scenes/${clientId}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 404);
});

test('edits are validated like new scenes', async () => {
  const created = await json<{ scene: SceneDto }>(await mark(ctx.tagger, {}), 201);
  const patch = (body: unknown) =>
    ctx.request(`/api/scenes/${created.scene.id}`, { cookie: ctx.tagger, method: 'PATCH', body });
  assert.equal((await patch({ eventTypeKey: 'penalty' })).status, 400);
  assert.equal((await patch({ endSec: 90 })).status, 400);
  assert.equal((await patch({ endSec: 4000 })).status, 400);
  assert.equal((await patch({ status: 'reviewed' })).status, 403);
  assert.equal((await patch({ speed: 2 })).status, 400);
  const moved = await json<{ scene: SceneDto }>(await patch({ startSec: 95.12345, endSec: 105 }));
  assert.deepEqual([moved.scene.startSec, moved.scene.endSec], [95.123, 105]);
  const cleared = await json<{ scene: SceneDto }>(await patch({ eventTypeKey: null, comment: '' }));
  assert.deepEqual([cleared.scene.eventTypeKey, cleared.scene.comment], [null, null]);
});

test('taggers change only their own unreviewed scenes; analysts change any', async () => {
  const analystScene = await json<{ scene: SceneDto }>(await mark(ctx.analyst, {}), 201);
  const res = await ctx.request(`/api/scenes/${analystScene.scene.id}`, {
    cookie: ctx.tagger,
    method: 'PATCH',
    body: { comment: 'x' },
  });
  assert.equal(res.status, 403);

  const own = await json<{ scene: SceneDto }>(await mark(ctx.tagger, {}), 201);
  ctx.db.prepare(`update scenes set status = 'reviewed' where id = ?`).run(own.scene.id);
  const reviewed = await ctx.request(`/api/scenes/${own.scene.id}`, { cookie: ctx.tagger, method: 'DELETE' });
  assert.equal(reviewed.status, 403);
  const byAnalyst = await ctx.request(`/api/scenes/${own.scene.id}`, {
    cookie: ctx.analyst,
    method: 'PATCH',
    body: { eventTypeKey: 'goal-against' },
  });
  assert.equal(byAnalyst.status, 200);
});

test('the event type is checked against the profile version the scene was recorded with', async () => {
  const created = await json<{ scene: SceneDto }>(await mark(ctx.tagger, {}), 201);
  const profile = ctx.db.prepare('select id from sport_profiles').get()!;
  // A newer version without "puck-play" must not affect the existing scene.
  const current = await json<{ profile: ProfileDto }>(await ctx.request(`/api/profiles/${profile.id}`, { cookie: ctx.analyst }));
  const without = <T extends { appliesTo: string[] }>(x: T) => ({ ...x, appliesTo: x.appliesTo.filter((k) => k !== 'puck-play') });
  const definition = {
    eventTypes: current.profile.definition.eventTypes.filter((e) => e.key !== 'puck-play'),
    attributes: current.profile.definition.attributes.map(without),
    diagrams: current.profile.definition.diagrams.map(without),
  };
  await json(
    await ctx.request(`/api/profiles/${profile.id}`, {
      cookie: ctx.analyst,
      method: 'PUT',
      body: { name: current.profile.name, sport: current.profile.sport, definition, baseVersion: 1 },
    }),
  );
  const res = await ctx.request(`/api/scenes/${created.scene.id}`, {
    cookie: ctx.tagger,
    method: 'PATCH',
    body: { eventTypeKey: 'puck-play' },
  });
  assert.equal(res.status, 200);
  assert.equal((await mark(ctx.tagger, { eventTypeKey: 'puck-play' })).status, 400);
});

test('period and moment marks are points in time and skip the review queue', async () => {
  const start = await json<{ scene: SceneDto }>(await mark(ctx.tagger, { eventTypeKey: 'period-start', startSec: 30, endSec: 40 }), 201);
  assert.deepEqual([start.scene.marker, start.scene.startSec, start.scene.endSec], [true, 30, 30.01]);
  const save = await json<{ scene: SceneDto }>(await mark(ctx.tagger, { eventTypeKey: 'save' }), 201);
  assert.equal(save.scene.marker, false);

  const { items } = await json<{ items: { scene: SceneDto }[] }>(await ctx.request('/api/review/queue', { cookie: ctx.analyst }));
  assert.deepEqual(
    items.map((i) => i.scene.id),
    [save.scene.id],
  );

  // Moving a marker keeps it a point; switching between scene and marker types is refused.
  const moved = await json<{ scene: SceneDto }>(
    await ctx.request(`/api/scenes/${start.scene.id}`, { cookie: ctx.tagger, method: 'PATCH', body: { startSec: 31 } }),
  );
  assert.deepEqual([moved.scene.startSec, moved.scene.endSec], [31, 31.01]);
  const toScene = await ctx.request(`/api/scenes/${start.scene.id}`, {
    cookie: ctx.tagger,
    method: 'PATCH',
    body: { eventTypeKey: 'save' },
  });
  assert.equal(toScene.status, 400);
  const toEnd = await ctx.request(`/api/scenes/${start.scene.id}`, {
    cookie: ctx.tagger,
    method: 'PATCH',
    body: { eventTypeKey: 'period-end' },
  });
  assert.equal(toEnd.status, 200);
});
