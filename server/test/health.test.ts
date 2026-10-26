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
  assert.equal(body.cors.ok, true);
  assert.equal(body.clockSkew.ok, true);
});

test('reports the CORS policy as informational only — it does not flip the overall status to unhealthy', async () => {
  storage.checkCors = async () => ({ ok: false, reason: 'simulated: origin not allowed' });
  const res = await request('/api/health', { method: 'GET' });
  const body = await json<HealthDto>(res, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cors.ok, false);
  assert.equal(body.cors.reason, 'simulated: origin not allowed');
});

test('reports clock skew as informational only — it does not flip the overall status to unhealthy', async () => {
  storage.checkClockSkew = async () => ({ ok: false, skewSeconds: 120, reason: 'simulated: clock ahead by 120s' });
  const res = await request('/api/health', { method: 'GET' });
  const body = await json<HealthDto>(res, 200);
  assert.equal(body.ok, true);
  assert.equal(body.clockSkew.ok, false);
  assert.equal(body.clockSkew.skewSeconds, 120);
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
