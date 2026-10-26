// Shared test setup: an app on an in-memory database with fake storage and two signed-in users.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { UploadedPart } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import type { AppEnv } from '../src/context.ts';
import { now, openDb, type Db } from '../src/db.ts';
import { NoSuchUploadError, type ObjectStorage } from '../src/storage.ts';

export const ORIGIN = 'http://localhost:5173';
export const MIB = 1024 * 1024;

/** In-memory stand-in for the bucket; tests "upload" with putPart() and putObject(). */
export class FakeStorage implements ObjectStorage {
  uploads = new Map<string, { key: string; parts: Map<number, UploadedPart> }>();
  objects = new Map<string, number>();
  objectBytes = new Map<string, Uint8Array>();

  async createMultipartUpload(key: string) {
    const id = randomUUID();
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  async presignUploadPart(key: string, uploadId: string, partNumber: number) {
    return `https://storage.test/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  async listParts(_key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new NoSuchUploadError();
    return [...upload.parts.values()];
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number }[]) {
    const upload = this.uploads.get(uploadId)!;
    this.objects.set(key, parts.reduce((n, p) => n + upload.parts.get(p.partNumber)!.size, 0));
    this.uploads.delete(uploadId);
  }
  async abortMultipartUpload(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async headObject(key: string) {
    return this.objects.has(key) ? { size: this.objects.get(key)! } : null;
  }
  async presignGet(key: string) {
    return `https://storage.test/${key}?signed`;
  }
  async presignPut(key: string, contentType: string) {
    return `https://storage.test/${key}?put&type=${encodeURIComponent(contentType)}`;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
    this.objectBytes.delete(key);
  }
  async listObjects(prefix: string) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, size]) => ({ key, size }));
  }
  async getObjectRange(key: string, offset: number, length: number) {
    const bytes = this.objectBytes.get(key);
    if (!bytes) throw new Error(`No bytes recorded for ${key}; pass them to putObject()`);
    return bytes.slice(offset, offset + length);
  }
  putPart(uploadId: string, partNumber: number, size: number) {
    this.uploads.get(uploadId)!.parts.set(partNumber, { partNumber, etag: `"etag-${partNumber}"`, size });
  }
  /** `bytes` is only needed for tests that call getObjectRange() (e.g. probing on import). */
  putObject(key: string, size: number, bytes?: Uint8Array) {
    this.objects.set(key, size);
    if (bytes) this.objectBytes.set(key, bytes);
  }
  onlyUploadId(): string {
    assert.equal(this.uploads.size, 1);
    return [...this.uploads.keys()][0];
  }
}

export type RequestOptions = { method?: string; body?: unknown; cookie?: string };

export interface TestContext {
  app: Hono<AppEnv>;
  db: Db;
  storage: FakeStorage;
  analyst: string;
  tagger: string;
  /** Same-origin JSON request, as the web app sends them. */
  request(path: string, options?: RequestOptions): Promise<Response>;
}

export async function setup(): Promise<TestContext> {
  const db = openDb(':memory:');
  const storage = new FakeStorage();
  const app = createApp({ db, storage, config: { appOrigin: ORIGIN, cookieSecure: false, maxUploadBytes: 10 * 1024 * MIB } });
  const request = async (path: string, { method, body, cookie }: RequestOptions = {}) =>
    app.request(path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  for (const [email, role] of [
    ['analyst@test.dev', 'analyst'],
    ['tagger@test.dev', 'tagger'],
  ]) {
    db.prepare('insert into users (id, email, password_hash, role, created_at) values (?, ?, ?, ?, ?)').run(
      randomUUID(),
      email,
      await hashPassword('correct horse battery'),
      role,
      now(),
    );
  }
  const login = async (email: string) => {
    const res = await request('/api/auth/login', { body: { email, password: 'correct horse battery' } });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie')!.split(';')[0];
  };
  return { app, db, storage, request, analyst: await login('Analyst@test.dev'), tagger: await login('tagger@test.dev') };
}

export async function json<T>(res: Response, status = 200): Promise<T> {
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()) as T;
}
