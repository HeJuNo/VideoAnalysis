import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { VideoProbe } from '../../shared/mp4-probe.ts';
import type { ProfileDefinition } from '../../shared/profile.ts';
import type {
  AssetDto,
  CreateUploadResponse,
  ProfileDto,
  ProfileSummaryDto,
  SceneDto,
  SessionDetailDto,
  SessionDto,
  VideoDto,
} from '../../shared/types.ts';
import { checkDefinition, createProfile as createProfileInDb, definitionSchema } from '../src/profiles.ts';
import { ensureSeedProfiles, ICE_HOCKEY_GOALIE } from '../src/seed-profiles.ts';
import { json, MIB, setup, type TestContext } from './helpers.ts';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setup();
});

const minimal: ProfileDefinition = {
  eventTypes: [
    { key: 'goal', label: 'Goal', color: '#c8102e', hotkey: 'g', kind: 'scene' },
    { key: 'turnover', label: 'Turnover', color: '#1f6feb', hotkey: null, kind: 'scene' },
  ],
  attributes: [
    {
      key: 'body-part',
      label: 'Body part',
      type: 'single',
      options: [
        { key: 'foot', label: 'Foot' },
        { key: 'head', label: 'Head' },
      ],
      appliesTo: ['goal'],
    },
    { key: 'notes', label: 'Notes', type: 'text', options: [], appliesTo: [] },
  ],
  diagrams: [{ key: 'location', label: 'Location', background: { kind: 'template', template: 'football' }, appliesTo: [] }],
};

async function createProfile(definition: unknown = minimal, name = 'Football'): Promise<Response> {
  return ctx.request('/api/profiles', { cookie: ctx.analyst, body: { name, sport: 'Football', definition } });
}

async function newProfile(definition: ProfileDefinition = minimal): Promise<ProfileDto> {
  return (await json<{ profile: ProfileDto }>(await createProfile(definition), 201)).profile;
}

async function newSession(body: Record<string, unknown> = {}): Promise<SessionDto> {
  const res = await ctx.request('/api/sessions', { cookie: ctx.tagger, body: { title: 'Training', type: 'training', ...body } });
  return (await json<{ session: SessionDto }>(res, 201)).session;
}

const probe10s: VideoProbe = {
  container: 'mp4',
  videoCodec: 'avc1',
  codecFamily: 'h264',
  width: 1280,
  height: 720,
  durationSec: 10,
  fps: 25,
  variableFrameRate: false,
  faststart: true,
  fragmented: false,
  audioCodec: null,
};

