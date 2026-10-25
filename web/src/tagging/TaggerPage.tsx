// Stage 1 tagging: fast marking of interesting moments while the video keeps playing.
// Space marks a moment, an event type's hotkey marks it with that category, Enter plays/pauses,
// Ctrl/⌘+Z undoes the last mark. Marks are saved locally first and synced in the background.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { countEvents, periodAt, periodsOf } from '../../../shared/periods.ts';
import { isPointKind, type EventKind } from '../../../shared/profile.ts';
import { sceneRef, sceneView, type LocalScene } from '../../../shared/scene-outbox.ts';
import type { PlaybackDto, ProfileDto, SceneDto, SessionDetailDto, UserDto, VideoDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatTimecode } from '../format.ts';
import { isTyping, releaseButtonFocus, VideoStage } from '../player/VideoStage.tsx';
import { href } from '../router.ts';
import { SceneTimeline } from './SceneTimeline.tsx';
import { sceneSync, type SyncSnapshot } from './sceneSync.ts';

interface Preset {
  id: string;
  label: string;
  before: number;
  after: number;
}

const PRESETS: Preset[] = [
  { id: '5-5', label: '±5 s', before: 5, after: 5 },
  { id: '10-10', label: '±10 s', before: 10, after: 10 },
  { id: '20-20', label: '±20 s', before: 20, after: 20 },
  { id: '10-5', label: '−10 s / +5 s', before: 10, after: 5 },
];
const MANUAL = 'manual';
const PRESET_STORAGE_KEY = 'sva.tagger.preset';
const MIN_MANUAL_SEC = 0.5;

function storedPreset(): string {
  try {
    return localStorage.getItem(PRESET_STORAGE_KEY) ?? '10-10';
  } catch {
    return '10-10';
  }
}

function syncLabel(sync: SyncSnapshot): { text: string; tone: 'ok' | 'busy' | 'warn' } {
  const n = sync.ops.length;
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (sync.state === 'signed-out') return { text: `Signed out. Sign in again to save ${changes}.`, tone: 'warn' };
  if (sync.state === 'waiting') return { text: `${changes} kept on this device, waiting for the connection`, tone: 'warn' };
  if (n > 0) return { text: 'Saving…', tone: 'busy' };
  return { text: 'All marks saved', tone: 'ok' };
}

