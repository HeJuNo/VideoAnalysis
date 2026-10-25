import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { ensureSeedProfiles } from './seed-profiles.ts';
import { createS3Storage } from './storage.ts';

const config = loadConfig();
const db = openDb(config.databasePath);
ensureSeedProfiles(db);
const app = createApp({ db, storage: createS3Storage(config.s3), config });

// In production the API also serves the built web app (`npm run build`).
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webDist)) app.use('/*', serveStatic({ root: relative(process.cwd(), webDist) }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port} (database: ${config.databasePath})`);
});
