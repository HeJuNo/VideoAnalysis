// Shapes exchanged between the API and the web app.
import type { SceneAnnotation } from './annotation.ts';
import type { CatchHand } from './goal-zones.ts';
import type { VideoProbe } from './mp4-probe.ts';
import type { ProfileDefinition } from './profile.ts';

export type Role = 'tagger' | 'analyst';
export type SessionType = 'match' | 'training';
export type VideoStatus = 'uploading' | 'ready' | 'failed' | 'deleted';
export type Rotation = 0 | 90 | 180 | 270;

/** Non-destructive edits, applied at playback. The stored file is never changed. */
export interface VideoEdits {
  /** Clockwise, in degrees. */
  rotation: Rotation;
  /** Playable range within the file; null means from the beginning / to the end. */
  trimStartSec: number | null;
  trimEndSec: number | null;
}

export interface UserDto {
  id: string;
  email: string;
  role: Role;
}

export interface SessionDto {
  id: string;
  type: SessionType;
  title: string;
  date: string | null;
  createdAt: string;
  videoCount: number;
  totalBytes: number;
  sportProfileId: string | null;
  sportProfileName: string | null;
  team: string | null;
  athletes: AthleteDto[];
}

export interface AthleteDto {
  id: string;
  name: string;
  /** Catching (goalies) or dominant hand; null when not set. */
  catchHand: CatchHand | null;
}

/** Athlete with how often it is used; only unused athletes can be deleted. */
export interface AthleteUsageDto extends AthleteDto {
  sessionCount: number;
  sceneCount: number;
}

/** Where a video's bytes come from. Only uploads exist today; external platforms may follow. */
export type VideoSourceKind = 'upload';

export interface VideoDto extends VideoEdits {
  id: string;
  sessionId: string;
  partIndex: number;
  source: VideoSourceKind;
  sceneCount: number;
  /** Shown in the app; starts as the uploaded file's name and can be renamed. */
  name: string;
  sizeBytes: number;
  status: VideoStatus;
  probe: VideoProbe | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SessionDetailDto extends SessionDto {
  videos: VideoDto[];
}

/** A video object found in storage with no matching database row (e.g. after a database reset). */
export interface OrphanedVideoDto {
  storageKey: string;
  sizeBytes: number;
}

/** Orphaned videos that shared a session when they were originally uploaded. */
export interface OrphanedGroupDto {
  /** The session id they were originally stored under; that session no longer exists. */
  sourceSessionId: string;
  videos: OrphanedVideoDto[];
  totalBytes: number;
}

/** Whether the database and object storage are reachable right now. */
export interface HealthDto {
  ok: boolean;
  database: { ok: boolean };
  storage: { ok: boolean };
  /** Whether the bucket's CORS policy allows browser uploads from this app's origin. Informational
   * only — doesn't affect `ok` above, since it's a storage-provider setting, not something a
   * restart fixes. */
  /** Checks an actual CORS preflight, not just the bucket's stated policy — see storage.ts. */
  cors: { ok: boolean; reason: string | null };
  /** Same reasoning as `cors` above: informational only, doesn't affect `ok`. A skewed clock makes
   * presigned upload URLs expire early or immediately, which looks like a CORS/network error. */
  clockSkew: { ok: boolean; skewSeconds: number | null; reason: string | null };
  /** When the running image was built; "dev" when running outside Docker. */
  build: { builtAt: string };
  checkedAt: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CreateUploadResponse {
  video: VideoDto;
  partSize: number;
  partCount: number;
  /** Parts already in storage, when an interrupted upload of the same file is resumed. */
  completedParts: UploadedPart[];
  resumed: boolean;
}

export interface PlaybackDto {
  url: string;
  expiresAt: string;
}

export interface ProfileSummaryDto {
  id: string;
  name: string;
  sport: string;
  currentVersion: number;
  archivedAt: string | null;
  updatedAt: string;
  sessionCount: number;
}

export interface ProfileDto extends ProfileSummaryDto {
  /** The definition of `version` (the current one unless an older version was requested). */
  version: number;
  definition: ProfileDefinition;
}

export interface AssetDto {
  id: string;
  contentType: string;
  width: number;
  height: number;
  /** Same-origin URL that redirects to a short-lived signed URL. */
  url: string;
}

export type SceneStatus = 'unreviewed' | 'reviewed' | 'rejected' | 'duplicate';

export interface SceneDto {
  id: string;
  sessionId: string;
  videoId: string;
  startSec: number;
  endSec: number;
  eventTypeKey: string | null;
  profileId: string | null;
  profileVersion: number | null;
  comment: string | null;
  status: SceneStatus;
  /** Set when the browser created the scene (tagger marks); usable instead of `id`. */
  clientId: string | null;
  createdBy: string | null;
  createdAt: string;
  /** A point in time (moment, period start/end) rather than a range; never reviewed. */
  marker: boolean;
  athleteId: string | null;
  annotation: SceneAnnotation;
  /** Set when status is "duplicate": the scene this one repeats. */
  duplicateOf: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  updatedAt: string | null;
}

export interface SceneEventDto {
  id: number;
  action: 'created' | 'updated' | 'reviewed';
  userEmail: string | null;
  /** Changed fields with their old and new values (the annotation is only listed by key). */
  changes: Record<string, { from: unknown; to: unknown }>;
  at: string;
}

export interface SceneDetailDto {
  scene: SceneDto;
  video: VideoDto;
  session: SessionDto;
  events: SceneEventDto[];
  /** Emails of the users named in the scene and its events. */
  users: Record<string, string>;
}

export interface ReviewQueueItemDto {
  scene: SceneDto;
  /** Label of the scene's event type in the profile version it was recorded with. */
  eventTypeLabel: string | null;
  sessionTitle: string;
  sessionDate: string | null;
  videoName: string;
  videoPartIndex: number;
}
