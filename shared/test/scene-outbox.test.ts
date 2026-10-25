import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyAnnotation } from '../annotation.ts';
import { enqueue, sceneView, type OutboxOp } from '../scene-outbox.ts';
import type { SceneDto } from '../types.ts';

let seq = 0;
const fields = { startSec: 10, endSec: 20, eventTypeKey: null, comment: null };
const create = (ref: string, videoId = 'v1'): OutboxOp => ({
  kind: 'create',
  seq: ++seq,
  ref,
  videoId,
  createdBy: 'u1',
  createdAt: '2026-10-23T10:00:00.000Z',
  fields,
});
const update = (ref: string, patch: Record<string, unknown>): OutboxOp => ({ kind: 'update', seq: ++seq, ref, videoId: 'v1', patch });
const remove = (ref: string): OutboxOp => ({ kind: 'delete', seq: ++seq, ref, videoId: 'v1' });

const serverScene = (id: string, startSec: number): SceneDto => ({
  id,
  sessionId: 's1',
  videoId: 'v1',
  startSec,
  endSec: startSec + 10,
  eventTypeKey: null,
  profileId: null,
  profileVersion: null,
  comment: null,
  status: 'unreviewed',
  clientId: null,
  createdBy: 'u2',
  createdAt: '2026-10-23T09:00:00.000Z',
  marker: false,
  athleteId: null,
  annotation: emptyAnnotation(),
  duplicateOf: null,
  reviewedBy: null,
  reviewedAt: null,
  updatedAt: null,
});

test('edits of an unsent mark are folded into the mark', () => {
  let ops = enqueue([], create('a'));
  ops = enqueue(ops, update('a', { eventTypeKey: 'save' }));
  ops = enqueue(ops, update('a', { comment: 'glove' }));
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].kind === 'create' && ops[0].fields, { ...fields, eventTypeKey: 'save', comment: 'glove' });
});

test('deleting an unsent mark removes it without a server request', () => {
  let ops = enqueue([], create('a'));
  ops = enqueue(ops, update('a', { comment: 'x' }));
  ops = enqueue(ops, remove('a'));
  assert.deepEqual(ops, []);
});

test('the op being sent is never folded into', () => {
  const first = create('a');
  let ops = enqueue([], first);
  ops = enqueue(ops, update('a', { eventTypeKey: 'save' }), first.seq);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].kind, 'update');

  const deleted = enqueue([first], remove('a'), first.seq);
  assert.deepEqual(
    deleted.map((o) => o.kind),
    ['create', 'delete'],
  );
});

test('edits of server scenes are merged into one update', () => {
  let ops = enqueue([], update('s1', { eventTypeKey: 'goal' }));
  ops = enqueue(ops, update('s1', { comment: 'late' }));
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].kind === 'update' && ops[0].patch, { eventTypeKey: 'goal', comment: 'late' });
});

test('the view applies pending ops to server scenes and sorts by time', () => {
  const ops = [create('new'), update('s2', { eventTypeKey: 'save' }), remove('s3'), create('other-video', 'v2')];
  const view = sceneView([serverScene('s2', 50), serverScene('s3', 70)], ops, 'v1');
  assert.deepEqual(
    view.map((s) => [s.ref, s.startSec, s.eventTypeKey, s.pending]),
    [
      ['new', 10, null, true],
      ['s2', 50, 'save', true],
    ],
  );
});

test('a mark confirmed by the server but still in the outbox is shown once', () => {
  const confirmed = { ...serverScene('server-id', 10), clientId: 'a' };
  const view = sceneView([confirmed], [create('a')], 'v1');
  assert.equal(view.length, 1);
  assert.equal(view[0].ref, 'a');
});
