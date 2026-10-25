// Offline-safe scene editing for taggers. Every change is first recorded as an operation in an
// outbox (persisted in the browser) and sent to the API in order. The UI shows the server's scenes
// with the pending operations applied, so marks appear instantly and survive network drops and
// page reloads.
//
// A scene is addressed by its `ref`: the clientId generated in the browser for scenes created
// here, otherwise the server id. The API accepts either.
import type { SceneDto, SceneStatus } from './types.ts';

export interface SceneFields {
  startSec: number;
  endSec: number;
  eventTypeKey: string | null;
  comment: string | null;
}

interface OpBase {
  /** Increasing number; the op being sent is never folded into, so no change is lost. */
  seq: number;
  ref: string;
  videoId: string;
}

export type OutboxOp =
  | (OpBase & { kind: 'create'; createdBy: string; createdAt: string; fields: SceneFields })
  | (OpBase & { kind: 'update'; patch: Partial<SceneFields> })
  | (OpBase & { kind: 'delete' });

export interface LocalScene extends SceneFields {
  ref: string;
  videoId: string;
  status: SceneStatus;
  createdBy: string | null;
  createdAt: string;
  /** Not yet confirmed by the server. */
  pending: boolean;
}

export const sceneRef = (scene: Pick<SceneDto, 'id' | 'clientId'>) => scene.clientId ?? scene.id;

/**
 * Adds an operation, folding it into earlier pending operations for the same scene where
 * possible: an edit of an unsent mark changes the mark itself, and deleting an unsent mark
 * removes it without ever contacting the server. `inFlightSeq` is the op currently being sent.
 */
export function enqueue(ops: OutboxOp[], op: OutboxOp, inFlightSeq: number | null = null): OutboxOp[] {
  const foldable = (o: OutboxOp) => o.ref === op.ref && o.seq !== inFlightSeq;

  if (op.kind === 'update') {
    const index = ops.findIndex((o) => foldable(o) && (o.kind === 'create' || o.kind === 'update'));
    if (index >= 0) {
      const target = ops[index];
      const merged: OutboxOp =
        target.kind === 'create'
          ? { ...target, fields: { ...target.fields, ...op.patch } }
          : target.kind === 'update'
            ? { ...target, patch: { ...target.patch, ...op.patch } }
            : target;
      return ops.map((o, i) => (i === index ? merged : o));
    }
    return [...ops, op];
  }

  if (op.kind === 'delete') {
    const unsentCreate = ops.some((o) => foldable(o) && o.kind === 'create');
    const rest = ops.filter((o) => !foldable(o));
    // An unsent mark simply disappears; one that is being sent still needs the delete afterwards.
    const createInFlight = ops.some((o) => o.ref === op.ref && o.kind === 'create' && o.seq === inFlightSeq);
    return unsentCreate && !createInFlight ? rest : [...rest, op];
  }

  return [...ops, op];
}

/**
 * The scenes of one video as the user should see them: confirmed server state with the pending
 * operations applied, sorted by start time.
 */
export function sceneView(server: SceneDto[], ops: OutboxOp[], videoId: string): LocalScene[] {
  const scenes = new Map<string, LocalScene>();
  for (const s of server) {
    if (s.videoId !== videoId) continue;
    scenes.set(sceneRef(s), {
      ref: sceneRef(s),
      videoId: s.videoId,
      startSec: s.startSec,
      endSec: s.endSec,
      eventTypeKey: s.eventTypeKey,
      comment: s.comment,
      status: s.status,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      pending: false,
    });
  }
  for (const op of ops) {
    if (op.videoId !== videoId) continue;
    if (op.kind === 'create') {
      const existing = scenes.get(op.ref);
      scenes.set(op.ref, {
        ref: op.ref,
        videoId,
        ...op.fields,
        status: existing?.status ?? 'unreviewed',
        createdBy: op.createdBy,
        createdAt: op.createdAt,
        pending: true,
      });
    } else if (op.kind === 'update') {
      const existing = scenes.get(op.ref);
      if (existing) scenes.set(op.ref, { ...existing, ...op.patch, pending: true });
    } else {
      scenes.delete(op.ref);
    }
  }
  return [...scenes.values()].sort((a, b) => a.startSec - b.startSec);
}
