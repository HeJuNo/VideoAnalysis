import { Hono } from 'hono';
import type { HealthDto } from '../../../shared/types.ts';
import type { AppDeps, AppEnv } from '../context.ts';
import { now } from '../db.ts';

/**
 * Liveness/readiness check: confirms the database and object storage are both reachable.
 * Unauthenticated (Docker/Arcane health checks have no session), and only exposes booleans —
 * the actual errors are logged server-side, not sent to the client.
 */
export function healthRoutes({ db, storage }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/health', async (c) => {
    let database = true;
    try {
      db.prepare('select 1').get();
    } catch (err) {
      console.error('Health check: database unreachable', err);
      database = false;
    }

    let storageOk = true;
    try {
      await storage.ping();
    } catch (err) {
      console.error('Health check: storage unreachable', err);
      storageOk = false;
    }

    const body: HealthDto = {
      ok: database && storageOk,
      database: { ok: database },
      storage: { ok: storageOk },
      checkedAt: now(),
    };
    return c.json(body, body.ok ? 200 : 503);
  });

  return app;
}
