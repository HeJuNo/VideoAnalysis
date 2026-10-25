// Sends the scene outbox to the API in order. The outbox lives in localStorage, so marks made
// offline survive reloads; sending retries with backoff and resumes when the browser is online.
import { enqueue, type OutboxOp } from '../../../shared/scene-outbox.ts';
import type { SceneDto } from '../../../shared/types.ts';
import { api, ApiError, errorMessage } from '../api.ts';

const STORAGE_KEY = 'sva.sceneOutbox.v1';
const MAX_BACKOFF_MS = 30_000;

export type SyncState = 'idle' | 'syncing' | 'waiting' | 'signed-out';

export interface SyncSnapshot {
  ops: readonly OutboxOp[];
  state: SyncState;
  /** A change the server refused (e.g. a scene was reviewed meanwhile); shown once to the user. */
  rejected: string | null;
  /** Server copies of scenes confirmed since the page loaded its scene list. */
  confirmed: ReadonlyMap<string, SceneDto>;
  deleted: ReadonlySet<string>;
}

// Omit over each member of the union, so callers still get the right fields per `kind`.
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;
type NewOp = WithoutSeq<OutboxOp>;

function loadOps(): OutboxOp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OutboxOp[]) : [];
  } catch {
    return [];
  }
}

class SceneSync {
  private ops = loadOps();
  private seq = this.ops.reduce((max, op) => Math.max(max, op.seq), 0);
  private inFlight: number | null = null;
  private state: SyncState = 'idle';
  private rejected: string | null = null;
  private confirmed = new Map<string, SceneDto>();
  private deleted = new Set<string>();
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SyncSnapshot = this.buildSnapshot();

  constructor() {
    window.addEventListener('online', () => this.flushNow());
    void this.flush();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  add(op: NewOp): void {
    this.ops = enqueue(this.ops, { ...op, seq: ++this.seq } as OutboxOp, this.inFlight);
    this.persist();
    this.emit();
    void this.flush();
  }

  dismissRejected(): void {
    this.rejected = null;
    this.emit();
  }

  /** Called after the page reloaded its scene list from the server. */
  forgetConfirmed(): void {
    this.confirmed.clear();
    this.deleted.clear();
    this.emit();
  }

  private flushNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = 1000;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inFlight !== null || this.retryTimer) return;
    while (this.ops.length > 0) {
      const op = this.ops[0];
      this.inFlight = op.seq;
      this.setState('syncing');
      try {
        await this.send(op);
        this.drop(op);
        this.backoff = 1000;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Keep everything; it is sent once the user signs in again.
          this.setState('signed-out');
          this.scheduleRetry();
          return;
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          // The server refused this change; retrying will not help. A missing scene is fine to skip.
          if (!(err.status === 404 && op.kind !== 'create')) this.rejected = `A change was not saved: ${errorMessage(err)}`;
          this.drop(op);
          continue;
        }
        this.setState('waiting');
        this.scheduleRetry();
        return;
      } finally {
        this.inFlight = null;
      }
    }
    this.setState('idle');
  }

  private async send(op: OutboxOp): Promise<void> {
    if (op.kind === 'create') {
      const { scene } = await api<{ scene: SceneDto }>('/scenes', {
        body: { videoId: op.videoId, ...op.fields, clientId: op.ref },
      });
      this.confirmed.set(op.ref, scene);
    } else if (op.kind === 'update') {
      const { scene } = await api<{ scene: SceneDto }>(`/scenes/${op.ref}`, { method: 'PATCH', body: op.patch });
      this.confirmed.set(op.ref, scene);
    } else {
      await api(`/scenes/${op.ref}`, { method: 'DELETE' });
      this.confirmed.delete(op.ref);
      this.deleted.add(op.ref);
    }
  }

  private drop(op: OutboxOp): void {
    this.ops = this.ops.filter((o) => o.seq !== op.seq);
    this.persist();
    this.emit();
  }

  private scheduleRetry(): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, this.backoff);
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
  }

  private setState(state: SyncState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.ops));
    } catch {
      // Storage full or blocked: marks are still kept in memory for this page.
    }
  }

  private buildSnapshot(): SyncSnapshot {
    return {
      ops: [...this.ops],
      state: this.state,
      rejected: this.rejected,
      confirmed: new Map(this.confirmed),
      deleted: new Set(this.deleted),
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((listener) => listener());
  }
}

export const sceneSync = new SceneSync();

window.addEventListener('beforeunload', (event) => {
  // Unsent marks are kept in localStorage, but the user should know they are not on the server yet.
  if (sceneSync.getSnapshot().ops.length > 0 && !navigator.onLine) event.preventDefault();
});
