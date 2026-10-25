// Resumable direct-to-storage uploads. Files are sent one at a time, each in parallel parts
// straight to the bucket via presigned URLs; the API never sees the video bytes.
//
// Survives: network drops (waits for `online`, retries with backoff), expired part URLs
// (re-signs), pause/resume, and page reloads (picking the same file again resumes it,
// because the API matches it by name, size and modification time).
import { fileReader, probeMp4, type VideoProbe } from '../../../shared/mp4-probe.ts';
import type { CreateUploadResponse } from '../../../shared/types.ts';
import { partRange } from '../../../shared/upload-plan.ts';
import { api, ApiError, errorMessage } from '../api.ts';

export type UploadStatus = 'queued' | 'probing' | 'uploading' | 'paused' | 'completing' | 'done' | 'error';

export interface UploadItem {
  id: string;
  sessionId: string;
  videoId: string | null;
  fileName: string;
  size: number;
  status: UploadStatus;
  probe: VideoProbe | null;
  probeError: string | null;
  bytesUploaded: number;
  speedBps: number | null;
  etaSec: number | null;
  error: string | null;
  resumed: boolean;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  /** Increments whenever an upload finishes, so pages know to reload their video lists. */
  completed: number;
}

const PART_CONCURRENCY = 4;
const URL_BATCH = 20;
const URL_MAX_AGE_MS = 45 * 60_000; // the API signs part URLs for 60 minutes
const MAX_ATTEMPTS = 6;
const EMIT_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 5_000;
const DONE_VISIBLE_MS = 3_000;
const ACTIVE: readonly UploadStatus[] = ['queued', 'probing', 'uploading', 'completing'];

interface Job {
  item: UploadItem;
  file: File;
  probed: boolean;
  controller: AbortController | null;
  samples: { at: number; bytes: number }[];
}

class PartError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

class UploadQueue {
  private jobs: Job[] = [];
  private listeners = new Set<() => void>();
  private snapshot: UploadSnapshot = { items: [], completed: 0 };
  private completed = 0;
  private running = false;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadSnapshot => this.snapshot;

  hasActiveUploads(): boolean {
    return this.jobs.some((job) => ACTIVE.includes(job.item.status));
  }

  add(sessionId: string, files: File[]): void {
    for (const file of files) {
      this.jobs.push({
        file,
        probed: false,
        controller: null,
        samples: [],
        item: {
          id: crypto.randomUUID(),
          sessionId,
          videoId: null,
          fileName: file.name,
          size: file.size,
          status: 'queued',
          probe: null,
          probeError: null,
          bytesUploaded: 0,
          speedBps: null,
          etaSec: null,
          error: null,
          resumed: false,
        },
      });
    }
    this.emit();
    void this.pump();
  }

  pause(id: string): void {
    const job = this.find(id);
    if (!job || !['queued', 'probing', 'uploading'].includes(job.item.status)) return;
    this.update(job.item, { status: 'paused', speedBps: null, etaSec: null });
    job.controller?.abort();
  }

  resume(id: string): void {
    const job = this.find(id);
    if (!job || (job.item.status !== 'paused' && job.item.status !== 'error')) return;
    this.update(job.item, { status: 'queued', error: null });
    void this.pump();
  }

