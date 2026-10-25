import { useSyncExternalStore } from 'react';
import { uploads, type UploadSnapshot } from './queue.ts';

export function useUploads(): UploadSnapshot {
  return useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
}
