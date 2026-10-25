import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PARTS, MIB, MIN_PART_SIZE, partRange, planParts } from '../upload-plan.ts';

test('small files are a single part', () => {
  assert.deepEqual(planParts(1), { partSize: MIN_PART_SIZE, partCount: 1 });
  assert.deepEqual(planParts(MIN_PART_SIZE), { partSize: MIN_PART_SIZE, partCount: 1 });
});

test('a 4 GB match uses 16 MiB parts', () => {
  const plan = planParts(4_000_000_000);
  assert.equal(plan.partSize, 16 * MIB);
  assert.equal(plan.partCount, 239);
});

test('huge files grow the part size to stay within the part limit', () => {
  const size = 200 * 1024 * MIB;
  const plan = planParts(size);
  assert.ok(plan.partCount <= MAX_PARTS);
  assert.equal(plan.partSize % MIB, 0);
  assert.ok(plan.partSize * plan.partCount >= size);
});

test('rejects empty or invalid sizes', () => {
  assert.throws(() => planParts(0), RangeError);
  assert.throws(() => planParts(1.5), RangeError);
});

test('partRange covers the file exactly', () => {
  const size = 40 * MIB + 7;
  const { partSize, partCount } = planParts(size);
  assert.deepEqual(partRange(1, partSize, size), { start: 0, end: partSize });
  assert.deepEqual(partRange(partCount, partSize, size), { start: 2 * partSize, end: size });
});
