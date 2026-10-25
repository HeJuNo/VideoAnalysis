// Row shapes and row-to-DTO mapping for the tables the routes share.
import { normalizeAnnotation, type SceneAnnotation } from '../../shared/annotation.ts';
import type { VideoProbe } from '../../shared/mp4-probe.ts';
import type {
  AthleteDto,
  Rotation,
  SceneDto,
  SceneStatus,
  SessionDto,
  SessionType,
  VideoDto,
  VideoSourceKind,
  VideoStatus,
} from '../../shared/types.ts';
import type { Db } from './db.ts';

export interface VideoRow {
  id: string;
  session_id: string;
  part_index: number;
  source: VideoSourceKind;
  storage_key: string;
  /** The name shown in the app (renamable); starts as the uploaded file's name. */
  original_name: string;
  size_bytes: number;
  content_type: string | null;
  status: VideoStatus;
  upload_id: string | null;
  part_size: number | null;
  part_count: number | null;
  fingerprint: string | null;
  probe: string | null;
  uploaded_by: string | null;
  created_at: string;
  completed_at: string | null;
  rotation: Rotation;
  trim_start_sec: number | null;
  trim_end_sec: number | null;
  scene_count: number;
}

export interface SessionRow {
  id: string;
  type: SessionType;
  title: string;
  date: string | null;
  created_at: string;
  video_count: number;
  total_bytes: number;
  sport_profile_id: string | null;
  sport_profile_name: string | null;
  team: string | null;
  /** JSON array of AthleteDto, in session order. */
  athletes: string;
}

export interface SceneRow {
  id: string;
  session_id: string;
  video_file_id: string;
  start_sec: number;
  end_sec: number;
  event_type_key: string | null;
  profile_id: string | null;
  profile_version: number | null;
  comment: string | null;
  status: SceneStatus;
  client_id: string | null;
  created_by: string | null;
  created_at: string;
  marker: number;
  athlete_id: string | null;
  annotation: string;
  duplicate_of: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  updated_at: string | null;
}

const SESSION_SELECT = `
  select s.id, s.type, s.title, s.date, s.created_at, s.sport_profile_id, s.team,
    p.name as sport_profile_name,
    (select json_group_array(json_object('id', x.id, 'name', x.name, 'catchHand', x.catch_hand))
       from (select a.id, a.name, a.catch_hand from session_athletes sa join athletes a on a.id = sa.athlete_id
             where sa.session_id = s.id order by sa.position) x) as athletes,
    (select count(*) from video_files v where v.session_id = s.id and v.status = 'ready') as video_count,
    (select coalesce(sum(v.size_bytes), 0) from video_files v where v.session_id = s.id and v.status = 'ready') as total_bytes
  from sessions s left join sport_profiles p on p.id = s.sport_profile_id`;

const VIDEO_SELECT = `
  select v.*, (select count(*) from scenes c where c.video_file_id = v.id) as scene_count
  from video_files v`;

export function getVideo(db: Db, id: string): VideoRow | undefined {
  return db.prepare(`${VIDEO_SELECT} where v.id = ?`).get(id) as VideoRow | undefined;
}

export function getSessionRow(db: Db, id: string): SessionRow | undefined {
  return db.prepare(`${SESSION_SELECT} where s.id = ?`).get(id) as SessionRow | undefined;
}

export function getSession(db: Db, id: string): SessionDto | undefined {
  const row = getSessionRow(db, id);
  return row && toSessionDto(row);
}

export function listSessions(db: Db): SessionDto[] {
  const rows = db.prepare(`${SESSION_SELECT} order by coalesce(s.date, s.created_at) desc`).all();
  return (rows as unknown as SessionRow[]).map(toSessionDto);
}

export function listVideos(db: Db, sessionId: string): VideoRow[] {
  return db
    .prepare(`${VIDEO_SELECT} where v.session_id = ? and v.status != 'deleted' order by v.part_index`)
    .all(sessionId) as unknown as VideoRow[];
}

export function getScene(db: Db, id: string): SceneRow | undefined {
  return db.prepare('select * from scenes where id = ?').get(id) as SceneRow | undefined;
}

export function videoProbe(row: VideoRow): VideoProbe | null {
  return row.probe ? (JSON.parse(row.probe) as VideoProbe) : null;
}

export function toVideoDto(row: VideoRow): VideoDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    partIndex: row.part_index,
    source: row.source,
    sceneCount: row.scene_count,
    name: row.original_name,
    sizeBytes: row.size_bytes,
    status: row.status,
    probe: videoProbe(row),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    rotation: row.rotation,
    trimStartSec: row.trim_start_sec,
    trimEndSec: row.trim_end_sec,
  };
}

function toSessionDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    date: row.date,
    createdAt: row.created_at,
    videoCount: row.video_count,
    totalBytes: row.total_bytes,
    sportProfileId: row.sport_profile_id,
    sportProfileName: row.sport_profile_name,
    team: row.team,
    athletes: JSON.parse(row.athletes) as AthleteDto[],
  };
}

export function toSceneDto(row: SceneRow): SceneDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    videoId: row.video_file_id,
    startSec: row.start_sec,
    endSec: row.end_sec,
    eventTypeKey: row.event_type_key,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    comment: row.comment,
    status: row.status,
    clientId: row.client_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    marker: row.marker === 1,
    athleteId: row.athlete_id,
    annotation: normalizeAnnotation(JSON.parse(row.annotation) as Partial<SceneAnnotation>),
    duplicateOf: row.duplicate_of,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
  };
}
