import { useEffect, useState, type FormEvent } from 'react';
import type { OrphanedGroupDto, SessionDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatBytes, formatDate } from '../format.ts';
import { href, navigate } from '../router.ts';
import { bodyOf, SessionFields, TYPE_LABELS, useActiveProfiles, type SessionFieldValues } from './SessionSetup.tsx';

/** Session selector sentinel meaning "create a new session" rather than picking an existing one. */
const NEW_SESSION = '\u0000new';

/** One group of videos found in storage with no session referencing them, with its import controls. */
function RecoveredGroup({
  group,
  sessions,
  onImported,
}: {
  group: OrphanedGroupDto;
  sessions: SessionDto[];
  onImported: () => void;
}) {
  const profiles = useActiveProfiles();
  const [target, setTarget] = useState(NEW_SESSION);
  const [values, setValues] = useState<SessionFieldValues>({
    title: '',
    type: 'match',
    date: today(),
    profileId: '',
    team: '',
    athletes: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profiles.length > 0) setValues((v) => (v.profileId ? v : { ...v, profileId: profiles[0].id }));
  }, [profiles]);

  const storageKeys = group.videos.map((v) => v.storageKey);

  const importInto = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/sessions/${sessionId}/recovered-videos`, { body: { storageKeys } });
      onImported();
      navigate(href.session(sessionId));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const createAndImport = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ session: SessionDto }>('/sessions', { body: bodyOf(values) });
      await importInto(res.session.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="card stack-sm">
      <div className="row wrap">
        <strong className="grow">
          {group.videos.length} video{group.videos.length === 1 ? '' : 's'} recovered · {formatBytes(group.totalBytes)}
        </strong>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          <option value={NEW_SESSION}>Create new session…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              Add to: {s.title}
            </option>
          ))}
        </select>
        {target !== NEW_SESSION && (
          <button disabled={busy} onClick={() => importInto(target)}>
            Import
          </button>
        )}
      </div>
      {target === NEW_SESSION && (
        <form className="stack-sm" onSubmit={createAndImport}>
          <SessionFields values={values} onChange={setValues} profiles={profiles} />
          <div className="row">
            <button className="primary" disabled={busy}>
              Create session &amp; import
            </button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function RecoveredVideos({
  groups,
  sessions,
  onImported,
}: {
  groups: OrphanedGroupDto[];
  sessions: SessionDto[];
  onImported: () => void;
}) {
  return (
    <section className="stack">
      <h2>Recovered videos found in storage</h2>
      <p className="muted small">
        These video files exist in storage but aren't linked to any session — usually left over from a
        database reset. Import them into a session to use them again.
      </p>
      {groups.map((g) => (
        <RecoveredGroup key={g.sourceSessionId} group={g} sessions={sessions} onImported={onImported} />
      ))}
    </section>
  );
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function NewSessionForm({ onCancel }: { onCancel: () => void }) {
  const profiles = useActiveProfiles();
  const [values, setValues] = useState<SessionFieldValues>({
    title: '',
    type: 'match',
    date: today(),
    profileId: '',
    team: '',
    athletes: [],
  });
  const [error, setError] = useState<string | null>(null);

  // Preselect the first active profile once the list has loaded.
  useEffect(() => {
    if (profiles.length > 0) setValues((v) => (v.profileId ? v : { ...v, profileId: profiles[0].id }));
  }, [profiles]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const res = await api<{ session: SessionDto }>('/sessions', { body: bodyOf(values) });
      navigate(href.session(res.session.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="card stack new-session" onSubmit={create}>
      <h2>New session</h2>
      <SessionFields values={values} onChange={setValues} profiles={profiles} />
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button className="primary">Create session</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [groups, setGroups] = useState<OrphanedGroupDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadSessions = () =>
    api<{ sessions: SessionDto[] }>('/sessions')
      .then((res) => {
        setSessions(res.sessions);
        if (res.sessions.length === 0) setCreating(true);
      })
      .catch((err) => setError(errorMessage(err)));

  // Non-critical: if this fails, the sessions list above still works fine without it.
  const loadRecovered = () =>
    api<{ groups: OrphanedGroupDto[] }>('/recovered-videos')
      .then((res) => setGroups(res.groups))
      .catch(() => setGroups([]));

  useEffect(() => {
    loadSessions();
    loadRecovered();
  }, []);

  const reload = () => {
    loadSessions();
    loadRecovered();
  };

  const totalBytes = sessions?.reduce((sum, s) => sum + s.totalBytes, 0) ?? 0;

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <h1 className="grow">Sessions</h1>
        {sessions && <span className="muted">{formatBytes(totalBytes)} stored</span>}
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            New session
          </button>
        )}
      </div>

      {creating && <NewSessionForm onCancel={() => setCreating(false)} />}
      {error && <p className="error">{error}</p>}

      {groups.length > 0 && sessions && <RecoveredVideos groups={groups} sessions={sessions} onImported={reload} />}

      <section className="card">
        {sessions?.length === 0 && <p className="muted">No sessions yet. Create one to upload videos.</p>}
        {sessions && sessions.length > 0 && (
          <div className="table-scroll">
            <table className="clickable-rows">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Profile</th>
                  <th className="num">Videos</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    tabIndex={0}
                    onClick={() => navigate(href.session(s.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(href.session(s.id));
                    }}
                  >
                    <td>
                      <a href={href.session(s.id)} tabIndex={-1}>
                        {s.title}
                      </a>
                    </td>
                    <td>{formatDate(s.date)}</td>
                    <td>{TYPE_LABELS[s.type]}</td>
                    <td>{s.sportProfileName ?? '—'}</td>
                    <td className="num">{s.videoCount}</td>
                    <td className="num">{formatBytes(s.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
