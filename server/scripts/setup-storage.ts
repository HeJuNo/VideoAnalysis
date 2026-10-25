// Checks bucket access and applies the CORS policy browser uploads need.
// Usage: npm run storage:setup [-- https://extra-origin.example]
// Needs a token that may change bucket settings (R2: "Admin Read & Write"); otherwise set the
// same policy by hand in the provider's dashboard (see README).
import {
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.ts';
import { createS3Client } from '../src/storage.ts';

const config = loadConfig();
const client = createS3Client(config.s3);
const Bucket = config.s3.bucket;
const origins = [config.appOrigin, ...process.argv.slice(2)];

await client.send(new HeadBucketCommand({ Bucket }));
console.log(`✔ Bucket "${Bucket}" is reachable at ${config.s3.endpoint}`);

await client.send(
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
          AllowedHeaders: ['content-type', 'range'],
          // The uploader needs each part's ETag to complete the upload.
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);
console.log(`✔ CORS allows uploads from ${origins.join(', ')}`);

// Replaces any existing lifecycle rules on the bucket. Never expires finished videos.
try {
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'abort-incomplete-uploads',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
    }),
  );
  console.log('✔ Unfinished uploads are cleaned up after 7 days');
} catch (err) {
  console.warn(`! Could not set the lifecycle rule (${(err as Error).message}); set it in the dashboard.`);
}
