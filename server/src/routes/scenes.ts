import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { checkAnnotation, normalizeAnnotation, type SceneAnnotation } from '../../../shared/annotation.ts';
import { isPointKind, type EventKind } from '../../../shared/profile.ts';
import type { ReviewQueueItemDto, SceneDetailDto, SceneEventDto, SceneStatus, UserDto } from '../../../shared/types.ts';
import { userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now, transaction, type Db } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { getProfile } from '../profiles.ts';
import {
  getScene,
  getSession,
  getSessionRow,
  getVideo,
  toSceneDto,
  toVideoDto,
  videoProbe,
  type SceneRow,
  type VideoRow,
} from '../repo.ts';

// Probed and browser-reported durations can differ slightly.
const DURATION_TOLERANCE_SEC = 1;
// Point-in-time marks are stored with this minimal range (scenes must end after they start).
const MARKER_SEC = 0.01;
const STATUSES: [SceneStatus, ...SceneStatus[]] = ['unreviewed', 'reviewed', 'rejected', 'duplicate'];

const seconds = (sec: number) => Math.round(sec * 1000) / 1000;
const comment = z.string().trim().max(500).nullable().transform((v) => v || null);
const certainty = z.enum(['unknown', 'uncertain']);
const annotationSchema = z.strictObject({
  values: z.record(
    z.string().max(40),
    z.union([z.string().max(1000), z.array(z.string().max(40)).max(50), z.number(), z.boolean()]),
  ),
  points: z.record(z.string().max(40), z.strictObject({ x: z.number(), y: z.number() })),
  valueFlags: z.record(z.string().max(40), certainty),
  pointFlags: z.record(z.string().max(40), certainty),
});

/** Fields a tagger may change on their own unreviewed scene; the rest is the analyst's review. */
const TAGGER_FIELDS = new Set(['startSec', 'endSec', 'eventTypeKey', 'comment']);

function recordEvent(db: Db, sceneId: string, userId: string, action: SceneEventDto['action'], changes: object): void {
  db.prepare('insert into scene_events (scene_id, user_id, action, changes, at) values (?, ?, ?, ?, ?)').run(
    sceneId,
    userId,
    action,
    JSON.stringify(changes),
    now(),
  );
}

