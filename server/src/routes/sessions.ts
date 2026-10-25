import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { SessionDetailDto } from '../../../shared/types.ts';
import { requireAnalyst, userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now, transaction, type Db } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { getSession, getSessionRow, listSessions, listVideos, toSceneDto, toVideoDto, type SceneRow } from '../repo.ts';
import { resolveAthletes, setSessionAthletes } from './athletes.ts';
import { removeVideo } from './videos.ts';

const team = z.string().trim().max(120).nullable().transform((v) => v || null);
/** Athlete names; unknown names become new athletes. */
const athletes = z.array(z.string().trim().min(1).max(120)).max(50);

/** A profile a session may use: it exists and is not archived. */
function checkProfile(db: Db, id: string | null): void {
  if (id === null) return;
  const row = db.prepare('select archived_at from sport_profiles where id = ?').get(id);
  if (!row) throw new HTTPException(400, { message: 'Unknown sport profile' });
  if (row.archived_at) throw new HTTPException(400, { message: 'This sport profile is archived' });
}

export function sessionRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<AppEnv>();

  app.get('/sessions', (c) => c.json({ sessions: listSessions(db) }));

  app.post('/sessions', async (c) => {
    const user = userOf(c);
    const body = await readJson(
      c,
      z.object({
        title: z.string().trim().min(1).max(200),
        type: z.enum(['match', 'training']),
        date: z.iso.date().nullable().default(null),
        sportProfileId: z.string().nullable().default(null),
        team: team.default(null),
        athletes: athletes.default([]),
      }),
    );
    checkProfile(db, body.sportProfileId);
    const id = randomUUID();
    transaction(db, () => {
      db.prepare(
        `insert into sessions (id, type, title, date, sport_profile_id, team, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, body.type, body.title, body.date, body.sportProfileId, body.team, user.id, now());
      setSessionAthletes(db, id, resolveAthletes(db, body.athletes));
    });
    return c.json({ session: getSession(db, id) }, 201);
  });

  app.get('/sessions/:id', (c) => {
    const session = getSession(db, c.req.param('id')) ?? notFound('Session');
    const detail: SessionDetailDto = { ...session, videos: listVideos(db, session.id).map(toVideoDto) };
    return c.json({ session: detail });
  });

  // Session setup; fields left out keep their value. Scenes keep the profile version they were
  // recorded with, so switching the profile never changes existing scenes.
  app.patch('/sessions/:id', async (c) => {
    userOf(c);
    const row = getSessionRow(db, c.req.param('id')) ?? notFound('Session');
    const body = await readJson(
      c,
      z.strictObject({
        title: z.string().trim().min(1).max(200).optional(),
        type: z.enum(['match', 'training']).optional(),
        date: z.iso.date().nullable().optional(),
        sportProfileId: z.string().nullable().optional(),
        team: team.optional(),
        athletes: athletes.optional(),
      }),
    );
    if (body.sportProfileId !== undefined && body.sportProfileId !== row.sport_profile_id) {
      checkProfile(db, body.sportProfileId);
    }
    transaction(db, () => {
      db.prepare('update sessions set title = ?, type = ?, date = ?, sport_profile_id = ?, team = ? where id = ?').run(
        body.title ?? row.title,
        body.type ?? row.type,
        body.date !== undefined ? body.date : row.date,
        body.sportProfileId !== undefined ? body.sportProfileId : row.sport_profile_id,
        body.team !== undefined ? body.team : row.team,
        row.id,
      );
      if (body.athletes !== undefined) setSessionAthletes(db, row.id, resolveAthletes(db, body.athletes));
    });
    return c.json({ session: getSession(db, row.id) });
  });

  app.get('/sessions/:id/scenes', (c) => {
    const session = getSession(db, c.req.param('id')) ?? notFound('Session');
    const rows = db
      .prepare('select * from scenes where session_id = ? order by video_file_id, start_sec')
      .all(session.id) as unknown as SceneRow[];
    return c.json({ scenes: rows.map(toSceneDto) });
  });

  // Deletes every stored file of the session, then the session and its rows.
  app.delete('/sessions/:id', async (c) => {
    requireAnalyst(c);
    const session = getSession(db, c.req.param('id')) ?? notFound('Session');
    for (const video of listVideos(db, session.id)) await removeVideo(deps, video);
    db.prepare('delete from sessions where id = ?').run(session.id);
    return c.body(null, 204);
  });

  return app;
}
