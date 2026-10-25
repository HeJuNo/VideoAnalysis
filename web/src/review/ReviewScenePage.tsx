// Stage 2 review of one scene: trim the range to the frame, set category and athlete, fill in
// the profile's attributes and diagrams (with "uncertain"/"unknown" flags), then mark it
// reviewed, rejected or duplicate and continue with the next scene in the queue.
import { useEffect, useRef, useState } from 'react';
import { emptyAnnotation, type Certainty, type DiagramPoint, type SceneAnnotation } from '../../../shared/annotation.ts';
import { hockeyGoalZone } from '../../../shared/goal-zones.ts';
import { attributesFor, diagramsFor, type ProfileDefinition } from '../../../shared/profile.ts';
import type {
  PlaybackDto,
  ProfileDto,
  ReviewQueueItemDto,
  SceneDetailDto,
  SceneDto,
  SceneStatus,
  UserDto,
} from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { DiagramPicker } from '../diagrams/DiagramPicker.tsx';
import { formatDateTime, formatPrecise, formatTimecode } from '../format.ts';
import { SessionInfo } from '../pages/SessionSetup.tsx';
import { VideoStage } from '../player/VideoStage.tsx';
import { AttributeField, type AttributeValue } from '../profiles/AttributeField.tsx';
import { href, navigate } from '../router.ts';
import { STATUS_LABELS } from './ReviewQueuePage.tsx';
import { SceneRangeEditor } from './SceneRangeEditor.tsx';

interface Draft {
  startSec: number;
  endSec: number;
  eventTypeKey: string | null;
  comment: string | null;
  athleteId: string | null;
  annotation: SceneAnnotation;
  duplicateOf: string | null;
}

const DEFAULT_FPS = 30;

function draftOf(scene: SceneDto): Draft {
  return {
    startSec: scene.startSec,
    endSec: scene.endSec,
    eventTypeKey: scene.eventTypeKey,
    comment: scene.comment,
    athleteId: scene.athleteId,
    annotation: scene.annotation,
    duplicateOf: scene.duplicateOf,
  };
}

/** Keeps only the answers that apply to the chosen event type. */
function prune(def: ProfileDefinition | null, eventKey: string | null, annotation: SceneAnnotation): SceneAnnotation {
  if (!def) return emptyAnnotation();
  const attributes = new Set(attributesFor(def, eventKey).map((a) => a.key));
  const diagrams = new Set(diagramsFor(def, eventKey).map((d) => d.key));
  const pick = <T,>(record: Record<string, T>, keys: Set<string>) =>
    Object.fromEntries(Object.entries(record).filter(([k]) => keys.has(k)));
  return {
    values: pick(annotation.values, attributes),
    points: pick(annotation.points, diagrams),
    valueFlags: pick(annotation.valueFlags, attributes),
    pointFlags: pick(annotation.pointFlags, diagrams),
  };
}

function CertaintyToggle({ value, onChange }: { value: Certainty | undefined; onChange: (value: Certainty | null) => void }) {
  return (
    <span className="certainty">
      {(['uncertain', 'unknown'] as const).map((flag) => (
        <button
          key={flag}
          type="button"
          className={`chip small${value === flag ? ' selected' : ''}`}
          aria-pressed={value === flag}
          title={flag === 'uncertain' ? 'Best guess, e.g. obscured angle' : 'Cannot be judged from the video'}
          onClick={() => onChange(value === flag ? null : flag)}
        >
          {flag === 'uncertain' ? 'Uncertain' : 'Unknown'}
        </button>
      ))}
    </span>
  );
}

