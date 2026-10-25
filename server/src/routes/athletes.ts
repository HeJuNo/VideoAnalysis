import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AthleteDto, AthleteUsageDto } from '../../../shared/types.ts';
import { userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now, type Db } from '../db.ts';
import { notFound, readJson } from '../http.ts';

const name = z.string().trim().min(1).max(120);
const catchHand = z.enum(['left', 'right']).nullable();

interface AthleteRow {
  id: string;
  name: string;
  catch_hand: 'left' | 'right' | null;
}

const toAthleteDto = (row: AthleteRow): AthleteDto => ({ id: row.id, name: row.name, catchHand: row.catch_hand });

/** Ids for the given names, creating athletes that do not exist yet (names match ignoring case). */
export function resolveAthletes(db: Db, names: string[]): string[] {
  const ids: string[] = [];
  for (const raw of names) {
    const athleteName = raw.trim();
    if (!athleteName) continue;
    const existing = db.prepare('select id from athletes where name = ?').get(athleteName);
    let id = existing ? String(existing.id) : null;
    if (!id) {
      id = randomUUID();
      db.prepare('insert into athletes (id, name, created_at) values (?, ?, ?)').run(id, athleteName, now());
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function setSessionAthletes(db: Db, sessionId: string, athleteIds: string[]): void {
  db.prepare('delete from session_athletes where session_id = ?').run(sessionId);
  athleteIds.forEach((athleteId, position) =>
    db.prepare('insert into session_athletes (session_id, athlete_id, position) values (?, ?, ?)').run(sessionId, athleteId, position),
  );
}

export function athleteRoutes({ db }: AppDeps) {
  const app = new Hono<AppEnv>();
  const getAthlete = (id: string) => db.prepare('select * from athletes where id = ?').get(id) as AthleteRow | undefined;

  const nameTaken = (athleteName: string, exceptId: string | null) =>
    Boolean(db.prepare('select 1 from athletes where name = ? and id != ?').get(athleteName, exceptId ?? ''));

  app.get('/athletes', (c) => {
    userOf(c);
    const rows = db
      .prepare(
        `select a.*,
           (select count(*) from session_athletes sa where sa.athlete_id = a.id) as session_count,
           (select count(*) from scenes c where c.athlete_id = a.id) as scene_count
         from athletes a order by a.name collate nocase`,
      )
      .all() as unknown as (AthleteRow & { session_count: number; scene_count: number })[];
    const athletes: AthleteUsageDto[] = rows.map((row) => ({
      ...toAthleteDto(row),
      sessionCount: row.session_count,
      sceneCount: row.scene_count,
    }));
    return c.json({ athletes });
  });

  app.post('/athletes', async (c) => {
    userOf(c);
    const body = await readJson(c, z.strictObject({ name, catchHand: catchHand.default(null) }));
    if (nameTaken(body.name, null)) throw new HTTPException(409, { message: `An athlete named "${body.name}" already exists` });
    const id = randomUUID();
    db.prepare('insert into athletes (id, name, catch_hand, created_at) values (?, ?, ?, ?)').run(id, body.name, body.catchHand, now());
    return c.json({ athlete: toAthleteDto(getAthlete(id)!) }, 201);
  });

  app.patch('/athletes/:id', async (c) => {
    userOf(c);
    const athlete = getAthlete(c.req.param('id')) ?? notFound('Athlete');
    const body = await readJson(c, z.strictObject({ name: name.optional(), catchHand: catchHand.optional() }));
    if (body.name !== undefined && nameTaken(body.name, athlete.id)) {
      throw new HTTPException(409, { message: `An athlete named "${body.name}" already exists` });
    }
    db.prepare('update athletes set name = ?, catch_hand = ? where id = ?').run(
      body.name ?? athlete.name,
      body.catchHand !== undefined ? body.catchHand : athlete.catch_hand,
      athlete.id,
    );
    return c.json({ athlete: toAthleteDto(getAthlete(athlete.id)!) });
  });

  // Only athletes no session or scene refers to, so nothing silently loses its athlete.
  app.delete('/athletes/:id', (c) => {
    userOf(c);
    const athlete = getAthlete(c.req.param('id')) ?? notFound('Athlete');
    const sessions = Number(db.prepare('select count(*) as n from session_athletes where athlete_id = ?').get(athlete.id)!.n);
    const scenes = Number(db.prepare('select count(*) as n from scenes where athlete_id = ?').get(athlete.id)!.n);
    if (sessions > 0 || scenes > 0) {
      throw new HTTPException(409, {
        message: `${athlete.name} is still used by ${sessions} session(s) and ${scenes} scene(s); remove them there first`,
      });
    }
    db.prepare('delete from athletes where id = ?').run(athlete.id);
    return c.body(null, 204);
  });

  return app;
}
