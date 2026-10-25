import { useEffect, useState, type FormEvent } from 'react';
import type { ProfileDefinition } from '../../../shared/profile.ts';
import type { ProfileDto, ProfileSummaryDto, UserDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatDate } from '../format.ts';
import { href, navigate } from '../router.ts';

// The API requires at least one event type, so a blank profile starts with a placeholder.
const BLANK: ProfileDefinition = {
  eventTypes: [{ key: 'event', label: 'Event', color: '#1f6feb', hotkey: 'e', kind: 'scene' }],
  attributes: [],
  diagrams: [],
};

export function ProfilesPage({ user }: { user: UserDto }) {
  const [profiles, setProfiles] = useState<ProfileSummaryDto[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [copyFrom, setCopyFrom] = useState('');

  useEffect(() => {
    api<{ profiles: ProfileSummaryDto[] }>(`/profiles${showArchived ? '?archived=1' : ''}`)
      .then((res) => setProfiles(res.profiles))
      .catch((err) => setError(errorMessage(err)));
  }, [showArchived]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const body = copyFrom ? { name, copyFrom } : { name, sport, definition: BLANK };
      const res = await api<{ profile: ProfileDto }>('/profiles', { body });
      navigate(href.profile(res.profile.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const active = profiles?.filter((p) => !p.archivedAt) ?? [];

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <h1 className="grow">Sport profiles</h1>
        <label className="row small inline-label">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <p className="muted">
        A profile defines what can be tagged in a session: event types, the attributes analysts fill in, and click
        diagrams for positions. Changes create a new version; scenes keep the version they were recorded with.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="card">
        {profiles?.length === 0 && <p className="muted">No profiles yet.</p>}
        {profiles && profiles.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sport</th>
                  <th className="num">Version</th>
                  <th className="num">Sessions</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={href.profile(p.id)}>{p.name}</a>
                      {p.archivedAt && <span className="badge badge-unsupported small-gap">Archived</span>}
                    </td>
                    <td>{p.sport}</td>
                    <td className="num">{p.currentVersion}</td>
                    <td className="num">{p.sessionCount}</td>
                    <td>{formatDate(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {user.role === 'analyst' && (
        <section className="card">
          <h2>New profile</h2>
          <form className="row wrap" onSubmit={create}>
            <input
              className="grow"
              placeholder="Name, e.g. Handball Goalkeeper"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} aria-label="Start from">
              <option value="">Start empty</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  Copy of {p.name}
                </option>
              ))}
            </select>
            {!copyFrom && (
              <input placeholder="Sport" value={sport} onChange={(e) => setSport(e.target.value)} required maxLength={60} />
            )}
            <button className="primary">Create</button>
          </form>
        </section>
      )}
    </div>
  );
}
