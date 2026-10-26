import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
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

// TLS_CERT_PATH/TLS_KEY_PATH: terminate HTTPS directly (e.g. a self-signed cert for LAN-only
// access with no reverse proxy in front). Without them, plain HTTP, same as before.
const tls = config.tls;
const scheme = tls ? 'https' : 'http';
serve(
  tls
    ? { fetch: app.fetch, port: config.port, createServer, serverOptions: { cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) } }
    : { fetch: app.fetch, port: config.port },
  (info) => {
    console.log(`API listening on ${scheme}://localhost:${info.port} (database: ${config.databasePath})`);
  },
);
