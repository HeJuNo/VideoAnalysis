import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { VideoProbe } from '../../../shared/mp4-probe.ts';
import type { PlaybackDto } from '../../../shared/types.ts';
import { requireAnalyst, userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { getVideo, toVideoDto, type VideoRow } from '../repo.ts';
import { createVideoSources } from '../sources.ts';

// Long enough for a full match; the player asks for a new URL when one expires.
const PLAYBACK_URL_TTL_SEC = 2 * 60 * 60;
const MIN_TRIMMED_SEC = 1;
// Probed durations and the browser's can differ slightly; allow trimming right up to the real end.
const DURATION_TOLERANCE_SEC = 1;

const editsSchema = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  rotation: z.literal([0, 90, 180, 270]).optional(),
  trimStartSec: z.number().nonnegative().nullable().optional(),
  trimEndSec: z.number().positive().nullable().optional(),
});

const roundMs = (sec: number | null) => (sec === null ? null : Math.round(sec * 1000) / 1000);

/** Removes the stored object (or pending upload) and marks the row deleted. Safe to retry. */
export async function removeVideo({ db, storage }: AppDeps, video: VideoRow): Promise<void> {
  if (video.status === 'deleted') return;
  if (video.upload_id) await storage.abortMultipartUpload(video.storage_key, video.upload_id);
  else await storage.deleteObject(video.storage_key);
  db.prepare(`update video_files set status = 'deleted', upload_id = null, deleted_at = ? where id = ?`).run(
    now(),
    video.id,
  );
}

export function videoRoutes(deps: AppDeps) {
  const { db, storage } = deps;
  const sources = createVideoSources(storage);
  const app = new Hono<AppEnv>();

  app.get('/videos/:id', (c) => {
    const video = getVideo(db, c.req.param('id')) ?? notFound('Video');
    return c.json({ video: toVideoDto(video) });
  });

  app.get('/videos/:id/playback', async (c) => {
    const video = getVideo(db, c.req.param('id')) ?? notFound('Video');
    if (video.status !== 'ready') throw new HTTPException(409, { message: 'Video is not ready for playback' });
    const source = sources[video.source];
    if (!source) throw new HTTPException(409, { message: `Unsupported video source "${video.source}"` });
    const playback: PlaybackDto = {
      url: await source.playbackUrl(video, PLAYBACK_URL_TTL_SEC),
      expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SEC * 1000).toISOString(),
    };
    return c.json(playback);
  });

  // Name, rotation and trim; fields left out keep their value, null clears a trim point.
  app.patch('/videos/:id', async (c) => {
    userOf(c);
    const video = getVideo(db, c.req.param('id')) ?? notFound('Video');
    if (video.status !== 'ready') throw new HTTPException(409, { message: 'Only uploaded videos can be edited' });
    const body = await readJson(c, editsSchema);

    const rotation = body.rotation ?? video.rotation;
    let start = roundMs(body.trimStartSec !== undefined ? body.trimStartSec : video.trim_start_sec);
    const end = roundMs(body.trimEndSec !== undefined ? body.trimEndSec : video.trim_end_sec);
    if (start === 0) start = null;

    const duration = video.probe ? (JSON.parse(video.probe) as VideoProbe).durationSec : null;
    if (duration !== null) {
      if (start !== null && start >= duration) throw new HTTPException(400, { message: 'Start is after the end of the video' });
      if (end !== null && end > duration + DURATION_TOLERANCE_SEC) {
        throw new HTTPException(400, { message: 'End is after the end of the video' });
      }
    }
    if (end !== null && end - (start ?? 0) < MIN_TRIMMED_SEC) {
      throw new HTTPException(400, { message: `The trimmed video must be at least ${MIN_TRIMMED_SEC} s long` });
    }

    db.prepare(
      'update video_files set original_name = ?, rotation = ?, trim_start_sec = ?, trim_end_sec = ? where id = ?',
    ).run(
      body.name ?? video.original_name,
      rotation,
      start,
      end,
      video.id,
    );
    return c.json({ video: toVideoDto(getVideo(db, video.id)!) });
  });

  app.delete('/videos/:id', async (c) => {
    requireAnalyst(c);
    const video = getVideo(db, c.req.param('id')) ?? notFound('Video');
    await removeVideo(deps, video);
    return c.body(null, 204);
  });

  return app;
}
