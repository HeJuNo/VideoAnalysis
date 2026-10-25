import { useEffect, useState, type FormEvent } from 'react';
import type { SessionDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatBytes, formatDate } from '../format.ts';
import { href, navigate } from '../router.ts';
import { bodyOf, SessionFields, TYPE_LABELS, useActiveProfiles, type SessionFieldValues } from './SessionSetup.tsx';

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
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<{ sessions: SessionDto[] }>('/sessions')
      .then((res) => {
        setSessions(res.sessions);
        if (res.sessions.length === 0) setCreating(true);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

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
