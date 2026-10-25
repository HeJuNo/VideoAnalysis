import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ProfileDefinition } from '../../../shared/profile.ts';
import { requireAnalyst, userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { checkDefinition, createProfile, definitionSchema, getProfile, listProfiles, saveProfile } from '../profiles.ts';

const name = z.string().trim().min(1).max(80);
const sport = z.string().trim().min(1).max(60);

export function profileRoutes({ db }: AppDeps) {
  const app = new Hono<AppEnv>();

  const assetIsReady = (id: string) =>
    Boolean(db.prepare(`select 1 from assets where id = ? and status = 'ready'`).get(id));

  function validDefinition(def: unknown): ProfileDefinition {
    const parsed = definitionSchema.safeParse(def);
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
    const definition = parsed.data as ProfileDefinition;
    const problem = checkDefinition(definition, assetIsReady);
    if (problem) throw new HTTPException(400, { message: problem });
    return definition;
  }

  app.get('/profiles', (c) => {
    userOf(c);
    return c.json({ profiles: listProfiles(db, c.req.query('archived') === '1') });
  });

  app.get('/profiles/:id', (c) => {
    userOf(c);
    const version = c.req.query('version');
    const profile =
      getProfile(db, c.req.param('id'), version === undefined ? undefined : Number(version)) ?? notFound('Profile');
    return c.json({ profile });
  });

  // New profile from a definition, or a copy of an existing profile's current version.
  app.post('/profiles', async (c) => {
    const user = requireAnalyst(c);
    const body = await readJson(
      c,
      z.union([
        z.strictObject({ name, sport, definition: z.unknown() }),
        z.strictObject({ name, copyFrom: z.string() }),
      ]),
    );
    let input: { sport: string; definition: ProfileDefinition };
    if ('copyFrom' in body) {
      const source = getProfile(db, body.copyFrom) ?? notFound('Profile to copy');
      input = { sport: source.sport, definition: source.definition };
    } else {
      input = { sport: body.sport, definition: validDefinition(body.definition) };
    }
    const id = createProfile(db, { name: body.name, ...input, userId: user.id });
    return c.json({ profile: getProfile(db, id) }, 201);
  });

  // Saves a new version. `baseVersion` is the version the editor started from, so two analysts
  // editing at once cannot silently overwrite each other.
  app.put('/profiles/:id', async (c) => {
    const user = requireAnalyst(c);
    const current = getProfile(db, c.req.param('id')) ?? notFound('Profile');
    const body = await readJson(
      c,
      z.strictObject({ name, sport, definition: z.unknown(), baseVersion: z.number().int().positive() }),
    );
    if (body.baseVersion !== current.currentVersion) {
      throw new HTTPException(409, {
        message: `Someone saved version ${current.currentVersion} in the meantime. Reload to see it, then apply your changes again.`,
      });
    }
    saveProfile(db, current, { name: body.name, sport: body.sport, definition: validDefinition(body.definition), userId: user.id });
    return c.json({ profile: getProfile(db, current.id) });
  });

  app.post('/profiles/:id/archive', async (c) => {
    requireAnalyst(c);
    const profile = getProfile(db, c.req.param('id')) ?? notFound('Profile');
    const { archived } = await readJson(c, z.strictObject({ archived: z.boolean() }));
    db.prepare('update sport_profiles set archived_at = ?, updated_at = ? where id = ?').run(
      archived ? now() : null,
      now(),
      profile.id,
    );
    return c.json({ profile: getProfile(db, profile.id) });
  });

  return app;
}
