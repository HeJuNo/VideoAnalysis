import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Role, UserDto } from '../../../shared/types.ts';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth.ts';
import type { AppDeps, AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { readJson } from '../http.ts';

const COOKIE = 'sid';
const SESSION_DAYS = 30;
// Compared against when the email is unknown, so both failure paths take the same time.
const dummyHash = hashPassword('not-a-real-password');

export function loadUser({ db }: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, COOKIE);
    const row = token
      ? db
          .prepare(
            `select u.id, u.email, u.role from auth_sessions s join users u on u.id = s.user_id
             where s.token_hash = ? and s.expires_at > ?`,
          )
          .get(hashToken(token), now())
      : undefined;
    c.set('user', row ? { id: String(row.id), email: String(row.email), role: row.role as Role } : null);
    await next();
  };
}

export function authRoutes({ db, config }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    const { email, password } = await readJson(
      c,
      z.object({ email: z.string().trim().toLowerCase().min(1), password: z.string().min(1) }),
    );
    const row = db.prepare('select id, email, role, password_hash from users where email = ?').get(email);
    const valid = await verifyPassword(password, row ? String(row.password_hash) : await dummyHash);
    if (!row || !valid) throw new HTTPException(401, { message: 'Invalid email or password' });

    const { token, tokenHash } = newSessionToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    db.prepare('delete from auth_sessions where expires_at <= ?').run(now());
    db.prepare('insert into auth_sessions (token_hash, user_id, expires_at, created_at) values (?, ?, ?, ?)').run(
      tokenHash,
      String(row.id),
      expires.toISOString(),
      now(),
    );
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
      expires,
    });
    const user: UserDto = { id: String(row.id), email: String(row.email), role: row.role as Role };
    return c.json({ user });
  });

  app.post('/logout', (c) => {
    const token = getCookie(c, COOKIE);
    if (token) db.prepare('delete from auth_sessions where token_hash = ?').run(hashToken(token));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/me', (c) => {
    const user = c.get('user');
    if (!user) throw new HTTPException(401, { message: 'Not signed in' });
    return c.json({ user });
  });

  return app;
}