async function readyVideo(sessionId: string): Promise<VideoDto> {
  const created = await json<CreateUploadResponse>(
    await ctx.request(`/api/sessions/${sessionId}/uploads`, {
      cookie: ctx.tagger,
      body: { name: 'clip.mp4', size: MIB, contentType: 'video/mp4', fingerprint: `clip:${Math.random()}`, probe: probe10s },
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

test('the starter profile is valid and created only once', () => {
  const parsed = definitionSchema.parse(ICE_HOCKEY_GOALIE);
  assert.equal(checkDefinition(parsed as ProfileDefinition, () => false), null);
  ensureSeedProfiles(ctx.db);
  ensureSeedProfiles(ctx.db);
  assert.equal(ctx.db.prepare('select count(*) as n from sport_profiles').get()!.n, 1);
});

test('everyone can read profiles, only analysts can create them', async () => {
  ensureSeedProfiles(ctx.db);
  const { profiles } = await json<{ profiles: ProfileSummaryDto[] }>(await ctx.request('/api/profiles', { cookie: ctx.tagger }));
  assert.equal(profiles[0].name, 'Ice Hockey Goalie');
  const goalie = await json<{ profile: ProfileDto }>(await ctx.request(`/api/profiles/${profiles[0].id}`, { cookie: ctx.tagger }));
  assert.equal(goalie.profile.definition.eventTypes[0].key, 'save');

  const res = await ctx.request('/api/profiles', {
    cookie: ctx.tagger,
    body: { name: 'X', sport: 'Football', definition: minimal },
  });
  assert.equal(res.status, 403);
  assert.equal((await createProfile()).status, 201);
});

test('rejects inconsistent definitions with a clear message', async () => {
  const cases: [unknown, RegExp][] = [
    [{ ...minimal, eventTypes: [] }, /at least one event type/],
    [{ ...minimal, eventTypes: [minimal.eventTypes[0], { ...minimal.eventTypes[1], hotkey: 'g' }] }, /Hotkey "g"/],
    [{ ...minimal, eventTypes: [minimal.eventTypes[0], minimal.eventTypes[0]] }, /key "goal" is used twice/],
    [{ ...minimal, attributes: [{ ...minimal.attributes[0], appliesTo: ['penalty'] }] }, /unknown event type "penalty"/],
    [{ ...minimal, attributes: [{ ...minimal.attributes[0], options: [] }] }, /needs at least one choice/],
    [{ ...minimal, attributes: [{ ...minimal.attributes[1], options: [{ key: 'a', label: 'A' }] }] }, /cannot have choices/],
    [{ ...minimal, eventTypes: [{ ...minimal.eventTypes[0], color: 'red' }] }, /#rrggbb/],
    [{ ...minimal, attributes: [{ ...minimal.attributes[1], key: 'Has Space' }] }, /lowercase/],
    [
      { ...minimal, diagrams: [{ key: 'img', label: 'Hall', background: { kind: 'image', assetId: 'nope', width: 10, height: 10 }, appliesTo: [] }] },
      /image of diagram "Hall" is missing/,
    ],
    [{ ...minimal, extra: true }, /Unrecognized key/],
  ];
  for (const [definition, message] of cases) {
    const res = await createProfile(definition);
    assert.equal(res.status, 400, JSON.stringify(definition));
    assert.match(((await res.json()) as { error: string }).error, message);
  }
});

test('saving a changed definition creates a new version; old versions stay readable', async () => {
  const profile = await newProfile();
  const save = (body: Record<string, unknown>) =>
    ctx.request(`/api/profiles/${profile.id}`, {
      cookie: ctx.analyst,
      method: 'PUT',
      body: { name: profile.name, sport: profile.sport, definition: minimal, baseVersion: 1, ...body },
    });

  const renamed = await json<{ profile: ProfileDto }>(await save({ name: 'Football U19' }));
  assert.equal(renamed.profile.currentVersion, 1);
  assert.equal(renamed.profile.name, 'Football U19');

  const changed: ProfileDefinition = {
    ...minimal,
    eventTypes: [...minimal.eventTypes, { key: 'foul', label: 'Foul', color: '#9a6700', hotkey: 'f', kind: 'scene' }],
  };
  const v2 = await json<{ profile: ProfileDto }>(await save({ definition: changed }));
  assert.equal(v2.profile.currentVersion, 2);
  assert.equal(v2.profile.definition.eventTypes.length, 3);

  assert.equal((await save({ definition: minimal, baseVersion: 1 })).status, 409);

  const v1 = await json<{ profile: ProfileDto }>(await ctx.request(`/api/profiles/${profile.id}?version=1`, { cookie: ctx.tagger }));
  assert.equal(v1.profile.version, 1);
  assert.equal(v1.profile.definition.eventTypes.length, 2);
});

test('copies and archives profiles', async () => {
  const profile = await newProfile();
  const copy = await json<{ profile: ProfileDto }>(
    await ctx.request('/api/profiles', { cookie: ctx.analyst, body: { name: 'Football U17', copyFrom: profile.id } }),
    201,
  );
  assert.notEqual(copy.profile.id, profile.id);
  assert.deepEqual(copy.profile.definition, profile.definition);

  await json(await ctx.request(`/api/profiles/${profile.id}/archive`, { cookie: ctx.analyst, body: { archived: true } }));
  const active = await json<{ profiles: ProfileSummaryDto[] }>(await ctx.request('/api/profiles', { cookie: ctx.tagger }));
  assert.deepEqual(
    active.profiles.map((p) => p.name),
    ['Football U17'],
  );
  const all = await json<{ profiles: ProfileSummaryDto[] }>(await ctx.request('/api/profiles?archived=1', { cookie: ctx.tagger }));
  assert.equal(all.profiles.length, 2);

  const res = await ctx.request('/api/sessions', {
    cookie: ctx.tagger,
    body: { title: 'x', type: 'match', sportProfileId: profile.id },
  });
  assert.equal(res.status, 400);
});

test('sessions carry a profile, team and athletes, and can be changed later', async () => {
  const profile = await newProfile();
  const session = await newSession({ sportProfileId: profile.id, team: ' U19 ', athletes: ['Mia K.', 'Leo B.'] });
  assert.deepEqual(
    [session.sportProfileId, session.sportProfileName, session.team, session.athletes.map((a) => a.name)],
    [profile.id, 'Football', 'U19', ['Mia K.', 'Leo B.']],
  );

  const patched = await json<{ session: SessionDto }>(
    await ctx.request(`/api/sessions/${session.id}`, {
      cookie: ctx.tagger,
      method: 'PATCH',
      body: { team: '', athletes: ['Mia K.'], sportProfileId: null },
    }),
  );
  assert.deepEqual(
    [patched.session.sportProfileId, patched.session.team, patched.session.athletes.map((a) => a.name)],
    [null, null, ['Mia K.']],
  );
  assert.equal(patched.session.title, 'Training');

  const unknown = await ctx.request(`/api/sessions/${session.id}`, {
    cookie: ctx.tagger,
    method: 'PATCH',
    body: { sportProfileId: 'missing' },
  });
  assert.equal(unknown.status, 400);
});

test('scenes record the profile version and are idempotent per clientId', async () => {
  const profile = await newProfile();
  const session = await newSession({ sportProfileId: profile.id });
  const video = await readyVideo(session.id);
  const scene = (body: Record<string, unknown>) =>
    ctx.request('/api/scenes', { cookie: ctx.tagger, body: { videoId: video.id, startSec: 0, endSec: 10, ...body } });

  const whole = await json<{ scene: SceneDto }>(await scene({ clientId: `whole:${video.id}:0:10` }), 201);
  assert.deepEqual([whole.scene.profileId, whole.scene.profileVersion, whole.scene.status], [profile.id, 1, 'unreviewed']);
  const again = await json<{ scene: SceneDto }>(await scene({ clientId: `whole:${video.id}:0:10` }));
  assert.equal(again.scene.id, whole.scene.id);

  assert.equal((await scene({ eventTypeKey: 'goal', startSec: 2, endSec: 4 })).status, 201);
  assert.equal((await scene({ eventTypeKey: 'penalty' })).status, 400);
  assert.equal((await scene({ startSec: 5, endSec: 5 })).status, 400);
  assert.equal((await scene({ endSec: 30 })).status, 400);

  const detail = await json<{ session: SessionDetailDto }>(await ctx.request(`/api/sessions/${session.id}`, { cookie: ctx.tagger }));
  assert.equal(detail.session.videos[0].sceneCount, 2);
  const { scenes } = await json<{ scenes: SceneDto[] }>(await ctx.request(`/api/sessions/${session.id}/scenes`, { cookie: ctx.tagger }));
  assert.deepEqual(
    scenes.map((s) => s.startSec),
    [0, 2],
  );

  // A session without a profile accepts scenes without an event type only.
  const plain = await newSession();
  const plainVideo = await readyVideo(plain.id);
  const res = await ctx.request('/api/scenes', {
    cookie: ctx.tagger,
    body: { videoId: plainVideo.id, startSec: 0, endSec: 5, eventTypeKey: 'goal' },
  });
  assert.equal(res.status, 400);
});

test('scenes can be deleted by their creator or an analyst', async () => {
  const session = await newSession();
  const video = await readyVideo(session.id);
  const created = await json<{ scene: SceneDto }>(
    await ctx.request('/api/scenes', { cookie: ctx.analyst, body: { videoId: video.id, startSec: 0, endSec: 3 } }),
    201,
  );
  assert.equal((await ctx.request(`/api/scenes/${created.scene.id}`, { cookie: ctx.tagger, method: 'DELETE' })).status, 403);
  assert.equal((await ctx.request(`/api/scenes/${created.scene.id}`, { cookie: ctx.analyst, method: 'DELETE' })).status, 204);
});

test('diagram images upload directly to storage and must be complete before use', async () => {
  const body = { contentType: 'image/png', size: 2048, width: 800, height: 400 };
  assert.equal((await ctx.request('/api/assets', { cookie: ctx.tagger, body })).status, 403);
  assert.equal((await ctx.request('/api/assets', { cookie: ctx.analyst, body: { ...body, contentType: 'image/svg+xml' } })).status, 400);

  const created = await json<{ asset: AssetDto; uploadUrl: string }>(await ctx.request('/api/assets', { cookie: ctx.analyst, body }), 201);
  assert.match(created.uploadUrl, /put&type=image%2Fpng/);

  const diagramProfile = {
    ...minimal,
    diagrams: [
      {
        key: 'hall',
        label: 'Hall',
        background: { kind: 'image', assetId: created.asset.id, width: 800, height: 400 },
        appliesTo: [],
      },
    ],
  };
  assert.equal((await createProfile(diagramProfile)).status, 400);
  assert.equal((await ctx.request(`/api/assets/${created.asset.id}/complete`, { cookie: ctx.analyst, method: 'POST' })).status, 409);

  ctx.storage.putObject(`assets/${created.asset.id}.png`, 2048);
  await json(await ctx.request(`/api/assets/${created.asset.id}/complete`, { cookie: ctx.analyst, method: 'POST' }));
  assert.equal((await createProfile(diagramProfile)).status, 201);

  const file = await ctx.request(created.asset.url, { cookie: ctx.tagger });
  assert.equal(file.status, 302);
  assert.match(file.headers.get('location')!, /assets\/.+\.png\?signed/);
});

test('session title, type and date and video names can be changed', async () => {
  const session = await newSession({ date: '2026-10-01' });
  const patched = await json<{ session: SessionDto }>(
    await ctx.request(`/api/sessions/${session.id}`, {
      cookie: ctx.tagger,
      method: 'PATCH',
      body: { title: 'HC A vs. HC B', type: 'match', date: '2026-10-02' },
    }),
  );
  assert.deepEqual([patched.session.title, patched.session.type, patched.session.date], ['HC A vs. HC B', 'match', '2026-10-02']);
  const blank = await ctx.request(`/api/sessions/${session.id}`, { cookie: ctx.tagger, method: 'PATCH', body: { title: ' ' } });
  assert.equal(blank.status, 400);

  const video = await readyVideo(session.id);
  assert.equal(video.name, 'clip.mp4');
  const renamed = await json<{ video: VideoDto }>(
    await ctx.request(`/api/videos/${video.id}`, { cookie: ctx.tagger, method: 'PATCH', body: { name: ' 1st period ' } }),
  );
  assert.equal(renamed.video.name, '1st period');
  const empty = await ctx.request(`/api/videos/${video.id}`, { cookie: ctx.tagger, method: 'PATCH', body: { name: '' } });
  assert.equal(empty.status, 400);
});

test('an existing starter profile gets the standard markers once', async () => {
  const old: ProfileDefinition = { ...ICE_HOCKEY_GOALIE, eventTypes: ICE_HOCKEY_GOALIE.eventTypes.filter((e) => e.kind === 'scene' && !e.key.startsWith('foul')) };
  createProfileInDb(ctx.db, { name: 'Ice Hockey Goalie', sport: 'Ice hockey', definition: old, userId: null });
  ensureSeedProfiles(ctx.db);
  const id = String(ctx.db.prepare('select id from sport_profiles').get()!.id);
  const upgraded = await json<{ profile: ProfileDto }>(await ctx.request(`/api/profiles/${id}`, { cookie: ctx.analyst }));
  assert.equal(upgraded.profile.currentVersion, 2);
  assert.deepEqual(
    upgraded.profile.definition.eventTypes.slice(-4).map((e) => [e.key, e.kind, e.hotkey]),
    [
      ['period-start', 'period-start', 'b'],
      ['period-end', 'period-end', 'e'],
      ['foul-home', 'scene', 'h'],
      ['foul-away', 'scene', 'a'],
    ],
  );

  // Removed later by an analyst: not added again.
  const definition = { ...upgraded.profile.definition, eventTypes: upgraded.profile.definition.eventTypes.filter((e) => e.key !== 'foul-away') };
  await json(
    await ctx.request(`/api/profiles/${id}`, {
      cookie: ctx.analyst,
      method: 'PUT',
      body: { name: 'Ice Hockey Goalie', sport: 'Ice hockey', definition, baseVersion: 2 },
    }),
  );
  ensureSeedProfiles(ctx.db);
  const after = await json<{ profile: ProfileDto }>(await ctx.request(`/api/profiles/${id}`, { cookie: ctx.analyst }));
  assert.equal(after.profile.currentVersion, 3);
});

test('a profile has at most one period start and one period end type', async () => {
  const twoStarts = {
    ...minimal,
    eventTypes: [
      ...minimal.eventTypes,
      { key: 'half-start', label: 'Half start', color: '#000000', hotkey: null, kind: 'period-start' },
      { key: 'third-start', label: 'Third start', color: '#000000', hotkey: null, kind: 'period-start' },
    ],
  };
  const res = await createProfile(twoStarts);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Only one event type can be the period start/);
});
