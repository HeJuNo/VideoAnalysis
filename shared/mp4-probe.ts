/**
 * Reads codec, timing and layout facts from an MP4/MOV (ISO BMFF) file without decoding it.
 * Only top-level box headers and the `moov` box are read, so a 4 GB file costs a few MB at most.
 */

export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

export type CodecFamily = 'h264' | 'hevc' | 'av1' | 'vp9' | 'other';

export interface VideoProbe {
  container: 'mp4' | 'mov';
  /** Sample entry fourcc of the first video track, e.g. `avc1`, `hvc1`. */
  videoCodec: string | null;
  codecFamily: CodecFamily | null;
  /** Displayed size: already swapped when the file says to show it rotated by 90°/270°. */
  width: number | null;
  height: number | null;
  /**
   * Rotation stored in the file (phones record portrait video sideways plus this flag); the
   * browser applies it on its own. Missing in probes stored before this was read.
   */
  rotation?: 0 | 90 | 180 | 270;
  durationSec: number | null;
  fps: number | null;
  variableFrameRate: boolean;
  /** `moov` before `mdat`: the browser can start playback without fetching the index from the end. */
  faststart: boolean;
  fragmented: boolean;
  audioCodec: string | null;
}

/** `ok`: plays in all current browsers. `limited`: Safari and some hardware only. */
export type Playability = 'ok' | 'limited' | 'unsupported';

export class ProbeError extends Error {}

const MAX_MOOV_BYTES = 128 * 1024 * 1024;
const QUICKTIME_TOP_LEVEL = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);
const CODEC_FAMILIES: Record<string, CodecFamily> = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  av01: 'av1',
  vp09: 'vp9',
};

interface Box {
  type: string;
  start: number;
  headerSize: number;
  end: number;
}

interface Track {
  handler: string;
  codec: string | null;
  rotation: 0 | 90 | 180 | 270;
  timescale: number;
  duration: number;
  width: number | null;
  height: number | null;
  sampleCount: number;
  totalDelta: number;
  dominantDelta: number;
  dominantCount: number;
}

export function playability(probe: VideoProbe | null): Playability {
  if (!probe?.codecFamily) return 'unsupported';
  if (probe.codecFamily === 'h264') return 'ok';
  if (probe.codecFamily === 'other') return 'unsupported';
  return 'limited';
}

