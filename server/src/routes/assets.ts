// Small images (diagram backgrounds), uploaded straight to the bucket like videos but in a
// single signed PUT. They are served through a same-origin URL that redirects to a signed URL.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AssetDto } from '../../../shared/types.ts';
import { requireAnalyst, userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { notFound, readJson } from '../http.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_URL_TTL_SEC = 10 * 60;
const VIEW_URL_TTL_SEC = 60 * 60;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

interface AssetRow {
  id: string;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  width: number;
  height: number;
  status: 'uploading' | 'ready';
}

function toAssetDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    url: `/api/assets/${row.id}/file`,
  };
}

export function assetRoutes({ db, storage }: AppDeps) {
  const app = new Hono<AppEnv>();
  const getAsset = (id: string) => db.prepare('select * from assets where id = ?').get(id) as AssetRow | undefined;

  app.post('/assets', async (c) => {
    const user = requireAnalyst(c);
    const body = await readJson(
      c,
      z.strictObject({
        contentType: z.enum(Object.keys(EXTENSIONS) as [string, ...string[]], 'Use a PNG, JPEG or WebP image'),
        size: z.number().int().positive().max(MAX_IMAGE_BYTES, 'Images can be at most 5 MB'),
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000),
      }),
    );
    const id = randomUUID();
    const key = `assets/${id}.${EXTENSIONS[body.contentType]}`;
    db.prepare(
      `insert into assets (id, storage_key, content_type, size_bytes, width, height, status, created_by, created_at)
       values (?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
    ).run(id, key, body.contentType, body.size, body.width, body.height, user.id, now());
    const uploadUrl = await storage.presignPut(key, body.contentType, UPLOAD_URL_TTL_SEC);
    return c.json({ asset: toAssetDto(getAsset(id)!), uploadUrl }, 201);
  });

  app.post('/assets/:id/complete', async (c) => {
    requireAnalyst(c);
    const asset = getAsset(c.req.param('id')) ?? notFound('Image');
    if (asset.status === 'ready') return c.json({ asset: toAssetDto(asset) });
    const stored = await storage.headObject(asset.storage_key);
    if (stored?.size !== asset.size_bytes) {
      throw new HTTPException(409, { message: 'The image did not arrive in storage completely; upload it again' });
    }
    db.prepare(`update assets set status = 'ready' where id = ?`).run(asset.id);
    return c.json({ asset: toAssetDto(getAsset(asset.id)!) });
  });

  app.get('/assets/:id/file', async (c) => {
    userOf(c);
    const asset = getAsset(c.req.param('id'));
    if (!asset || asset.status !== 'ready') notFound('Image');
    return c.redirect(await storage.presignGet(asset.storage_key, VIEW_URL_TTL_SEC), 302);
  });

  return app;
}
