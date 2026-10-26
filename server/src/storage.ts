import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadedPart } from '../../shared/types.ts';
import type { Config } from './config.ts';

/**
 * The only storage operations the app uses. Everything goes through the plain S3 API, so
 * switching from Cloudflare R2 to Hetzner (or any S3-compatible provider) is a config change.
 */
export interface ObjectStorage {
  createMultipartUpload(key: string, contentType: string | null): Promise<string>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSec: number): Promise<string>;
  /** Throws NoSuchUploadError when the upload was completed, aborted or expired. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: Omit<UploadedPart, 'size'>[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Returns null when the object does not exist. */
  headObject(key: string): Promise<{ size: number } | null>;
  presignGet(key: string, expiresInSec: number): Promise<string>;
  /** Single-request upload for small files; the browser must send the same Content-Type. */
  presignPut(key: string, contentType: string, expiresInSec: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  /** Throws when the bucket is unreachable or misconfigured; used for health checks. */
  ping(): Promise<void>;
  /** Whether the bucket's CORS policy allows browser uploads from this origin; used for health checks. */
  checkCors(origin: string): Promise<{ ok: boolean; reason: string | null }>;
  /**
   * How far this server's clock is from the storage endpoint's, in seconds (positive = ahead).
   * A skewed clock makes presigned URLs expire early or immediately — see its effect on uploads.
   */
  checkClockSkew(): Promise<{ ok: boolean; skewSeconds: number | null; reason: string | null }>;
  /** Keys and sizes of every object under the given prefix. */
  listObjects(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Reads part of an object, e.g. to probe a video's header without fetching the whole file. */
  getObjectRange(key: string, offset: number, length: number): Promise<Uint8Array>;
}

export class NoSuchUploadError extends Error {}

// Beyond this, a presigned URL's embedded timestamp is skewed enough to risk expiring early
// (or being rejected outright) well before its nominal TTL.
const MAX_CLOCK_SKEW_SEC = 30;

export function createS3Client(s3: Config['s3']): S3Client {
  return new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    // Newer SDKs add checksum headers by default, which presigned browser uploads cannot send.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createS3Storage(s3: Config['s3']): ObjectStorage {
  const client = createS3Client(s3);
  const Bucket = s3.bucket;

  return {
    async createMultipartUpload(key, contentType) {
      const out = await client.send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType ?? undefined }),
      );
      if (!out.UploadId) throw new Error('Storage did not return an upload id');
      return out.UploadId;
    },

    presignUploadPart(key, uploadId, partNumber, expiresInSec) {
      return getSignedUrl(
        client,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: expiresInSec },
      );
    },

    async listParts(key, uploadId) {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      try {
        do {
          const out = await client.send(
            new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
          );
          for (const p of out.Parts ?? []) {
            if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
          }
          marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
        } while (marker);
      } catch (err) {
        if (isS3Error(err, 'NoSuchUpload', 404)) throw new NoSuchUploadError('Upload no longer exists in storage');
        throw err;
      }
      return parts;
    },

    async completeMultipartUpload(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    },

    async abortMultipartUpload(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (err) {
        if (!isS3Error(err, 'NoSuchUpload', 404)) throw err;
      }
    },

    async headObject(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: out.ContentLength ?? 0 };
      } catch (err) {
        if (isS3Error(err, 'NotFound', 404)) return null;
        throw err;
      }
    },

    presignGet(key, expiresInSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSec });
    },

    presignPut(key, contentType, expiresInSec) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresInSec,
      });
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async ping() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },

    async checkCors(origin) {
      let rules;
      try {
        rules = (await client.send(new GetBucketCorsCommand({ Bucket }))).CORSRules ?? [];
      } catch (err) {
        return { ok: false, reason: `Could not read the bucket's CORS policy: ${(err as Error).message}` };
      }
      // Matches what `npm run storage:setup` configures: PUT allowed, ETag exposed (needed to
      // complete a multipart upload), for this exact origin or a wildcard.
      const covered = rules.some(
        (rule) =>
          (rule.AllowedOrigins ?? []).some((allowed) => allowed === '*' || allowed === origin) &&
          (rule.AllowedMethods ?? []).includes('PUT') &&
          (rule.ExposeHeaders ?? []).some((header) => header.toLowerCase() === 'etag'),
      );
      return covered
        ? { ok: true, reason: null }
        : { ok: false, reason: `No CORS rule allows PUT uploads (with ETag exposed) from ${origin}` };
    },

    async checkClockSkew() {
      let res: Response;
      try {
        res = await fetch(s3.endpoint, { method: 'HEAD' });
      } catch (err) {
        return { ok: false, skewSeconds: null, reason: `Could not reach the storage endpoint: ${(err as Error).message}` };
      }
      const header = res.headers.get('date');
      if (!header) return { ok: false, skewSeconds: null, reason: "Storage endpoint didn't return a Date header" };
      const skewSeconds = Math.round((Date.now() - Date.parse(header)) / 1000);
      const ok = Math.abs(skewSeconds) <= MAX_CLOCK_SKEW_SEC;
      return {
        ok,
        skewSeconds,
        reason: ok ? null : `Server clock is ${skewSeconds > 0 ? 'ahead' : 'behind'} by ${Math.abs(skewSeconds)}s`,
      };
    },

    async listObjects(prefix) {
      const objects: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of out.Contents ?? []) {
          if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },

    async getObjectRange(key, offset, length) {
      const out = await client.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }),
      );
      if (!out.Body) return new Uint8Array(0);
      return out.Body.transformToByteArray();
    },
  };
}

function isS3Error(err: unknown, name: string, status: number): boolean {
  return err instanceof S3ServiceException && (err.name === name || err.$metadata.httpStatusCode === status);
}
