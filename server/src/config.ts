import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** When the Docker image was built; "dev" outside Docker, where no such file is generated. */
export interface BuildInfo {
  builtAt: string;
}

function loadBuildInfo(): BuildInfo {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, 'server/build-info.json'), 'utf8')) as BuildInfo;
  } catch {
    return { builtAt: 'dev' };
  }
}

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8787),
    DATABASE_PATH: z.string().min(1).default('data/app.db'),
    APP_ORIGIN: z.url().default('http://localhost:5173'),
    COOKIE_SECURE: z.stringbool().default(false),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('auto'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
    // Serves HTTPS directly (e.g. a self-signed cert for LAN-only access with no reverse proxy).
    // Both or neither; secure contexts (crypto.randomUUID, Secure cookies) need real TLS either way.
    TLS_CERT_PATH: z.string().min(1).optional(),
    TLS_KEY_PATH: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.TLS_CERT_PATH) === Boolean(v.TLS_KEY_PATH), {
    message: 'TLS_CERT_PATH and TLS_KEY_PATH must be set together',
  });

export interface Config {
  port: number;
  databasePath: string;
  appOrigin: string;
  cookieSecure: boolean;
  maxUploadBytes: number;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  /** Set when the server should terminate HTTPS itself (e.g. no reverse proxy in front of it). */
  tls: { certPath: string; keyPath: string } | null;
  build: BuildInfo;
}

/** For tools that only need the database (e.g. creating users) and no storage settings. */
export function loadDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.DATABASE_PATH || 'data/app.db';
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values in .env mean "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new Error(`Invalid configuration (see .env.example):\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    port: e.PORT,
    databasePath: loadDatabasePath({ DATABASE_PATH: e.DATABASE_PATH }),
    appOrigin: e.APP_ORIGIN,
    cookieSecure: e.COOKIE_SECURE,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    },
    tls: e.TLS_CERT_PATH && e.TLS_KEY_PATH ? { certPath: e.TLS_CERT_PATH, keyPath: e.TLS_KEY_PATH } : null,
    build: loadBuildInfo(),
  };
}