  /** Stops the upload and discards the parts already in storage. */
  async cancel(id: string): Promise<void> {
    const job = this.find(id);
    if (!job) return;
    this.jobs = this.jobs.filter((j) => j !== job);
    job.controller?.abort();
    this.emit();
    if (job.item.videoId && job.item.status !== 'done') {
      await api(`/uploads/${job.item.videoId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  dismiss(id: string): void {
    this.jobs = this.jobs.filter((job) => job.item.id !== id);
    this.emit();
  }

  private find(id: string): Job | undefined {
    return this.jobs.find((job) => job.item.id === id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Refreshes speed and ETA even when no progress events arrive (e.g. a stalled connection).
    const ticker = setInterval(() => this.emit(), 1000);
    try {
      for (let job = this.nextQueued(); job; job = this.nextQueued()) await this.run(job);
    } finally {
      clearInterval(ticker);
      this.running = false;
    }
  }

  private nextQueued(): Job | undefined {
    return this.jobs.find((job) => job.item.status === 'queued');
  }

  private async run(job: Job): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    const { item, file } = job;
    job.controller = controller;
    try {
      if (!job.probed) {
        this.update(item, { status: 'probing' });
        try {
          item.probe = await probeMp4(fileReader(file), file.size);
        } catch (err) {
          item.probeError = errorMessage(err);
        }
        job.probed = true;
        signal.throwIfAborted();
      }

      this.update(item, { status: 'uploading', error: null });
      const plan = await api<CreateUploadResponse>(`/sessions/${item.sessionId}/uploads`, {
        body: {
          name: file.name,
          size: file.size,
          contentType: file.type || null,
          fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
          probe: item.probe,
        },
        signal,
      });
      this.update(item, { videoId: plan.video.id, resumed: plan.resumed });

      const etags = await this.uploadParts(job, plan, signal);

      this.update(item, { status: 'completing', speedBps: null, etaSec: null });
      const parts = [...etags].map(([partNumber, etag]) => ({ partNumber, etag }));
      await api(`/uploads/${plan.video.id}/complete`, { body: { parts }, signal });
      this.completed++;
      this.update(item, { status: 'done', bytesUploaded: file.size });
      // The video now shows in the session's list; the finished upload row only needs a moment.
      setTimeout(() => {
        if (item.status === 'done') this.dismiss(item.id);
      }, DONE_VISIBLE_MS);
    } catch (err) {
      if (signal.aborted) return; // paused or cancelled; status is already set
      this.update(item, { status: 'error', error: errorMessage(err), speedBps: null, etaSec: null });
    } finally {
      job.controller = null;
    }
  }

  /** Uploads the parts not yet in storage; resolves with the ETag of every part. */
  private async uploadParts(job: Job, plan: CreateUploadResponse, signal: AbortSignal): Promise<Map<number, string>> {
    const { item, file } = job;
    const etags = new Map(plan.completedParts.map((p) => [p.partNumber, p.etag]));
    const pending: number[] = [];
    for (let n = 1; n <= plan.partCount; n++) if (!etags.has(n)) pending.push(n);

    let confirmedBytes = plan.completedParts.reduce((sum, p) => sum + p.size, 0);
    const inflight = new Map<number, number>();
    const reportProgress = () => {
      let bytes = confirmedBytes;
      for (const loaded of inflight.values()) bytes += loaded;
      item.bytesUploaded = bytes;
      this.scheduleEmit();
    };
    job.samples = [];
    reportProgress();

    // Lets one permanently failed part stop its sibling workers.
    const local = new AbortController();
    const forwardAbort = () => local.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });

    const urls = new Map<number, { url: string; at: number }>();
    let urlRequest: Promise<void> | null = null;
    const urlFor = async (partNumber: number): Promise<string> => {
      for (;;) {
        const cached = urls.get(partNumber);
        if (cached && Date.now() - cached.at < URL_MAX_AGE_MS) return cached.url;
        if (!urlRequest) {
          const from = pending.indexOf(partNumber);
          const batch = pending.slice(from, from + URL_BATCH).filter((n) => n === partNumber || !etags.has(n));
          urlRequest = api<{ urls: { partNumber: number; url: string }[] }>(`/uploads/${item.videoId}/part-urls`, {
            body: { partNumbers: batch },
            signal: local.signal,
          })
            .then((res) => {
              const at = Date.now();
              for (const u of res.urls) urls.set(u.partNumber, { url: u.url, at });
            })
            .finally(() => {
              urlRequest = null;
            });
        }
        await urlRequest;
      }
    };

    const sendPart = async (partNumber: number, body: Blob): Promise<string> => {
      for (let attempt = 1; ; attempt++) {
        local.signal.throwIfAborted();
        if (!navigator.onLine) await waitForOnline(local.signal);
        try {
          // Inside the try: a briefly unreachable API (e.g. a server restart) is retried like
          // a network error instead of failing the upload.
          const url = await urlFor(partNumber);
          return await putPart(url, body, local.signal, (loaded) => {
            inflight.set(partNumber, loaded);
            reportProgress();
          });
        } catch (err) {
          inflight.delete(partNumber);
          reportProgress();
          if (local.signal.aborted) throw err;
          const status = err instanceof PartError || err instanceof ApiError ? err.status : 0;
          if (err instanceof PartError && status === 403) urls.delete(partNumber); // expired or invalid signature: re-sign
          else if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw err;
          if (attempt >= MAX_ATTEMPTS) throw err;
          await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)), local.signal);
        }
      }
    };

    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const partNumber = pending[next++];
        const { start, end } = partRange(partNumber, plan.partSize, file.size);
        const etag = await sendPart(partNumber, file.slice(start, end));
        etags.set(partNumber, etag);
        inflight.delete(partNumber);
        confirmedBytes += end - start;
        reportProgress();
      }
    };

    try {
      const workers = Array.from({ length: Math.min(PART_CONCURRENCY, pending.length) }, () =>
        worker().catch((err: unknown) => {
          local.abort(err);
          throw err;
        }),
      );
      await Promise.all(workers);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
    return etags;
  }

  private update(item: UploadItem, patch: Partial<UploadItem>): void {
    Object.assign(item, patch);
    this.emit();
  }

  private scheduleEmit(): void {
    this.emitTimer ??= setTimeout(() => this.emit(), EMIT_INTERVAL_MS);
  }

  private emit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const now = performance.now();
    for (const job of this.jobs) {
      const { item } = job;
      if (item.status !== 'uploading') continue;
      job.samples.push({ at: now, bytes: item.bytesUploaded });
      while (job.samples.length > 2 && now - job.samples[0].at > SPEED_WINDOW_MS) job.samples.shift();
      const first = job.samples[0];
      const seconds = (now - first.at) / 1000;
      if (seconds >= 1) {
        item.speedBps = Math.max(0, (item.bytesUploaded - first.bytes) / seconds);
        item.etaSec = item.speedBps > 0 ? (item.size - item.bytesUploaded) / item.speedBps : null;
      }
    }
    this.snapshot = { items: this.jobs.map((job) => ({ ...job.item })), completed: this.completed };
    this.listeners.forEach((listener) => listener());
  }
}

function putPart(url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = () => signal.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      settle();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new PartError(`Storage answered HTTP ${xhr.status}`, xhr.status));
        return;
      }
      const etag = xhr.getResponseHeader('ETag');
      if (etag) resolve(etag);
      else reject(new PartError('Storage hides the ETag header: add "ETag" to ExposeHeaders in the bucket CORS policy', 400));
    };
    xhr.onerror = () => {
      settle();
      reject(new PartError('Network error: connection lost, or the bucket CORS policy does not allow this site', 0));
    };
    xhr.onabort = () => {
      settle();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function waitForOnline(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    function online() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      window.removeEventListener('online', online);
      reject(signal.reason);
    }
    window.addEventListener('online', online, { once: true });
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export const uploads = new UploadQueue();

window.addEventListener('beforeunload', (event) => {
  if (uploads.hasActiveUploads()) event.preventDefault();
});
