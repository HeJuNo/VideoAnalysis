import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { probeMp4, type VideoProbe } from '../../../shared/mp4-probe.ts';
import type { OrphanedGroupDto } from '../../../shared/types.ts';
import { userOf, type AppDeps, type AppEnv } from '../context.ts';
import { now } from '../db.ts';
import { notFound, readJson } from '../http.ts';
import { getVideo, toVideoDto } from '../repo.ts';

const KEY_PATTERN = /^sessions\/([^/]+)\/([^/.]+)\.([a-z0-9]+)$/i;
const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v' };
const MAX_KEYS_PER_IMPORT = 50;

/**
 * Videos found in storage that no session references — typically left behind after a database
 * reset wiped the rows but the bucket (which the app never clears on its own) kept the objects.
 * Grouped by the session id they were originally stored under, which no longer exists.
 */
export function recoveredRoutes({ db, storage }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/recovered-videos', async (c) => {
    userOf(c);
    const objects = await storage.listObjects('sessions/');
    const known = new Set(
      (db.prepare('select storage_key from video_files').all() as { storage_key: string }[]).map(
        (r) => r.storage_key,
      ),
    );
    const groups = new Map<string, OrphanedGroupDto>();
    for (const object of objects) {
      if (known.has(object.key)) continue;
      const match = KEY_PATTERN.exec(object.key);
      if (!match) continue;
      const sourceSessionId = match[1];
      const group = groups.get(sourceSessionId) ?? { sourceSessionId, videos: [], totalBytes: 0 };
      group.videos.push({ storageKey: object.key, sizeBytes: object.size });
      group.totalBytes += object.size;
      groups.set(sourceSessionId, group);
    }
    return c.json({ groups: [...groups.values()] });
  });

  // Attaches already-stored objects to a session as ready videos, without re-uploading them.
  app.post('/sessions/:sessionId/recovered-videos', async (c) => {
    const user = userOf(c);
    const sessionId = c.req.param('sessionId');
    if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) notFound('Session');
    const { storageKeys } = await readJson(
      c,
      z.object({ storageKeys: z.array(z.string().min(1)).min(1).max(MAX_KEYS_PER_IMPORT) }),
    );

    const imported = [];
    for (const key of storageKeys) {
      if (db.prepare('select 1 from video_files where storage_key = ?').get(key)) continue;
      const head = await storage.headObject(key);
      if (!head) continue;
      const match = KEY_PATTERN.exec(key);
      const ext = match?.[3].toLowerCase() ?? 'bin';

      let probe: VideoProbe | null = null;
      try {
        probe = await probeMp4((offset, length) => storage.getObjectRange(key, offset, length), head.size);
      } catch {
        probe = null; // Same handling as any file the app can't recognize: it still imports, just unplayable.
      }

      const id = randomUUID();
      db.prepare(
        `insert into video_files (id, session_id, part_index, storage_key, original_name, size_bytes, content_type,
           status, probe, uploaded_by, created_at, completed_at)
         values (?, ?, (select coalesce(max(part_index), -1) + 1 from video_files where session_id = ?),
           ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      ).run(
        id,
        sessionId,
        sessionId,
        key,
        `${match?.[2] ?? id}.${ext}`,
        head.size,
        CONTENT_TYPES[ext] ?? null,
        probe ? JSON.stringify(probe) : null,
        user.id,
        now(),
        now(),
      );
      imported.push(toVideoDto(getVideo(db, id)!));
    }
    return c.json({ videos: imported }, 201);
  });

  return app;
}
