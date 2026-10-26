import { Hono } from 'hono';
import type { HealthDto } from '../../../shared/types.ts';
import type { AppDeps, AppEnv } from '../context.ts';
import { now } from '../db.ts';

/**
 * Liveness/readiness check: confirms the database and object storage are both reachable.
 * Unauthenticated (Docker/Arcane health checks have no session), and only exposes booleans —
 * the actual errors are logged server-side, not sent to the client.
 */
export function healthRoutes({ db, storage, config }: AppDeps) {
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

    const cors = await storage.checkCors(config.appOrigin).catch((err: unknown) => {
      console.error('Health check: could not check CORS', err);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    });

    const clockSkew = await storage.checkClockSkew().catch((err: unknown) => {
      console.error('Health check: could not check clock skew', err);
      return { ok: false, skewSeconds: null, reason: err instanceof Error ? err.message : String(err) };
    });

    const body: HealthDto = {
      ok: database && storageOk,
      database: { ok: database },
      storage: { ok: storageOk },
      cors,
      clockSkew,
      build: config.build,
      checkedAt: now(),
    };
    return c.json(body, body.ok ? 200 : 503);
  });

  return app;
}