export function fileReader(file: Blob): ByteReader {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

export async function probeMp4(read: ByteReader, fileSize: number): Promise<VideoProbe> {
  let brand: string | null = null;
  let moovOffset = -1;
  let moovSize = 0;
  let mdatOffset = -1;
  let fragmented = false;

  for (let offset = 0, index = 0; offset < fileSize; index++) {
    const header = await read(offset, Math.min(16, fileSize - offset));
    const box = parseHeader(header, 0, fileSize - offset);
    if (!box) break;
    if (index === 0 && box.type !== 'ftyp' && !QUICKTIME_TOP_LEVEL.has(box.type)) {
      throw new ProbeError('Not an MP4/MOV file');
    }
    if (box.type === 'ftyp' && box.end >= box.headerSize + 4) {
      brand = fourcc(await read(offset + box.headerSize, 4), 0);
    } else if (box.type === 'moov') {
      moovOffset = offset;
      moovSize = box.end;
    } else if (box.type === 'mdat' && mdatOffset < 0) {
      mdatOffset = offset;
    } else if (box.type === 'moof') {
      fragmented = true;
    }
    if (moovOffset >= 0 && mdatOffset >= 0) break;
    offset += box.end;
  }

  if (moovOffset < 0) throw new ProbeError('No movie header (moov) found; the file may be incomplete');
  if (moovSize > MAX_MOOV_BYTES) throw new ProbeError('Movie header is too large to inspect');

  const bytes = await read(moovOffset, moovSize);
  try {
    return describe(bytes, {
      container: brand === null || brand === 'qt  ' ? 'mov' : 'mp4',
      faststart: mdatOffset < 0 || moovOffset < mdatOffset,
      fragmented,
    });
  } catch (err) {
    if (err instanceof RangeError) throw new ProbeError('Movie header is malformed');
    throw err;
  }
}

function describe(
  bytes: Uint8Array,
  layout: Pick<VideoProbe, 'container' | 'faststart' | 'fragmented'>,
): VideoProbe {
  const moov = parseHeader(bytes, 0, bytes.length);
  if (!moov) throw new ProbeError('Movie header is malformed');

  const tracks: Track[] = [];
  let fragmented = layout.fragmented;
  for (const box of children(bytes, moov)) {
    if (box.type === 'mvex') fragmented = true;
    if (box.type !== 'trak') continue;
    const track = parseTrack(bytes, box);
    if (track) tracks.push(track);
  }

  const video = tracks.find((t) => t.handler === 'vide');
  const audio = tracks.find((t) => t.handler === 'soun');
  const probe: VideoProbe = {
    ...layout,
    fragmented,
    videoCodec: video?.codec ?? null,
    codecFamily: video?.codec ? (CODEC_FAMILIES[video.codec] ?? 'other') : null,
    width: (video && (video.rotation % 180 === 0 ? video.width : video.height)) ?? null,
    height: (video && (video.rotation % 180 === 0 ? video.height : video.width)) ?? null,
    rotation: video?.rotation ?? 0,
    durationSec: null,
    fps: null,
    variableFrameRate: false,
    audioCodec: audio?.codec ?? null,
  };
  if (!video || video.timescale === 0) return probe;

  const duration = video.duration > 0 && video.duration !== 0xffffffff ? video.duration : video.totalDelta;
  probe.durationSec = duration > 0 ? round(duration / video.timescale) : null;
  if (video.sampleCount > 0 && video.totalDelta > 0) {
    // Tolerate an odd last sample, which many muxers write with a different duration.
    probe.variableFrameRate = video.dominantCount / video.sampleCount < 0.99;
    probe.fps = probe.variableFrameRate
      ? round((video.sampleCount * video.timescale) / video.totalDelta)
      : round(video.timescale / video.dominantDelta);
  }
  return probe;
}

function parseTrack(bytes: Uint8Array, trak: Box): Track | null {
  const view = dataView(bytes);
  const mdia = child(bytes, trak, 'mdia');
  const hdlr = mdia && child(bytes, mdia, 'hdlr');
  const mdhd = mdia && child(bytes, mdia, 'mdhd');
  if (!mdia || !hdlr || !mdhd) return null;

  // hdlr: version/flags(4) pre_defined(4) handler_type(4)
  const handler = fourcc(bytes, hdlr.start + hdlr.headerSize + 8);

  // mdhd v0: version/flags(4) created(4) modified(4) timescale(4) duration(4); v1 uses 8-byte times.
  const m = mdhd.start + mdhd.headerSize;
  const v1 = bytes[m] === 1;
  const timescale = view.getUint32(m + (v1 ? 20 : 12));
  const duration = v1 ? Number(view.getBigUint64(m + 24)) : view.getUint32(m + 16);

  const track: Track = {
    handler,
    codec: null,
    rotation: readRotation(bytes, trak),
    timescale,
    duration,
    width: null,
    height: null,
    sampleCount: 0,
    totalDelta: 0,
    dominantDelta: 0,
    dominantCount: 0,
  };

  const minf = child(bytes, mdia, 'minf');
  const stbl = minf && child(bytes, minf, 'stbl');
  if (!stbl) return track;

  const stsd = child(bytes, stbl, 'stsd');
  if (stsd) {
    // stsd: version/flags(4) entry_count(4), then sample entries.
    const entry = stsd.start + stsd.headerSize + 8;
    if (entry + 8 <= stsd.end) {
      track.codec = fourcc(bytes, entry + 4);
      // VisualSampleEntry: header(8) reserved(6) data_ref(2) pre_defined/reserved(16) width(2) height(2)
      if (handler === 'vide' && entry + 36 <= stsd.end) {
        track.width = view.getUint16(entry + 32);
        track.height = view.getUint16(entry + 34);
      }
    }
  }

  const stts = child(bytes, stbl, 'stts');
  if (stts) {
    // stts: version/flags(4) entry_count(4), then (sample_count, sample_delta) pairs.
    const s = stts.start + stts.headerSize;
    const entries = Math.min(view.getUint32(s + 4), Math.floor((stts.end - s - 8) / 8));
    const countsByDelta = new Map<number, number>();
    for (let i = 0; i < entries; i++) {
      const count = view.getUint32(s + 8 + i * 8);
      const delta = view.getUint32(s + 12 + i * 8);
      track.sampleCount += count;
      track.totalDelta += count * delta;
      countsByDelta.set(delta, (countsByDelta.get(delta) ?? 0) + count);
    }
    for (const [delta, count] of countsByDelta) {
      if (count > track.dominantCount) {
        track.dominantDelta = delta;
        track.dominantCount = count;
      }
    }
  }
  return track;
}

/**
 * Display rotation from the track header's transformation matrix (a b u / c d v / x y w, 16.16
 * fixed point). Phones store portrait video as landscape with a 90° matrix.
 */
function readRotation(bytes: Uint8Array, trak: Box): Track['rotation'] {
  const tkhd = child(bytes, trak, 'tkhd');
  if (!tkhd) return 0;
  const p = tkhd.start + tkhd.headerSize;
  // version/flags(4), then times/ids/duration: 20 bytes (v0) or 32 (v1), then 16 reserved/layer/volume bytes.
  const matrix = p + 4 + (bytes[p] === 1 ? 32 : 20) + 16;
  if (matrix + 16 > tkhd.end) return 0;
  const view = dataView(bytes);
  const a = view.getInt32(matrix) / 65536;
  const b = view.getInt32(matrix + 4) / 65536;
  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return (((degrees % 360) + 360) % 360) as Track['rotation'];
}

/** Parses the box header at `at`; `end` bounds the parent and resolves size 0 ("to end"). */
function parseHeader(bytes: Uint8Array, at: number, end: number): Box | null {
  if (end - at < 8 || bytes.length - at < 8) return null;
  const view = dataView(bytes);
  let size = view.getUint32(at);
  let headerSize = 8;
  if (size === 1) {
    if (bytes.length - at < 16) return null;
    size = Number(view.getBigUint64(at + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < headerSize || at + size > end) return null;
  return { type: fourcc(bytes, at + 4), start: at, headerSize, end: at + size };
}

function* children(bytes: Uint8Array, parent: Box): Generator<Box> {
  for (let at = parent.start + parent.headerSize; at < parent.end; ) {
    const box = parseHeader(bytes, at, parent.end);
    if (!box) return;
    yield box;
    at = box.end;
  }
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  for (const box of children(bytes, parent)) if (box.type === type) return box;
  return null;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
