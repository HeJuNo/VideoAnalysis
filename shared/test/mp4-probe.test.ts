import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playability, probeMp4, ProbeError, type ByteReader } from '../mp4-probe.ts';

// Minimal ISO BMFF builders: just enough structure for the probe to walk.

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v));
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
}

function largeBox(type: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  header.set(ascii(type), 4);
  view.setBigUint64(8, BigInt(16 + payload.length));
  return concat(header, payload);
}

interface TrackSpec {
  handler: 'vide' | 'soun';
  /** Display rotation written into tkhd's matrix. */
  rotation?: 0 | 90 | 180 | 270;
  codec: string;
  timescale: number;
  duration: number;
  stts: [count: number, delta: number][];
  width?: number;
  height?: number;
}

function trak(spec: TrackSpec): Uint8Array {
  const mdhd = box('mdhd', u32(0, 0, 0, spec.timescale, spec.duration, 0));
  const hdlr = box('hdlr', u32(0, 0), ascii(spec.handler), new Uint8Array(13));
  const entry = new Uint8Array(78);
  const entryView = new DataView(entry.buffer);
  entryView.setUint32(0, entry.length);
  entry.set(ascii(spec.codec), 4);
  entryView.setUint16(32, spec.width ?? 0);
  entryView.setUint16(34, spec.height ?? 0);
  const stsd = box('stsd', u32(0, 1), entry);
  const stts = box('stts', u32(0, spec.stts.length), ...spec.stts.map(([c, d]) => u32(c, d)));
  // tkhd v0: version/flags(4) times/ids/duration(20) reserved/layer/volume(16) matrix(36) width(4) height(4)
  const matrices = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
  const [a, b, c, d] = matrices[spec.rotation ?? 0];
  const fixed = (n: number) => (n * 65536) >>> 0;
  const tkhd = box('tkhd', new Uint8Array(40), u32(fixed(a), fixed(b), 0, fixed(c), fixed(d), 0, 0, 0, 0x40000000), u32(0, 0));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stts))));
}

const h264: TrackSpec = {
  handler: 'vide',
  codec: 'avc1',
  timescale: 12800,
  duration: 128000,
  stts: [[250, 512]],
  width: 1920,
  height: 1080,
};
const aac: TrackSpec = { handler: 'soun', codec: 'mp4a', timescale: 48000, duration: 480000, stts: [[469, 1024]] };

const ftyp = (brand = 'isom') => box('ftyp', ascii(brand), u32(0), ascii('isommp41'));
const moov = (...tracks: TrackSpec[]) => box('moov', box('mvhd', new Uint8Array(100)), ...tracks.map(trak));
const mdat = () => box('mdat', new Uint8Array(1000));

function reader(file: Uint8Array): ByteReader {
  return async (offset, length) => file.slice(offset, offset + length);
}

const probe = (file: Uint8Array) => probeMp4(reader(file), file.length);

test('reads codec, size, duration and fps of a faststart H.264 file', async () => {
  const result = await probe(concat(ftyp(), moov(h264, aac), mdat()));
  assert.deepEqual(result, {
    container: 'mp4',
    videoCodec: 'avc1',
    codecFamily: 'h264',
    width: 1920,
    height: 1080,
    durationSec: 10,
    fps: 25,
    variableFrameRate: false,
    faststart: true,
    fragmented: false,
    audioCodec: 'mp4a',
    rotation: 0,
  });
  assert.equal(playability(result), 'ok');
});

test('detects the index at the end of the file', async () => {
  const result = await probe(concat(ftyp(), mdat(), moov(h264)));
  assert.equal(result.faststart, false);
  assert.equal(result.fps, 25);
});

test('detects HEVC in a QuickTime file', async () => {
  const result = await probe(concat(ftyp('qt  '), moov({ ...h264, codec: 'hvc1' }), mdat()));
  assert.equal(result.container, 'mov');
  assert.equal(result.codecFamily, 'hevc');
  assert.equal(playability(result), 'limited');
});

test('reports NTSC frame rates', async () => {
  const result = await probe(concat(ftyp(), moov({ ...h264, timescale: 30000, duration: 300300, stts: [[300, 1001]] })));
  assert.equal(result.fps, 29.97);
  assert.equal(result.durationSec, 10.01);
});

test('flags variable frame rate and reports the average', async () => {
  const vfr = { ...h264, timescale: 30000, duration: 250000, stts: [[100, 1000], [100, 1500]] as [number, number][] };
  const result = await probe(concat(ftyp(), moov(vfr), mdat()));
  assert.equal(result.variableFrameRate, true);
  assert.equal(result.fps, 24);
});

test('tolerates a different duration on the last sample', async () => {
  const result = await probe(concat(ftyp(), moov({ ...h264, stts: [[249, 512], [1, 300]] }), mdat()));
  assert.equal(result.variableFrameRate, false);
  assert.equal(result.fps, 25);
});

test('walks past 64-bit box sizes', async () => {
  const result = await probe(concat(ftyp(), largeBox('mdat', new Uint8Array(64)), moov(h264)));
  assert.equal(result.faststart, false);
  assert.equal(result.codecFamily, 'h264');
});

test('rejects files that are not MP4/MOV', async () => {
  await assert.rejects(probe(concat(ascii('RIFF'), new Uint8Array(100))), ProbeError);
});

test('rejects files without a movie header', async () => {
  await assert.rejects(probe(concat(ftyp(), mdat())), /No movie header/);
});

test('unknown codecs and missing probes are unsupported', async () => {
  const result = await probe(concat(ftyp(), moov({ ...h264, codec: 'mp4v' })));
  assert.equal(result.codecFamily, 'other');
  assert.equal(playability(result), 'unsupported');
  assert.equal(playability(null), 'unsupported');
});

test('reports the displayed size of rotated phone video', async () => {
  const portrait = await probe(concat(ftyp(), moov({ ...h264, rotation: 90 }), mdat()));
  assert.deepEqual([portrait.width, portrait.height, portrait.rotation], [1080, 1920, 90]);
  const upsideDown = await probe(concat(ftyp(), moov({ ...h264, rotation: 180 }), mdat()));
  assert.deepEqual([upsideDown.width, upsideDown.height, upsideDown.rotation], [1920, 1080, 180]);
  assert.equal((await probe(concat(ftyp(), moov({ ...h264, rotation: 270 }), mdat()))).rotation, 270);
});
