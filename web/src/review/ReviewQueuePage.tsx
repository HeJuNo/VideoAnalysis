// Scenes waiting for review, grouped by session and in time order within each session.
import { useEffect, useState } from 'react';
import type { ReviewQueueItemDto, SceneStatus, SessionDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatDate, formatTimecode } from '../format.ts';
import { SessionInfo } from '../pages/SessionSetup.tsx';
import { href, navigate } from '../router.ts';

export const STATUS_LABELS: Record<SceneStatus, string> = {
  unreviewed: 'Unreviewed',
  reviewed: 'Reviewed',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
};

export function ReviewQueuePage({ sessionId }: { sessionId: string | null }) {
  const [status, setStatus] = useState<SceneStatus>('unreviewed');
  const [items, setItems] = useState<ReviewQueueItemDto[] | null>(null);
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ sessions: SessionDto[] }>('/sessions')
      .then((res) => setSessions(res.sessions))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    const query = new URLSearchParams({ status, ...(sessionId ? { sessionId } : {}) });
    api<{ items: ReviewQueueItemDto[] }>(`/review/queue?${query}`)
      .then((res) => setItems(res.items))
      .catch((err) => setError(errorMessage(err)));
  }, [status, sessionId]);

  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map<string, ReviewQueueItemDto[]>();
  for (const item of items ?? []) {
    const list = groups.get(item.scene.sessionId) ?? [];
    list.push(item);
    groups.set(item.scene.sessionId, list);
  }

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <h1 className="grow">Review</h1>
        <select value={sessionId ?? ''} onChange={(e) => navigate(href.review(e.target.value || null))} aria-label="Session">
          <option value="">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · {formatDate(s.date)}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as SceneStatus)} aria-label="Status">
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {items?.length === 0 && (
        <p className="muted">{status === 'unreviewed' ? 'Nothing to review. All marks are done.' : 'No scenes with this status.'}</p>
      )}
      {[...groups.values()].map((group) => (
        <section key={group[0].scene.sessionId} className="card stack-sm">
          <div className="row wrap">
            <div className="grow">
              <h2>{group[0].sessionTitle}</h2>
              <div className="muted small">
                {sessionsById.has(group[0].scene.sessionId) ? (
                  <SessionInfo session={sessionsById.get(group[0].scene.sessionId)!} />
                ) : (
                  formatDate(group[0].sessionDate)
                )}
              </div>
            </div>
            <span className="muted small">{group.length} scenes</span>
            {status === 'unreviewed' && (
              <a className="button primary-link" href={href.scene(group[0].scene.id)}>
                Start reviewing
              </a>
            )}
          </div>
          <ul className="mark-list">
            {group.map((item) => (
              <li key={item.scene.id}>
                <a className="mark-row button" href={href.scene(item.scene.id)}>
                  <span className="muted small">Part {item.videoPartIndex + 1}</span>
                  <span className="timecode">
                    {formatTimecode(item.scene.startSec)}–{formatTimecode(item.scene.endSec)}
                  </span>
                  <span>{item.eventTypeLabel ?? 'No category'}</span>
                  <span className="grow ellipsis muted">{item.scene.comment}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
