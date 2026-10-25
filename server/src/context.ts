import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { UserDto } from '../../shared/types.ts';
import type { Db } from './db.ts';
import type { ObjectStorage } from './storage.ts';

export interface AppConfig {
  appOrigin: string;
  cookieSecure: boolean;
  maxUploadBytes: number;
}

export interface AppDeps {
  db: Db;
  storage: ObjectStorage;
  config: AppConfig;
}

export type AppEnv = { Variables: { user: UserDto | null } };

/** The signed-in user; routes outside /api/auth are only reached when there is one. */
export function userOf(c: Context<AppEnv>): UserDto {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Not signed in' });
  return user;
}

export function requireAnalyst(c: Context<AppEnv>): UserDto {
  const user = userOf(c);
  if (user.role !== 'analyst') throw new HTTPException(403, { message: 'Analyst role required' });
  return user;
}
