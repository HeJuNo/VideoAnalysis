import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { SceneDto, SessionDetailDto, UserDto, VideoDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { CodecBadge, EditableText, editSummary, effectiveDurationSec, probeSummary, probeWarnings } from '../components.tsx';
import { formatBytes, formatDuration, formatSpeed } from '../format.ts';
import { href, navigate } from '../router.ts';
import { uploads, type UploadItem, type UploadStatus } from '../uploads/queue.ts';
import { useUploads } from '../uploads/useUploads.ts';
import { SessionSetup } from './SessionSetup.tsx';

const STATUS_LABELS: Record<UploadStatus, string> = {
  queued: 'Waiting',
  probing: 'Reading file',
  uploading: 'Uploading',
  paused: 'Paused',
  completing: 'Finishing',
  done: 'Uploaded',
  error: 'Failed',
};

export function SessionPage({ id, user }: { id: string; user: UserDto }) {
  const [session, setSession] = useState<SessionDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { items, completed } = useUploads();
  const queued = items.filter((item) => item.sessionId === id);

  const load = useCallback(() => {
    api<{ session: SessionDetailDto }>(`/sessions/${id}`)
      .then((res) => setSession(res.session))
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  // Reload whenever an upload finishes anywhere, so new videos appear.
  useEffect(load, [load, completed]);

  if (!session) return error ? <p className="error">{error}</p> : null;

  const inQueue = new Set(queued.map((item) => item.videoId));
  const ready = session.videos.filter((v) => v.status !== 'uploading');
  const interrupted = session.videos.filter((v) => v.status === 'uploading' && !inQueue.has(v.id));

  const deleteVideo = async (video: VideoDto) => {
    if (!confirm(`Delete "${video.name}" permanently? This removes the file from storage.`)) return;
    await api(`/videos/${video.id}`, { method: 'DELETE' }).catch((err) => setError(errorMessage(err)));
    load();
  };

  const renameVideo = async (video: VideoDto, name: string) => {
    await api(`/videos/${video.id}`, { method: 'PATCH', body: { name } });
    load();
  };

  // Training clips: one scene per clip covering its playable (trimmed) range. Deterministic
  // clientIds make this safe to repeat.
  const wholeClipCandidates = session.videos.filter((v) => v.status === 'ready' && v.sceneCount === 0);
  const markAllClips = async () => {
    let skipped = 0;
    for (const video of wholeClipCandidates) {
      const start = video.trimStartSec ?? 0;
      const end = video.trimEndSec ?? video.probe?.durationSec ?? null;
      if (end === null) {
        skipped++;
        continue;
      }
      await api<{ scene: SceneDto }>('/scenes', {
        body: { videoId: video.id, startSec: start, endSec: end, clientId: `whole:${video.id}:${start}:${end}` },
      }).catch((err) => setError(errorMessage(err)));
    }
    if (skipped > 0) setError(`${skipped} clip(s) skipped: duration unknown. Open them and use "Mark whole clip as scene".`);
    load();
  };

  const discardUpload = async (video: VideoDto) => {
    await api(`/uploads/${video.id}`, { method: 'DELETE' }).catch((err) => setError(errorMessage(err)));
    load();
  };

  const deleteSession = async () => {
    if (!confirm(`Delete "${session.title}" and all ${session.videos.length} videos permanently?`)) return;
    try {
      await api(`/sessions/${id}`, { method: 'DELETE' });
      navigate(href.sessions());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <a href={href.sessions()}>← Sessions</a>
      </div>
      <SessionSetup session={session} onSaved={(updated) => setSession({ ...session, ...updated })} />

      {error && <p className="error">{error}</p>}

      <UploadDropzone sessionId={id} type={session.type} />

      {queued.length > 0 && (
        <section className="card stack">
          <h2>Uploads</h2>
          {queued.map((item) => (
            <UploadRow key={item.id} item={item} />
          ))}
        </section>
      )}

      {interrupted.length > 0 && (
        <section className="card stack">
          <h2>Interrupted uploads</h2>
          <p className="muted">Add the same file again to continue where it stopped, or discard the partial upload.</p>
          {interrupted.map((video) => (
            <div key={video.id} className="row wrap">
              <span className="grow">{video.name}</span>
              <span className="muted">{formatBytes(video.sizeBytes)}</span>
              <button onClick={() => discardUpload(video)}>Discard</button>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="row wrap">
          <h2 className="grow">{session.type === 'match' ? 'Match files' : 'Clips'}</h2>
          {user.role === 'analyst' && session.videos.some((v) => v.sceneCount > 0) && (
            <a className="button" href={href.review(session.id)}>
              Review scenes
            </a>
          )}
          {session.type === 'training' && wholeClipCandidates.length > 0 && (
            <button onClick={markAllClips} title="Creates one scene per clip that has none yet">
              Mark all clips without scenes as scenes ({wholeClipCandidates.length})
            </button>
          )}
        </div>
        {ready.length === 0 && <p className="muted">No videos yet.</p>}
        {ready.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>File</th>
                  <th>Format</th>
                  <th className="num">Duration</th>
                  <th className="num">Scenes</th>
                  <th className="num">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ready.map((video, index) => (
                  <tr key={video.id}>
                    <td>{index + 1}</td>
                    <td>
                      <EditableText value={video.name} label="video" onSave={(name) => renameVideo(video, name)} />
                      <div className="muted small">{probeSummary(video.probe)}</div>
                      {editSummary(video) && <div className="small">Edits: {editSummary(video)}</div>}
                      {probeWarnings(video.probe).map((w) => (
                        <div key={w} className="warning small">
                          {w}
                        </div>
                      ))}
                    </td>
                    <td>
                      <CodecBadge probe={video.probe} />
                    </td>
                    <td className="num">
                      {effectiveDurationSec(video) !== null ? formatDuration(effectiveDurationSec(video)!) : '—'}
                    </td>
                    <td className="num">{video.sceneCount}</td>
                    <td className="num">{formatBytes(video.sizeBytes)}</td>
                    <td className="actions">
                      {video.status === 'ready' ? (
                        <>
                          <a className="button primary-link" href={href.tag(video.id)}>
                            Tag
                          </a>
                          <a className="button" href={href.video(video.id)}>
                            Analyse
                          </a>
                        </>
                      ) : (
                        <span className="error small">Upload failed</span>
                      )}
                      {user.role === 'analyst' && <button onClick={() => deleteVideo(video)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {user.role === 'analyst' && (
        <div className="row">
          <button className="danger" onClick={deleteSession}>
            Delete session
          </button>
        </div>
      )}
    </div>
  );
}

function UploadDropzone({ sessionId, type }: { sessionId: string; type: SessionDetailDto['type'] }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const add = (files: FileList | null) => {
    if (files?.length) uploads.add(sessionId, Array.from(files));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  };

  return (
    <section
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p>
        <strong>Drop videos here</strong> or{' '}
        <button className="link" onClick={() => input.current?.click()}>
          choose files
        </button>
      </p>
      <p className="muted small">
        {type === 'match'
          ? 'Multiple files (e.g. one per period) become parts 1, 2, 3 in the order added.'
          : 'Add one or many clips at once.'}{' '}
        MP4 or MOV, H.264 plays in every browser. Uploads continue while you browse this app.
      </p>
      <input
        ref={input}
        type="file"
        accept="video/*,.mp4,.mov,.m4v"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
    </section>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const percent = item.size > 0 ? Math.min(100, (item.bytesUploaded / item.size) * 100) : 0;
  const active = item.status === 'uploading' || item.status === 'queued' || item.status === 'probing';
  const finished = item.status === 'done';

  return (
    <div className="upload stack-sm">
      <div className="row wrap">
        <strong className="grow ellipsis">{item.fileName}</strong>
        {(item.probe || item.probeError) && <CodecBadge probe={item.probe} />}
        <span className={`status status-${item.status}`}>
          {STATUS_LABELS[item.status]}
          {item.resumed && item.status === 'uploading' ? ' (resumed)' : ''}
        </span>
      </div>
      <progress max={100} value={percent} />
      <div className="row wrap small muted">
        <span className="grow">
          {formatBytes(item.bytesUploaded)} of {formatBytes(item.size)} ({percent.toFixed(1)}%)
          {item.speedBps !== null && ` · ${formatSpeed(item.speedBps)}`}
          {item.etaSec !== null && ` · ${formatDuration(item.etaSec)} left`}
        </span>
        {active && <button onClick={() => uploads.pause(item.id)}>Pause</button>}
        {(item.status === 'paused' || item.status === 'error') && (
          <button onClick={() => uploads.resume(item.id)}>{item.status === 'error' ? 'Retry' : 'Resume'}</button>
        )}
        {!finished && item.status !== 'completing' && <button onClick={() => uploads.cancel(item.id)}>Cancel</button>}
        {finished && <button onClick={() => uploads.dismiss(item.id)}>Dismiss</button>}
      </div>
      {item.error && <p className="error small">{item.error}</p>}
      {(item.probe || item.probeError) &&
        probeWarnings(item.probe, item.probeError).map((w) => (
          <div key={w} className="warning small">
            {w}
          </div>
        ))}
    </div>
  );
}
