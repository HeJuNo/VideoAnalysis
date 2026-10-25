import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { VideoProbe } from '../../../shared/mp4-probe.ts';
import type { CreateUploadResponse } from '../../../shared/types.ts';
import { planParts } from '../../../shared/upload-plan.ts';
import { userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { getVideo, toVideoDto, type VideoRow } from '../repo.ts';
import { NoSuchUploadError } from '../storage.ts';

const PART_URL_TTL_SEC = 60 * 60;
const MAX_URLS_PER_REQUEST = 100;

const probeSchema = z.object({
  container: z.enum(['mp4', 'mov']),
  videoCodec: z.string().max(8).nullable(),
  codecFamily: z.enum(['h264', 'hevc', 'av1', 'vp9', 'other']).nullable(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  rotation: z.literal([0, 90, 180, 270]).optional(),
  durationSec: z.number().nonnegative().nullable(),
  fps: z.number().nonnegative().nullable(),
  variableFrameRate: z.boolean(),
  faststart: z.boolean(),
  fragmented: z.boolean(),
  audioCodec: z.string().max(8).nullable(),
}) satisfies z.ZodType<VideoProbe>;

type ActiveUpload = VideoRow & { upload_id: string; part_count: number; part_size: number };

/**
 * Direct-to-storage multipart upload: the API only creates the upload, signs part URLs and
 * completes it. The browser PUTs the bytes straight to the bucket.
 */
export function uploadRoutes({ db, storage, config }: AppDeps) {
  const app = new Hono<AppEnv>();

  function activeUpload(c: Context<AppEnv>, id: string): ActiveUpload {
    const user = userOf(c);
    const video = getVideo(db, id) ?? notFound('Upload');
    if (video.uploaded_by !== user.id && user.role !== 'analyst') {
      throw new HTTPException(403, { message: 'Not your upload' });
    }
    if (video.status !== 'uploading' || !video.upload_id || !video.part_count || !video.part_size) {
      throw new HTTPException(409, { message: 'Upload is not in progress' });
    }
    return video as ActiveUpload;
  }

  app.post('/sessions/:sessionId/uploads', async (c) => {
    const user = userOf(c);
    const sessionId = c.req.param('sessionId');
    if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) notFound('Session');
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(255),
        size: z
          .number()
          .int()
          .positive()
          .max(config.maxUploadBytes, { message: `Files larger than ${config.maxUploadBytes} bytes are not allowed` }),
        contentType: z.string().max(100).nullable(),
        fingerprint: z.string().min(1).max(400),
        probe: probeSchema.nullable(),
      }),
    );

    // Same file picked again after an interruption: continue where the stored parts end.
    const existingId = db
      .prepare(
        `select id from video_files where session_id = ? and fingerprint = ? and status = 'uploading'
         and uploaded_by = ? order by created_at desc limit 1`,
      )
      .get(sessionId, body.fingerprint, user.id);
    const existing = existingId ? getVideo(db, String(existingId.id)) : undefined;
    if (existing?.upload_id && existing.part_size && existing.part_count) {
      try {
        const completedParts = await storage.listParts(existing.storage_key, existing.upload_id);
        const response: CreateUploadResponse = {
          video: toVideoDto(existing),
          partSize: existing.part_size,
          partCount: existing.part_count,
          completedParts,
          resumed: true,
        };
        return c.json(response);
      } catch (err) {
        if (!(err instanceof NoSuchUploadError)) throw err;
        db.prepare('delete from video_files where id = ?').run(existing.id);
      }
    }

    const { partSize, partCount } = planParts(body.size);
    const id = randomUUID();
    // The stored file is named by its id only; the original name stays in the database.
    const key = `sessions/${sessionId}/${id}.${fileExtension(body.name)}`;
    const uploadId = await storage.createMultipartUpload(key, body.contentType);
    db.prepare(
      `insert into video_files (id, session_id, part_index, storage_key, original_name, size_bytes, content_type,
         status, upload_id, part_size, part_count, fingerprint, probe, uploaded_by, created_at)
       values (?, ?, (select coalesce(max(part_index), -1) + 1 from video_files where session_id = ?),
         ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      sessionId,
      key,
      body.name,
      body.size,
      body.contentType,
      uploadId,
      partSize,
      partCount,
      body.fingerprint,
      body.probe ? JSON.stringify(body.probe) : null,
      user.id,
      now(),
    );
    const response: CreateUploadResponse = {
      video: toVideoDto(getVideo(db, id)!),
      partSize,
      partCount,
      completedParts: [],
      resumed: false,
    };
    return c.json(response, 201);
  });

  app.post('/uploads/:id/part-urls', async (c) => {
    const video = activeUpload(c, c.req.param('id'));
    const { partNumbers } = await readJson(
      c,
      z.object({
        partNumbers: z.array(z.number().int().min(1).max(video.part_count)).min(1).max(MAX_URLS_PER_REQUEST),
      }),
    );
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart(video.storage_key, video.upload_id, partNumber, PART_URL_TTL_SEC),
      })),
    );
    return c.json({ urls, expiresInSec: PART_URL_TTL_SEC });
  });

  app.post('/uploads/:id/complete', async (c) => {
    const video = activeUpload(c, c.req.param('id'));
    const { parts } = await readJson(
      c,
      z.object({
        parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) })).min(1),
      }),
    );
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (sorted.length !== video.part_count || sorted.some((p, i) => p.partNumber !== i + 1)) {
      throw new HTTPException(400, { message: `Expected parts 1-${video.part_count}` });
    }

    try {
      await storage.completeMultipartUpload(video.storage_key, video.upload_id, sorted);
    } catch (err) {
      throw new HTTPException(502, { message: `Storage rejected the upload: ${(err as Error).message}` });
    }

    const stored = await storage.headObject(video.storage_key);
    if (stored?.size !== video.size_bytes) {
      await storage.deleteObject(video.storage_key).catch(() => {});
      db.prepare(`update video_files set status = 'failed', upload_id = null where id = ?`).run(video.id);
      throw new HTTPException(409, {
        message: `Stored size ${stored?.size ?? 0} does not match the file size ${video.size_bytes}`,
      });
    }

    db.prepare(`update video_files set status = 'ready', upload_id = null, completed_at = ? where id = ?`).run(
      now(),
      video.id,
    );
    return c.json({ video: toVideoDto(getVideo(db, video.id)!) });
  });

  app.delete('/uploads/:id', async (c) => {
    const video = activeUpload(c, c.req.param('id'));
    await storage.abortMultipartUpload(video.storage_key, video.upload_id);
    db.prepare('delete from video_files where id = ?').run(video.id);
    return c.body(null, 204);
  });

  return app;
}

/** "Game 1.MOV" → "mov"; files without a usable extension get "bin". */
function fileExtension(name: string): string {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toLowerCase() ?? 'bin';
}