export function sceneRoutes({ db }: AppDeps) {
  const app = new Hono<AppEnv>();

  /**
   * Scenes can be addressed by their server id or by the clientId the browser generated, so a
   * mark made offline can be edited or undone before the server has ever seen it.
   */
  function findScene(ref: string): SceneRow {
    return (db.prepare('select * from scenes where id = ? or client_id = ?').get(ref, ref) as SceneRow | undefined) ?? notFound('Scene');
  }

  /** Taggers change only their own scenes, and only until an analyst has reviewed them. */
  function checkCanEdit(user: UserDto, scene: SceneRow): void {
    if (user.role === 'analyst') return;
    if (scene.created_by !== user.id) throw new HTTPException(403, { message: 'Only the creator or an analyst can change this scene' });
    if (scene.status !== 'unreviewed') throw new HTTPException(403, { message: 'This scene has already been reviewed' });
  }

  function checkRange(video: VideoRow, start: number, end: number): void {
    if (end <= start) throw new HTTPException(400, { message: 'A scene must end after it starts' });
    const duration = videoProbe(video)?.durationSec ?? null;
    if (duration !== null && end > duration + DURATION_TOLERANCE_SEC) {
      throw new HTTPException(400, { message: 'Scene ends after the end of the video' });
    }
  }

  function profileOf(profileId: string | null, version: number | null) {
    return profileId ? getProfile(db, profileId, version ?? undefined) : undefined;
  }

  /** The kind of the event type (a scene when there is none); throws if the type is unknown. */
  function eventKind(profileId: string | null, version: number | null, eventTypeKey: string | null): EventKind {
    if (eventTypeKey === null) return 'scene';
    const type = profileOf(profileId, version)?.definition.eventTypes.find((e) => e.key === eventTypeKey);
    if (!type) throw new HTTPException(400, { message: `Unknown event type "${eventTypeKey}" for this session's profile` });
    return type.kind;
  }

  // Creates a scene. Sending the same clientId again returns the existing scene, so retries
  // (offline sync, repeated "whole clip" clicks) never create duplicates.
  app.post('/scenes', async (c) => {
    const user = userOf(c);
    const body = await readJson(
      c,
      z.strictObject({
        videoId: z.string(),
        startSec: z.number().nonnegative(),
        endSec: z.number().positive(),
        eventTypeKey: z.string().max(40).nullable().default(null),
        comment: comment.default(null),
        clientId: z.string().min(8).max(120).nullable().default(null),
      }),
    );

    if (body.clientId) {
      const existing = db.prepare('select * from scenes where client_id = ?').get(body.clientId) as SceneRow | undefined;
      if (existing) return c.json({ scene: toSceneDto(existing) });
    }

    const video = getVideo(db, body.videoId) ?? notFound('Video');
    if (video.status !== 'ready') throw new HTTPException(409, { message: 'Video is not ready' });

    const session = getSessionRow(db, video.session_id)!;
    const profile = session.sport_profile_id ? getProfile(db, session.sport_profile_id) : undefined;
    const marker = isPointKind(eventKind(profile?.id ?? null, profile?.currentVersion ?? null, body.eventTypeKey));
    const endSec = marker ? body.startSec + MARKER_SEC : body.endSec;
    checkRange(video, body.startSec, endSec);
    // A session with a single athlete assigns its scenes to them right away.
    const athletes = JSON.parse(session.athletes) as { id: string }[];

    const id = randomUUID();
    const fields = { startSec: seconds(body.startSec), endSec: seconds(endSec), eventTypeKey: body.eventTypeKey };
    transaction(db, () => {
      db.prepare(
        `insert into scenes (id, session_id, video_file_id, start_sec, end_sec, event_type_key, profile_id,
           profile_version, comment, client_id, athlete_id, marker, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        session.id,
        video.id,
        fields.startSec,
        fields.endSec,
        body.eventTypeKey,
        profile?.id ?? null,
        profile?.currentVersion ?? null,
        body.comment,
        body.clientId,
        athletes.length === 1 ? athletes[0].id : null,
        marker ? 1 : 0,
        user.id,
        now(),
      );
      const created = Object.fromEntries(Object.entries(fields).map(([key, to]) => [key, { from: null, to }]));
      recordEvent(db, id, user.id, 'created', created);
    });
    return c.json({ scene: toSceneDto(getScene(db, id)!) }, 201);
  });

  app.get('/videos/:id/scenes', (c) => {
    userOf(c);
    const video = getVideo(db, c.req.param('id')) ?? notFound('Video');
    const rows = db.prepare('select * from scenes where video_file_id = ? order by start_sec').all(video.id);
    return c.json({ scenes: (rows as unknown as SceneRow[]).map(toSceneDto) });
  });

  // The scene with its video, session and audit trail, for the review screen.
  app.get('/scenes/:ref', (c) => {
    userOf(c);
    const scene = findScene(c.req.param('ref'));
    const events = db
      .prepare(
        `select e.id, e.action, e.changes, e.at, u.email from scene_events e left join users u on u.id = e.user_id
         where e.scene_id = ? order by e.id`,
      )
      .all(scene.id)
      .map(
        (row): SceneEventDto => ({
          id: Number(row.id),
          action: row.action as SceneEventDto['action'],
          userEmail: row.email === null ? null : String(row.email),
          changes: JSON.parse(String(row.changes)),
          at: String(row.at),
        }),
      );
    const userIds = [scene.created_by, scene.reviewed_by].filter((x): x is string => x !== null);
    const users = Object.fromEntries(
      userIds.map((id) => [id, String(db.prepare('select email from users where id = ?').get(id)?.email ?? 'deleted user')]),
    );
    const detail: SceneDetailDto = {
      scene: toSceneDto(scene),
      video: toVideoDto(getVideo(db, scene.video_file_id)!),
      session: getSession(db, scene.session_id)!,
      events,
      users,
    };
    return c.json(detail);
  });

  // Taggers: range, category and comment of their own unreviewed scenes. Analysts additionally:
  // review answers, athlete, status and duplicate link. Fields left out keep their value.
  app.patch('/scenes/:ref', async (c) => {
    const user = userOf(c);
    const scene = findScene(c.req.param('ref'));
    checkCanEdit(user, scene);
    const body = await readJson(
      c,
      z.strictObject({
        startSec: z.number().nonnegative().optional(),
        endSec: z.number().positive().optional(),
        eventTypeKey: z.string().max(40).nullable().optional(),
        comment: comment.optional(),
        athleteId: z.string().nullable().optional(),
        annotation: annotationSchema.optional(),
        status: z.enum(STATUSES).optional(),
        duplicateOf: z.string().nullable().optional(),
      }),
    );
    if (user.role !== 'analyst') {
      const forbidden = Object.keys(body).find((k) => !TAGGER_FIELDS.has(k));
      if (forbidden) throw new HTTPException(403, { message: 'Only analysts can review scenes' });
    }

    const next = {
      startSec: seconds(body.startSec ?? scene.start_sec),
      endSec: seconds(body.endSec ?? scene.end_sec),
      eventTypeKey: body.eventTypeKey !== undefined ? body.eventTypeKey : scene.event_type_key,
      comment: body.comment !== undefined ? body.comment : scene.comment,
      athleteId: body.athleteId !== undefined ? body.athleteId : scene.athlete_id,
      status: body.status ?? scene.status,
      duplicateOf: body.duplicateOf !== undefined ? body.duplicateOf : scene.duplicate_of,
      annotation: body.annotation ?? normalizeAnnotation(JSON.parse(scene.annotation) as Partial<SceneAnnotation>),
    };

    const marker = isPointKind(eventKind(scene.profile_id, scene.profile_version, next.eventTypeKey));
    if (marker !== (scene.marker === 1)) {
      throw new HTTPException(400, { message: 'A scene cannot become a point-in-time marker or the other way round' });
    }
    if (marker) next.endSec = seconds(next.startSec + MARKER_SEC);
    checkRange(getVideo(db, scene.video_file_id)!, next.startSec, next.endSec);

    if (body.annotation) {
      const profile = profileOf(scene.profile_id, scene.profile_version);
      const problem = profile
        ? checkAnnotation(profile.definition, body.annotation)
        : Object.values(body.annotation).some((part) => Object.keys(part).length > 0)
          ? 'This scene has no sport profile to answer'
          : null;
      if (problem) throw new HTTPException(400, { message: problem });
    }

    if (next.athleteId !== null && next.athleteId !== scene.athlete_id) {
      const linked = db
        .prepare('select 1 from session_athletes where session_id = ? and athlete_id = ?')
        .get(scene.session_id, next.athleteId);
      if (!linked) throw new HTTPException(400, { message: "The athlete is not part of this scene's session" });
    }

    if (next.status === 'duplicate') {
      if (!next.duplicateOf) throw new HTTPException(400, { message: 'Choose the scene this one duplicates' });
      if (next.duplicateOf === scene.id) throw new HTTPException(400, { message: 'A scene cannot duplicate itself' });
      const original = getScene(db, next.duplicateOf);
      if (!original || original.session_id !== scene.session_id) {
        throw new HTTPException(400, { message: 'The original must be a scene of the same session' });
      }
    } else {
      next.duplicateOf = null;
    }

    const statusChanged = next.status !== scene.status;
    const reviewedBy = statusChanged ? (next.status === 'unreviewed' ? null : user.id) : scene.reviewed_by;
    const reviewedAt = statusChanged ? (next.status === 'unreviewed' ? null : now()) : scene.reviewed_at;

    const before: Record<string, unknown> = {
      startSec: scene.start_sec,
      endSec: scene.end_sec,
      eventTypeKey: scene.event_type_key,
      comment: scene.comment,
      athleteId: scene.athlete_id,
      status: scene.status,
      duplicateOf: scene.duplicate_of,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, from] of Object.entries(before)) {
      const to = next[key as keyof typeof next];
      if (to !== from) changes[key] = { from, to };
    }
    const annotationJson = JSON.stringify(next.annotation);
    if (annotationJson !== JSON.stringify(normalizeAnnotation(JSON.parse(scene.annotation)))) {
      changes.annotation = { from: null, to: 'changed' };
    }

    transaction(db, () => {
      db.prepare(
        `update scenes set start_sec = ?, end_sec = ?, event_type_key = ?, comment = ?, athlete_id = ?, annotation = ?,
           status = ?, duplicate_of = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? where id = ?`,
      ).run(
        next.startSec,
        next.endSec,
        next.eventTypeKey,
        next.comment,
        next.athleteId,
        annotationJson,
        next.status,
        next.duplicateOf,
        reviewedBy,
        reviewedAt,
        now(),
        scene.id,
      );
      if (Object.keys(changes).length > 0) recordEvent(db, scene.id, user.id, statusChanged ? 'reviewed' : 'updated', changes);
    });
    return c.json({ scene: toSceneDto(getScene(db, scene.id)!) });
  });

  app.delete('/scenes/:ref', (c) => {
    const user = userOf(c);
    const scene = findScene(c.req.param('ref'));
    checkCanEdit(user, scene);
    db.prepare('delete from scenes where id = ?').run(scene.id);
    return c.body(null, 204);
  });

  // Scenes to review, chronological per session (newest session first). Filters: status
  // (default unreviewed) and session.
  app.get('/review/queue', (c) => {
    userOf(c);
    const status = z.enum(STATUSES).catch('unreviewed').parse(c.req.query('status'));
    const sessionId = c.req.query('sessionId') ?? null;
    const rows = db
      .prepare(
        `select c.*, s.title as session_title, s.date as session_date, v.original_name as video_name,
           v.part_index as video_part_index
         from scenes c join sessions s on s.id = c.session_id join video_files v on v.id = c.video_file_id
         where c.status = ? and (? is null or c.session_id = ?) and v.status = 'ready' and c.marker = 0
         order by coalesce(s.date, s.created_at) desc, s.created_at desc, v.part_index, c.start_sec`,
      )
      .all(status, sessionId, sessionId) as unknown as (SceneRow & {
      session_title: string;
      session_date: string | null;
      video_name: string;
      video_part_index: number;
    })[];
    const labels = new Map<string, Map<string, string>>();
    const labelOf = (row: SceneRow) => {
      if (!row.event_type_key || !row.profile_id) return null;
      const version = `${row.profile_id}:${row.profile_version}`;
      if (!labels.has(version)) {
        const def = profileOf(row.profile_id, row.profile_version)?.definition;
        labels.set(version, new Map(def?.eventTypes.map((e) => [e.key, e.label]) ?? []));
      }
      return labels.get(version)!.get(row.event_type_key) ?? row.event_type_key;
    };
    const items: ReviewQueueItemDto[] = rows.map((row) => ({
      scene: toSceneDto(row),
      eventTypeLabel: labelOf(row),
      sessionTitle: row.session_title,
      sessionDate: row.session_date,
      videoName: row.video_name,
      videoPartIndex: row.video_part_index,
    }));
    return c.json({ items });
  });

  return app;
}
