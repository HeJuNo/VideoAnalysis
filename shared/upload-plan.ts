export const MIB = 1024 * 1024;
export const MIN_PART_SIZE = 16 * MIB;
export const MAX_PARTS = 10_000;

export interface PartPlan {
  partSize: number;
  partCount: number;
}

/**
 * S3-compatible multipart uploads need parts of at least 5 MiB, at most 10,000 parts, and
 * (on R2) all parts except the last of equal size. A 4 GB match becomes ~240 parts of 16 MiB.
 */
export function planParts(size: number): PartPlan {
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('File size must be a positive integer');
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MIB) * MIB);
  return { partSize, partCount: Math.ceil(size / partSize) };
}

/** Byte range [start, end) of a 1-based part number. */
export function partRange(partNumber: number, partSize: number, size: number): { start: number; end: number } {
  const start = (partNumber - 1) * partSize;
  return { start, end: Math.min(start + partSize, size) };
}
