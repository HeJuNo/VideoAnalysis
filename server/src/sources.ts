// Where a video's bytes come from. Playback goes through this registry, so an external platform
// can be added as another source without touching the player or the routes.
import type { VideoSourceKind } from '../../shared/types.ts';
import type { VideoRow } from './repo.ts';
import type { ObjectStorage } from './storage.ts';

export interface VideoSource {
  kind: VideoSourceKind;
  /** A URL the browser's <video> element can play with HTTP range requests. */
  playbackUrl(video: VideoRow, expiresInSec: number): Promise<string>;
}

export function createVideoSources(storage: ObjectStorage): Record<VideoSourceKind, VideoSource> {
  return {
    upload: {
      kind: 'upload',
      playbackUrl: (video, expiresInSec) => storage.presignGet(video.storage_key, expiresInSec),
    },
  };
}
