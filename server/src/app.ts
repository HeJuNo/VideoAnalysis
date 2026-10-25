import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { AppDeps, AppEnv } from './context.ts';
import { assetRoutes } from './routes/assets.ts';
import { athleteRoutes } from './routes/athletes.ts';
import { authRoutes, loadUser } from './routes/auth.ts';
import { profileRoutes } from './routes/profiles.ts';
import { sceneRoutes } from './routes/scenes.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { videoRoutes } from './routes/videos.ts';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Cookie auth: reject cross-site form posts, and only accept JSON bodies (which need CORS preflight).
  app.use('/api/*', csrf({ origin: deps.config.appOrigin }));
  app.use('/api/*', async (c, next) => {
    const type = c.req.header('content-type');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && type && !type.startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Request body must be application/json' });
    }
    await next();
  });
  app.use('/api/*', loadUser(deps));
  app.use('/api/*', async (c, next) => {
    if (!c.req.path.startsWith('/api/auth/') && !c.get('user')) {
      throw new HTTPException(401, { message: 'Not signed in' });
    }
    await next();
  });

  app.route('/api/auth', authRoutes(deps));
  app.route('/api', sessionRoutes(deps));
  app.route('/api', uploadRoutes(deps));
  app.route('/api', videoRoutes(deps));
  app.route('/api', profileRoutes(deps));
  app.route('/api', assetRoutes(deps));
  app.route('/api', sceneRoutes(deps));
  app.route('/api', athleteRoutes(deps));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
