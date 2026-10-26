import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Hono } from 'hono';
import type { HealthDto } from '../../shared/types.ts';
import type { AppEnv } from '../src/context.ts';
import { json, setup, type FakeStorage, type RequestOptions } from './helpers.ts';

let app: Hono<AppEnv>;
let storage: FakeStorage;
let request: (path: string, options?: RequestOptions) => Promise<Response>;

beforeEach(async () => {
  ({ app, storage, request } = await setup());
});

test('reports ok when the database and storage are both reachable, without needing to sign in', async () => {
  const res = await request('/api/health', { method: 'GET' });
  const body = await json<HealthDto>(res, 200);
  assert.equal(body.ok, true);
  assert.equal(body.database.ok, true);
  assert.equal(body.storage.ok, true);
});

test('reports a 503 and storage.ok false when storage is unreachable', async () => {
  storage.ping = async () => {
    throw new Error('simulated: bucket unreachable');
  };
  const res = await request('/api/health', { method: 'GET' });
  const body = await json<HealthDto>(res, 503);
  assert.equal(body.ok, false);
  assert.equal(body.database.ok, true);
  assert.equal(body.storage.ok, false);
});