export function ReviewScenePage({ id, user }: { id: string; user: UserDto }) {
  const [detail, setDetail] = useState<SceneDetailDto | null>(null);
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [queue, setQueue] = useState<ReviewQueueItemDto[]>([]);
  const [sessionScenes, setSessionScenes] = useState<SceneDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const stopAt = useRef<number | null>(null);

  const load = async () => {
    const res = await api<SceneDetailDto>(`/scenes/${id}`);
    setDetail(res);
    setDraft(draftOf(res.scene));
    return res;
  };

  useEffect(() => {
    (async () => {
      const res = await load();
      const { scene } = res;
      const [playback, queueRes, scenesRes, profileRes] = await Promise.all([
        api<PlaybackDto>(`/videos/${scene.videoId}/playback`),
        api<{ items: ReviewQueueItemDto[] }>(`/review/queue?status=unreviewed&sessionId=${scene.sessionId}`),
        api<{ scenes: SceneDto[] }>(`/sessions/${scene.sessionId}/scenes`),
        scene.profileId
          ? api<{ profile: ProfileDto }>(`/profiles/${scene.profileId}?version=${scene.profileVersion}`)
          : Promise.resolve(null),
      ]);
      setUrl(playback.url);
      setQueue(queueRes.items);
      setSessionScenes(scenesRes.scenes);
      setProfile(profileRes?.profile ?? null);
    })().catch((err) => setError(errorMessage(err)));
  }, [id]);

  // "Play scene" stops at the scene end; checked every frame for accuracy.
  useEffect(() => {
    let frame = requestAnimationFrame(function check() {
      const el = videoEl.current;
      if (el && stopAt.current !== null && el.currentTime >= stopAt.current) {
        el.pause();
        stopAt.current = null;
      }
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  if (user.role !== 'analyst') return <p className="muted">Only analysts can review scenes.</p>;
  if (!detail || !draft) return error ? <p className="error">{error}</p> : null;

  const { scene, video, session } = detail;
  const def = profile?.definition ?? null;
  const fps = video.probe?.fps ?? DEFAULT_FPS;
  // Only range types: point markers never reach review and scenes cannot become markers.
  const eventTypes = (def?.eventTypes ?? []).filter((e) => e.kind === 'scene');
  const attributes = def ? attributesFor(def, draft.eventTypeKey) : [];
  const diagrams = def ? diagramsFor(def, draft.eventTypeKey) : [];
  const athlete = session.athletes.find((a) => a.id === draft.athleteId) ?? null;
  const playable = { min: video.trimStartSec ?? 0, max: video.trimEndSec ?? (duration || draft.endSec) };
  const position = queue.findIndex((item) => item.scene.id === scene.id);
  const next = queue.slice(position + 1).find((item) => item.scene.id !== scene.id) ?? queue.find((item) => item.scene.id !== scene.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(scene));
  const labelOfEvent = (key: unknown) => eventTypes.find((e) => e.key === key)?.label ?? (key === null ? 'none' : String(key));
  const nameOfAthlete = (key: unknown) => session.athletes.find((a) => a.id === key)?.name ?? (key === null ? 'none' : 'removed');

  const seek = (sec: number) => {
    if (videoEl.current) videoEl.current.currentTime = sec;
  };

  const playScene = () => {
    const el = videoEl.current;
    if (!el) return;
    el.currentTime = draft.startSec;
    stopAt.current = draft.endSec;
    void el.play();
  };

  const patchAnnotation = (fn: (a: SceneAnnotation) => SceneAnnotation) =>
    setDraft((d) => d && { ...d, annotation: fn(d.annotation) });

  const setValue = (key: string, value: AttributeValue) =>
    patchAnnotation((a) => {
      const values = { ...a.values };
      if (value === null || (Array.isArray(value) && value.length === 0)) delete values[key];
      else values[key] = value;
      return { ...a, values };
    });

  const setPoint = (key: string, point: DiagramPoint | null) =>
    patchAnnotation((a) => {
      const points = { ...a.points };
      if (point) points[key] = point;
      else delete points[key];
      return { ...a, points };
    });

  // "Unknown" removes the answer; "uncertain" keeps it as a best guess.
  const setFlag = (kind: 'value' | 'point', key: string, flag: Certainty | null) =>
    patchAnnotation((a) => {
      const flags = { ...(kind === 'value' ? a.valueFlags : a.pointFlags) };
      if (flag) flags[key] = flag;
      else delete flags[key];
      const answers = { ...(kind === 'value' ? a.values : a.points) } as Record<string, unknown>;
      if (flag === 'unknown') delete answers[key];
      return kind === 'value'
        ? { ...a, valueFlags: flags, values: answers as SceneAnnotation['values'] }
        : { ...a, pointFlags: flags, points: answers as SceneAnnotation['points'] };
    });

  const save = async (status?: SceneStatus) => {
    if (status === 'duplicate' && !draft.duplicateOf) {
      setError('Choose the scene this one duplicates.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/scenes/${scene.id}`, {
        method: 'PATCH',
        body: {
          startSec: draft.startSec,
          endSec: draft.endSec,
          eventTypeKey: draft.eventTypeKey,
          comment: draft.comment,
          athleteId: draft.athleteId,
          annotation: prune(def, draft.eventTypeKey, draft.annotation),
          ...(status ? { status, duplicateOf: status === 'duplicate' ? draft.duplicateOf : null } : {}),
        },
      });
      if (status && status !== 'unreviewed') {
        navigate(next ? href.scene(next.scene.id) : href.review(session.id));
      } else {
        await load();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const duplicateCandidates = sessionScenes.filter((s) => s.id !== scene.id && s.status !== 'duplicate');

  return (
    <div className="stack review">
      <div className="row wrap">
        <a href={href.review(session.id)}>← Review queue</a>
        <span className="spacer" />
        <span className={`badge status-badge status-${scene.status}`}>{STATUS_LABELS[scene.status]}</span>
        {queue.length > 0 && (
          <span className="muted small">
            {position >= 0 ? `${position + 1} of ${queue.length} unreviewed` : `${queue.length} unreviewed left`}
          </span>
        )}
        {next && (
          <a className="button" href={href.scene(next.scene.id)}>
            Skip →
          </a>
        )}
      </div>
      <div>
        <h1>{session.title}</h1>
        <div className="muted small">
          <SessionInfo session={session} links /> ·{' '}
          {session.type === 'match' ? `Part ${video.partIndex + 1} (${video.name})` : video.name}
        </div>
      </div>

      {url && (
        <VideoStage
          src={url}
          rotation={video.rotation}
          range={{ start: video.trimStartSec ?? 0, end: video.trimEndSec }}
          constrained
          fps={video.probe?.fps ?? null}
          shortcuts
          initialSize={video.probe?.width && video.probe.height ? { width: video.probe.width, height: video.probe.height } : null}
          onTime={setTime}
          onLoaded={(el) => {
            videoEl.current = el;
            setDuration(el.duration);
            el.currentTime = scene.startSec;
          }}
        />
      )}

      <section className="card stack-sm">
        <div className="row wrap">
          <h2 className="grow">
            Scene {formatPrecise(draft.startSec)}–{formatPrecise(draft.endSec)}
          </h2>
          <button className="primary" onClick={playScene}>
            Play scene
          </button>
        </div>
        <SceneRangeEditor
          start={draft.startSec}
          end={draft.endSec}
          time={time}
          fps={fps}
          min={playable.min}
          max={playable.max}
          onChange={(startSec, endSec) => setDraft({ ...draft, startSec, endSec })}
          onSeek={seek}
        />
      </section>

      <div className="review-layout">
        <section className="card stack">
          <div className="field">
            <div className="field-label">Event type</div>
            {def ? (
              <div className="chips">
                {eventTypes.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    className={`chip${draft.eventTypeKey === e.key ? ' selected' : ''}`}
                    aria-pressed={draft.eventTypeKey === e.key}
                    onClick={() => setDraft({ ...draft, eventTypeKey: draft.eventTypeKey === e.key ? null : e.key })}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">This scene was tagged without a sport profile.</p>
            )}
          </div>

          <div className="field">
            <div className="field-label">Athlete</div>
            {session.athletes.length === 0 ? (
              <p className="muted small">
                No athletes in this session. Add them on the <a href={href.session(session.id)}>session page</a>.
              </p>
            ) : (
              <div className="row wrap">
                <select value={draft.athleteId ?? ''} onChange={(e) => setDraft({ ...draft, athleteId: e.target.value || null })}>
                  <option value="">Not assigned</option>
                  {session.athletes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {athlete && (
                  <span className="muted small">
                    {athlete.catchHand ? `catches ${athlete.catchHand}` : <a href={href.athletes()}>set catching hand</a>}
                  </span>
                )}
              </div>
            )}
          </div>

          {attributes.map((a) => {
            const flag = draft.annotation.valueFlags[a.key];
            return (
              <div key={a.key} className={`review-field${flag ? ` flagged-${flag}` : ''}`}>
                <AttributeField
                  attribute={a}
                  value={draft.annotation.values[a.key] ?? null}
                  disabled={flag === 'unknown'}
                  onChange={(value) => setValue(a.key, value)}
                />
                <CertaintyToggle value={flag} onChange={(f) => setFlag('value', a.key, f)} />
              </div>
            );
          })}

          <div className="field">
            <div className="field-label">Tagger comment</div>
            <input
              value={draft.comment ?? ''}
              maxLength={500}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value || null })}
            />
          </div>
        </section>

        {diagrams.length > 0 && (
          <section className="card stack">
            {diagrams.map((d) => {
              const point = draft.annotation.points[d.key] ?? null;
              const flag = draft.annotation.pointFlags[d.key];
              const zone =
                point && d.background.kind === 'template' && d.background.template === 'hockey-goal'
                  ? hockeyGoalZone(point, athlete?.catchHand ?? null)
                  : null;
              return (
                <div key={d.key} className={`review-field${flag ? ` flagged-${flag}` : ''}`}>
                  <DiagramPicker
                    background={d.background}
                    label={d.label + (zone ? ` · ${zone.label}` : '')}
                    value={point}
                    onChange={flag === 'unknown' ? undefined : (p) => setPoint(d.key, p)}
                  />
                  <CertaintyToggle value={flag} onChange={(f) => setFlag('point', d.key, f)} />
                </div>
              );
            })}
          </section>
        )}
      </div>

      <div className="save-bar">
        {error && <p className="error small">{error}</p>}
        <div className="row wrap">
          <button className="primary" disabled={saving} onClick={() => save('reviewed')}>
            Reviewed{next ? ' → next' : ''}
          </button>
          <button disabled={saving} onClick={() => save('rejected')}>
            Reject
          </button>
          <select
            value={draft.duplicateOf ?? ''}
            onChange={(e) => setDraft({ ...draft, duplicateOf: e.target.value || null })}
            aria-label="Duplicate of"
          >
            <option value="">Duplicate of…</option>
            {duplicateCandidates.map((s) => (
              <option key={s.id} value={s.id}>
                {formatTimecode(s.startSec)}–{formatTimecode(s.endSec)} · {labelOfEvent(s.eventTypeKey)}
              </option>
            ))}
          </select>
          <button disabled={saving || !draft.duplicateOf} onClick={() => save('duplicate')}>
            Mark duplicate
          </button>
          <span className="spacer" />
          {scene.status !== 'unreviewed' && (
            <button disabled={saving} onClick={() => save('unreviewed')}>
              Reopen
            </button>
          )}
          <button disabled={saving || !dirty} onClick={() => save()}>
            Save without status change
          </button>
        </div>
      </div>

      <section className="card stack-sm small">
        <h2>History</h2>
        <div className="muted">
          Marked by {detail.users[scene.createdBy ?? ''] ?? 'unknown'} on {formatDateTime(scene.createdAt)}
          {scene.reviewedAt &&
            ` · ${STATUS_LABELS[scene.status].toLowerCase()} by ${detail.users[scene.reviewedBy ?? ''] ?? 'unknown'} on ${formatDateTime(scene.reviewedAt)}`}
        </div>
        <ul className="history">
          {detail.events.map((e) => (
            <li key={e.id}>
              <span className="muted">{formatDateTime(e.at)}</span> · {e.userEmail ?? 'deleted user'} · {e.action}
              {Object.entries(e.changes).length > 0 && ': '}
              {Object.entries(e.changes)
                .map(([field, change]) => {
                  if (field === 'annotation') return 'answers changed';
                  if (e.action === 'created') return null;
                  const show = (v: unknown) =>
                    field === 'eventTypeKey'
                      ? labelOfEvent(v)
                      : field === 'athleteId'
                        ? nameOfAthlete(v)
                        : typeof v === 'number'
                          ? formatPrecise(v)
                          : String(v ?? '–');
                  return `${field} ${show(change.from)} → ${show(change.to)}`;
                })
                .filter(Boolean)
                .join('; ')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
