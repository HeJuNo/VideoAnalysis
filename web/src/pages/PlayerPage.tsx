// Analysis player for one video file, with part navigation for multi-file matches, the simple
// non-destructive edits (rotate, trim) and "whole clip as scene" for training clips.
import { useEffect, useRef, useState } from 'react';
import { playability } from '../../../shared/mp4-probe.ts';
import type { PlaybackDto, Rotation, SceneDto, SessionDetailDto, VideoDto, VideoEdits } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { CodecBadge, EditableText, editSummary, probeSummary, probeWarnings } from '../components.tsx';
import { formatDuration, formatTimecode } from '../format.ts';
import { VideoStage } from '../player/VideoStage.tsx';
import { href } from '../router.ts';

const MIN_TRIMMED_SEC = 1;

function editsOf(video: VideoDto): VideoEdits {
  return { rotation: video.rotation, trimStartSec: video.trimStartSec, trimEndSec: video.trimEndSec };
}

export function PlayerPage({ id }: { id: string }) {
  const [video, setVideo] = useState<VideoDto | null>(null);
  const [session, setSession] = useState<SessionDetailDto | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Non-null while editing; shown live in the player until saved or cancelled.
  const [draft, setDraft] = useState<VideoEdits | null>(null);
  const [saving, setSaving] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const refreshed = useRef(false);

  useEffect(() => {
    api<{ video: VideoDto }>(`/videos/${id}`)
      .then((res) => {
        setVideo(res.video);
        return api<{ session: SessionDetailDto }>(`/sessions/${res.video.sessionId}`);
      })
      .then((res) => setSession(res.session))
      .catch((err) => setError(errorMessage(err)));
    api<PlaybackDto>(`/videos/${id}/playback`)
      .then((res) => setUrl(res.url))
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  const onLoaded = (el: HTMLVideoElement) => {
    setDuration(el.duration);
    setDecoded(
      el.videoWidth > 0
        ? `Browser decodes ${el.videoWidth}×${el.videoHeight}, ${formatDuration(el.duration)}`
        : 'Browser loaded the file but cannot decode its video track',
    );
  };

  // A signed URL may expire during a long session: fetch a new one once and keep the position.
  const onError = async (el: HTMLVideoElement) => {
    if (!refreshed.current) {
      refreshed.current = true;
      const position = el.currentTime;
      try {
        const res = await api<PlaybackDto>(`/videos/${id}/playback`);
        el.addEventListener('loadedmetadata', () => (el.currentTime = position), { once: true });
        setUrl(res.url);
        return;
      } catch {
        // Fall through to the error message.
      }
    }
    setError(
      playability(video?.probe ?? null) === 'ok'
        ? `Playback failed (media error ${el.error?.code ?? '?'}).`
        : 'This browser cannot play the video format. Use Safari, or convert the file to H.264 MP4.',
    );
  };

  const patchVideo = async (body: Partial<VideoEdits & { name: string }>) => {
    const res = await api<{ video: VideoDto }>(`/videos/${id}`, { method: 'PATCH', body });
    setVideo(res.video);
    return res.video;
  };

  const edits = draft ?? (video ? editsOf(video) : null);
  const trimEnd = draft?.trimEndSec ?? duration;
  const trimError =
    draft && trimEnd !== null && trimEnd - (draft.trimStartSec ?? 0) < MIN_TRIMMED_SEC
      ? `Start must be at least ${MIN_TRIMMED_SEC} s before the end`
      : null;

  const rotate = (delta: number) =>
    setDraft((d) => d && { ...d, rotation: ((((d.rotation + delta) % 360) + 360) % 360) as Rotation });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await patchVideo(draft);
      setDraft(null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // The scene covers the playable (trimmed) range. A deterministic clientId makes repeated clicks
  // return the same scene instead of creating duplicates.
  const markWholeClip = async () => {
    if (!video) return;
    const start = video.trimStartSec ?? 0;
    const end = video.trimEndSec ?? duration ?? video.probe?.durationSec ?? null;
    if (end === null) return;
    try {
      const res = await api<{ scene: SceneDto }>('/scenes', {
        body: { videoId: video.id, startSec: start, endSec: end, clientId: `whole:${video.id}:${start}:${end}` },
      });
      setNotice(`Scene ${formatTimecode(res.scene.startSec)}–${formatTimecode(res.scene.endSec)} saved.`);
      setVideo(await api<{ video: VideoDto }>(`/videos/${id}`).then((r) => r.video));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const parts = session?.videos.filter((v) => v.status === 'ready') ?? [];
  const summary = video && editSummary(video);
  const fps = video?.probe?.fps ?? null;

  return (
    <div className="stack-lg">
      {video && (
        <div className="row wrap">
          <a href={href.session(video.sessionId)}>← {session?.title ?? 'Session'}</a>
          {session?.sportProfileName && <span className="muted small">Profile: {session.sportProfileName}</span>}
        </div>
      )}
      {session?.type === 'match' && parts.length > 1 && (
        <nav className="part-tabs" aria-label="Match parts">
          {parts.map((p, i) => (
            <a key={p.id} href={href.video(p.id)} className={p.id === id ? 'active' : undefined} title={p.name}>
              Part {i + 1}
            </a>
          ))}
        </nav>
      )}
      {video && (
        <div className="row wrap">
          <h1 className="grow ellipsis">
            <EditableText value={video.name} label="video" onSave={async (name) => void (await patchVideo({ name }))} />
          </h1>
          <CodecBadge probe={video.probe} />
          {!draft && video.status === 'ready' && <button onClick={() => setDraft(editsOf(video))}>Rotate / trim</button>}
        </div>
      )}
      {url && edits && video && (
        <VideoStage
          src={url}
          rotation={edits.rotation}
          range={{ start: edits.trimStartSec ?? 0, end: edits.trimEndSec }}
          constrained={!draft}
          fps={fps}
          shortcuts
          initialSize={video.probe?.width && video.probe.height ? { width: video.probe.width, height: video.probe.height } : null}
          onTime={setTime}
          onLoaded={onLoaded}
          onError={onError}
        />
      )}
      {error && <p className="error">{error}</p>}

      {video && session?.type === 'training' && !draft && (
        <section className="card row wrap">
          <span className="grow">
            {video.sceneCount === 0
              ? 'No scene in this clip yet.'
              : `${video.sceneCount} scene${video.sceneCount === 1 ? '' : 's'} in this clip.`}
            {notice && <span className="muted small"> {notice}</span>}
          </span>
          <button className="primary" onClick={markWholeClip} disabled={duration === null && !video.probe?.durationSec}>
            Mark whole clip as scene
          </button>
        </section>
      )}

      {draft && (
        <section className="card stack">
          <h2>Rotate / trim</h2>
          <div className="row wrap">
            <strong className="edit-label">Rotation</strong>
            <button onClick={() => rotate(-90)}>↺ Left</button>
            <button onClick={() => rotate(90)}>Right ↻</button>
            <span className="muted">{draft.rotation}°</span>
          </div>
          <div className="row wrap">
            <strong className="edit-label">Start</strong>
            <span className="timecode grow">
              {draft.trimStartSec === null ? 'Beginning of file' : formatTimecode(draft.trimStartSec)}
            </span>
            <button onClick={() => setDraft({ ...draft, trimStartSec: time > 0 ? time : null })}>
              Set to {formatTimecode(time)}
            </button>
            <button disabled={draft.trimStartSec === null} onClick={() => setDraft({ ...draft, trimStartSec: null })}>
              Clear
            </button>
          </div>
          <div className="row wrap">
            <strong className="edit-label">End</strong>
            <span className="timecode grow">
              {draft.trimEndSec === null ? 'End of file' : formatTimecode(draft.trimEndSec)}
            </span>
            <button onClick={() => setDraft({ ...draft, trimEndSec: time })}>Set to {formatTimecode(time)}</button>
            <button disabled={draft.trimEndSec === null} onClick={() => setDraft({ ...draft, trimEndSec: null })}>
              Clear
            </button>
          </div>
          {trimError && <p className="error small">{trimError}</p>}
          <div className="row wrap">
            <button className="primary" disabled={saving || trimError !== null} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
            <span className="muted small">
              Play or drag to a position, then set start or end. The original file is never changed.
            </span>
          </div>
        </section>
      )}

      <div className="card stack-sm small">
        {video && <div>File: {probeSummary(video.probe) || 'details unknown'}</div>}
        {summary && <div>Edits: {summary}</div>}
        {decoded && <div>{decoded}</div>}
        {video && probeWarnings(video.probe).map((w) => <div key={w} className="warning">{w}</div>)}
      </div>
    </div>
  );
}