export function TaggerPage({ id, user }: { id: string; user: UserDto }) {
  const [video, setVideo] = useState<VideoDto | null>(null);
  const [session, setSession] = useState<SessionDetailDto | null>(null);
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [serverScenes, setServerScenes] = useState<SceneDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [presetId, setPresetId] = useState(storedPreset);
  const [pendingStart, setPendingStart] = useState<{ sec: number; eventKey: string | null } | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const undoStack = useRef<string[]>([]);
  const sync = useSyncExternalStore(sceneSync.subscribe, sceneSync.getSnapshot);

  const loadScenes = useCallback(() => {
    api<{ scenes: SceneDto[] }>(`/videos/${id}/scenes`)
      .then((res) => {
        setServerScenes(res.scenes);
        sceneSync.forgetConfirmed();
      })
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  useEffect(() => {
    (async () => {
      const { video } = await api<{ video: VideoDto }>(`/videos/${id}`);
      setVideo(video);
      const { session } = await api<{ session: SessionDetailDto }>(`/sessions/${video.sessionId}`);
      setSession(session);
      if (session.sportProfileId) {
        setProfile((await api<{ profile: ProfileDto }>(`/profiles/${session.sportProfileId}`)).profile);
      }
    })().catch((err) => setError(errorMessage(err)));
    api<PlaybackDto>(`/videos/${id}/playback`)
      .then((res) => setUrl(res.url))
      .catch((err) => setError(errorMessage(err)));
    loadScenes();
  }, [id, loadScenes]);

  // Once everything is sent, refresh from the server so the list matches what others see.
  useEffect(() => {
    if (sync.state === 'idle' && sync.ops.length === 0 && sync.confirmed.size > 0) loadScenes();
  }, [sync.state, sync.ops.length, sync.confirmed.size, loadScenes]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(timer);
  }, [flash]);

  const scenes = useMemo(() => {
    const byRef = new Map<string, SceneDto>();
    for (const s of serverScenes) if (!sync.deleted.has(sceneRef(s))) byRef.set(sceneRef(s), s);
    for (const [ref, s] of sync.confirmed) if (s.videoId === id) byRef.set(ref, s);
    return sceneView([...byRef.values()], [...sync.ops], id);
  }, [serverScenes, sync, id]);

  const eventTypes = profile?.definition.eventTypes ?? [];
  const colors = Object.fromEntries(eventTypes.map((e) => [e.key, e.color]));
  const kindOf = (key: string | null): EventKind | null =>
    key === null ? 'scene' : (eventTypes.find((e) => e.key === key)?.kind ?? null);
  const isPoint = (scene: LocalScene) => isPointKind(kindOf(scene.eventTypeKey) ?? 'scene');

  // Counters: per event type in the period under the playhead and in the whole video.
  const periods = periodsOf(scenes, kindOf);
  const currentPeriod = periodAt(periods, time);
  const totals = countEvents(scenes, kindOf);
  const inPeriod = currentPeriod ? countEvents(scenes, kindOf, currentPeriod) : null;
  const labelOf = (key: string | null) => eventTypes.find((e) => e.key === key)?.label ?? 'No category';
  const selected = scenes.find((s) => s.ref === selectedRef) ?? null;
  const playable = { start: video?.trimStartSec ?? 0, end: video?.trimEndSec ?? duration };
  const manual = presetId === MANUAL;

  useEffect(() => setCommentDraft(selected?.comment ?? ''), [selectedRef, selected?.comment]);

  const canEdit = (scene: LocalScene) =>
    user.role === 'analyst' || (scene.createdBy === user.id && scene.status === 'unreviewed');

  const seek = (sec: number) => {
    const el = videoEl.current;
    if (el) el.currentTime = Math.min(Math.max(sec, playable.start), playable.end || sec);
  };

  // Marking never pauses or seeks: the video keeps running while the mark is stored.
  const mark = (eventKey: string | null) => {
    const el = videoEl.current;
    if (!el || !video) return;
    const now = el.currentTime;
    let start: number;
    let end: number;
    if (isPointKind(kindOf(eventKey) ?? 'scene')) {
      // A point in time; the server stores it with a minimal range. Manual mode is not involved.
      start = now;
      end = now + 0.01;
    } else if (manual) {
      if (!pendingStart) {
        setPendingStart({ sec: now, eventKey });
        setFlash(`Start set at ${formatTimecode(now)}. Press again at the end.`);
        return;
      }
      start = Math.min(pendingStart.sec, now);
      end = Math.max(pendingStart.sec, now, start + MIN_MANUAL_SEC);
      eventKey = eventKey ?? pendingStart.eventKey;
      setPendingStart(null);
    } else {
      const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1];
      start = Math.max(playable.start, now - preset.before);
      end = Math.min(playable.end || el.duration, now + preset.after);
    }
    if (end <= start) return;
    const ref = crypto.randomUUID();
    sceneSync.add({
      kind: 'create',
      ref,
      videoId: video.id,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      fields: { startSec: start, endSec: end, eventTypeKey: eventKey, comment: null },
    });
    undoStack.current.push(ref);
    setSelectedRef(ref);
    setFlash(
      isPointKind(kindOf(eventKey) ?? 'scene')
        ? `Marked ${labelOf(eventKey)} at ${formatTimecode(start)}`
        : `Marked ${formatTimecode(start)}–${formatTimecode(end)} · ${labelOf(eventKey)}`,
    );
  };

  const update = (scene: LocalScene, patch: { eventTypeKey?: string | null; comment?: string | null }) =>
    sceneSync.add({ kind: 'update', ref: scene.ref, videoId: scene.videoId, patch });

  const remove = (scene: LocalScene) => {
    sceneSync.add({ kind: 'delete', ref: scene.ref, videoId: scene.videoId });
    if (selectedRef === scene.ref) setSelectedRef(null);
  };

  const undo = () => {
    while (undoStack.current.length > 0) {
      const ref = undoStack.current.pop()!;
      const scene = scenes.find((s) => s.ref === ref);
      if (scene) {
        remove(scene);
        setFlash('Last mark undone');
        return;
      }
    }
    setFlash('Nothing to undo');
  };

  const saveComment = () => {
    if (selected && (commentDraft.trim() || null) !== selected.comment) update(selected, { comment: commentDraft.trim() || null });
  };

  // One window listener; it always calls the latest closures.
  const actions = useRef({ mark, undo, cancelPending: () => setPendingStart(null), eventTypes });
  actions.current = { mark, undo, cancelPending: () => setPendingStart(null), eventTypes };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.repeat) return;
      const a = actions.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        a.undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      let handled = true;
      if (event.key === ' ') a.mark(null);
      else if (event.key === 'Escape') a.cancelPending();
      else {
        const type = a.eventTypes.find((e) => e.hotkey === event.key.toLowerCase());
        if (type) a.mark(type.key);
        else handled = false;
      }
      if (handled) {
        event.preventDefault();
        releaseButtonFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choosePreset = (value: string) => {
    setPresetId(value);
    setPendingStart(null);
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, value);
    } catch {
      // Not remembered; fine.
    }
  };

  const parts = session?.videos.filter((v) => v.status === 'ready') ?? [];
  const status = syncLabel(sync);

  return (
    <div className="stack tagger">
      {video && (
        <div className="row wrap">
          <a href={href.session(video.sessionId)}>← {session?.title ?? 'Session'}</a>
          <span className="grow ellipsis muted">{video.name}</span>
          <a href={href.video(video.id)} className="small">
            Analysis view
          </a>
          <span className={`sync-badge sync-${status.tone}`} role="status">
            {status.text}
          </span>
        </div>
      )}
      {session?.type === 'match' && parts.length > 1 && (
        <nav className="part-tabs" aria-label="Match parts">
          {parts.map((p, i) => (
            <a key={p.id} href={href.tag(p.id)} className={p.id === id ? 'active' : undefined} title={p.name}>
              Part {i + 1}
            </a>
          ))}
        </nav>
      )}
      {error && <p className="error">{error}</p>}
      {sync.rejected && (
        <p className="error small">
          {sync.rejected}{' '}
          <button className="link" onClick={() => sceneSync.dismissRejected()}>
            Dismiss
          </button>
        </p>
      )}

      <div className="tagger-layout">
        <div className="tagger-main stack-sm">
          {url && video && (
            <VideoStage
              src={url}
              rotation={video.rotation}
              range={{ start: video.trimStartSec ?? 0, end: video.trimEndSec }}
              constrained
              fps={video.probe?.fps ?? null}
              shortcuts
              playKey="Enter"
              initialSize={
                video.probe?.width && video.probe.height ? { width: video.probe.width, height: video.probe.height } : null
              }
              onTime={setTime}
              onLoaded={(el) => {
                videoEl.current = el;
                setDuration(el.duration);
              }}
            />
          )}

          <SceneTimeline
            scenes={scenes}
            isPoint={isPoint}
            duration={duration}
            time={time}
            colors={colors}
            selectedRef={selectedRef}
            playable={playable}
            onSelect={(scene) => {
              setSelectedRef(scene.ref);
              seek(scene.startSec);
            }}
            onSeek={seek}
          />
          <p className={`flash small${flash ? ' visible' : ''}`} aria-live="polite">
            {flash ??
              (pendingStart
                ? `Start set at ${formatTimecode(pendingStart.sec)}. Press again at the end, Esc cancels.`
                : '\u00a0')}
          </p>
          {!profile && session && (
            <p className="muted small">
              This session has no sport profile, so marks get no category. Choose one on the{' '}
              <a href={href.session(session.id)}>session page</a>.
            </p>
          )}
        </div>

        <aside className="tagger-side stack-sm">
          <section className="mark-bar">
            <button className={`mark-button${pendingStart ? ' armed' : ''}`} onClick={() => mark(null)}>
              {pendingStart ? 'End moment' : 'Interesting moment'} <kbd>Space</kbd>
            </button>
            {eventTypes.length > 0 && (
              <div className="small muted">
                {currentPeriod
                  ? `Period ${currentPeriod.number} · counts: this period · whole video`
                  : periods.length > 0
                    ? 'Between periods · counts: whole video'
                    : 'Counts: whole video'}
              </div>
            )}
            <div className="event-grid">
              {eventTypes.map((e) => {
                const point = e.kind === 'period-start' || e.kind === 'period-end';
                const total = totals.get(e.key) ?? 0;
                const here = inPeriod?.get(e.key) ?? 0;
                return (
                  <button
                    key={e.key}
                    className="event-button"
                    style={{ '--event-color': e.color } as CSSProperties}
                    onClick={() => mark(e.key)}
                    title={point ? undefined : `${inPeriod ? `${here} in this period, ` : ''}${total} in the whole video`}
                  >
                    <span className="ellipsis grow">
                      {isPointKind(e.kind) && '◆ '}
                      {e.label}
                    </span>
                    {!point && <span className="count">{inPeriod ? `${here} · ${total}` : total}</span>}
                    {e.hotkey && <kbd>{e.hotkey.toUpperCase()}</kbd>}
                  </button>
                );
              })}
            </div>
            <div className="mark-tools">
              <label className="row inline-label">
                Range
                <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                  <option value={MANUAL}>Manual (start, then end)</option>
                </select>
              </label>
              <button onClick={undo} title="Undo last mark (Ctrl/⌘+Z)">
                Undo
              </button>
            </div>
          </section>

          {selected && (
            <section className="card stack-sm selected-mark">
              <div className="row wrap">
                <strong className="grow">
                  {isPoint(selected)
                    ? `${labelOf(selected.eventTypeKey)} at ${formatTimecode(selected.startSec)}`
                    : `${formatTimecode(selected.startSec)}–${formatTimecode(selected.endSec)}`}
                  {selected.pending && <span className="muted small"> · not saved yet</span>}
                  {selected.status !== 'unreviewed' && <span className="muted small"> · {selected.status}</span>}
                </strong>
                <button onClick={() => seek(selected.startSec)} title="Play from the start of the mark">
                  ▶︎ Start
                </button>
                {canEdit(selected) && (
                  <button className="danger" onClick={() => remove(selected)} title="Delete mark">
                    Delete
                  </button>
                )}
              </div>
              {canEdit(selected) ? (
                <>
                  {eventTypes.length > 0 && (
                    <div className="chips">
                      {/* A scene stays a scene and a marker a marker; the server refuses switching. */}
                      {eventTypes.filter((e) => isPointKind(e.kind) === isPoint(selected)).map((e) => (
                        <button
                          key={e.key}
                          className={`chip small${selected.eventTypeKey === e.key ? ' selected' : ''}`}
                          onClick={() =>
                            update(selected, {
                              // Markers always need a type; scenes can go back to "no category".
                              eventTypeKey: selected.eventTypeKey === e.key && !isPoint(selected) ? null : e.key,
                            })
                          }
                        >
                          {e.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    placeholder="Optional comment, Enter saves"
                    value={commentDraft}
                    maxLength={500}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onBlur={saveComment}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        saveComment();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </>
              ) : (
                <p className="muted small">
                  {labelOf(selected.eventTypeKey)}
                  {selected.comment && ` · ${selected.comment}`}
                  {' · '}
                  {selected.status === 'unreviewed' ? 'marked by someone else' : 'already reviewed'}
                </p>
              )}
            </section>
          )}

          <section className="card marks-card">
            <h2>Marks ({scenes.length})</h2>
            {scenes.length === 0 && <p className="muted small">No marks yet. Press Space while the video plays.</p>}
            {/* Latest scene first, so the newest marks are always in view. */}
            <ul className="mark-list">
              {[...scenes].reverse().map((s) => (
                <li key={s.ref}>
                  <button
                    className={`mark-row${s.ref === selectedRef ? ' selected' : ''}`}
                    onClick={() => {
                      setSelectedRef(s.ref);
                      seek(s.startSec);
                    }}
                  >
                    <span
                      className={isPoint(s) ? 'dot point' : 'dot'}
                      style={{ background: s.eventTypeKey ? colors[s.eventTypeKey] : undefined }}
                    />
                    <span className="mark-text">
                      <span className="row">
                        <span className="timecode">{formatTimecode(s.startSec)}</span>
                        <span className="grow ellipsis">{labelOf(s.eventTypeKey)}</span>
                        {s.pending && (
                          <span className="muted small" title="Not saved on the server yet">
                            ⟳
                          </span>
                        )}
                      </span>
                      {s.comment && <span className="muted small ellipsis">{s.comment}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
