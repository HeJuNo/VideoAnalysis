import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const BASE_ENV = {
  S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
  S3_BUCKET: 'videos',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

test('tls is null when neither TLS_CERT_PATH nor TLS_KEY_PATH is set', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.tls, null);
});

test('tls is set when both TLS_CERT_PATH and TLS_KEY_PATH are set', () => {
  const config = loadConfig({ ...BASE_ENV, TLS_CERT_PATH: '/certs/cert.pem', TLS_KEY_PATH: '/certs/key.pem' });
  assert.deepEqual(config.tls, { certPath: '/certs/cert.pem', keyPath: '/certs/key.pem' });
});

test('rejects TLS_CERT_PATH without TLS_KEY_PATH', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, TLS_CERT_PATH: '/certs/cert.pem' }));
});

test('rejects TLS_KEY_PATH without TLS_CERT_PATH', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, TLS_KEY_PATH: '/certs/key.pem' }));
});
