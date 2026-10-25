// Session details: the fields shared by "new session" and "edit session", the header shown on the
// session page, and a one-line summary reused on review screens.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ProfileSummaryDto, SessionDto, SessionType } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatBytes, formatDate } from '../format.ts';
import { href } from '../router.ts';
import { AthletePicker } from './AthletePicker.tsx';

export const TYPE_LABELS: Record<SessionType, string> = { match: 'Match', training: 'Training' };

export interface SessionFieldValues {
  title: string;
  type: SessionType;
  date: string;
  profileId: string;
  team: string;
  athletes: string[];
}

export function valuesOf(session: SessionDto): SessionFieldValues {
  return {
    title: session.title,
    type: session.type,
    date: session.date ?? '',
    profileId: session.sportProfileId ?? '',
    team: session.team ?? '',
    athletes: session.athletes.map((a) => a.name),
  };
}

/** Request body for creating or updating a session. */
export function bodyOf(values: SessionFieldValues) {
  return {
    title: values.title,
    type: values.type,
    date: values.date || null,
    sportProfileId: values.profileId || null,
    team: values.team,
    athletes: values.athletes,
  };
}

export function useActiveProfiles(): ProfileSummaryDto[] {
  const [profiles, setProfiles] = useState<ProfileSummaryDto[]>([]);
  useEffect(() => {
    api<{ profiles: ProfileSummaryDto[] }>('/profiles')
      .then((res) => setProfiles(res.profiles))
      .catch(() => setProfiles([]));
  }, []);
  return profiles;
}

export function SessionFields({
  values,
  onChange,
  profiles,
}: {
  values: SessionFieldValues;
  onChange: (values: SessionFieldValues) => void;
  /** Selectable profiles; may include the session's current (archived) one. */
  profiles: { id: string; name: string }[];
}) {
  const set = (patch: Partial<SessionFieldValues>) => onChange({ ...values, ...patch });
  return (
    <div className="stack">
      <label>
        Title
        <input
          value={values.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="e.g. HC Example vs. Demo Club"
          required
          maxLength={200}
        />
      </label>
      <div className="form-grid">
        <div className="field">
          <span className="field-label">Type</span>
          <div className="segmented" role="radiogroup" aria-label="Type">
            {(['match', 'training'] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={values.type === type}
                className={values.type === type ? 'selected' : undefined}
                onClick={() => set({ type })}
              >
                {type === 'match' ? 'Match / game' : 'Training / drills'}
              </button>
            ))}
          </div>
        </div>
        <label>
          Date
          <input type="date" value={values.date} onChange={(e) => set({ date: e.target.value })} />
        </label>
        <label>
          Sport profile
          <select value={values.profileId} onChange={(e) => set({ profileId: e.target.value })}>
            <option value="">None</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-grid two">
        <label>
          <span>
            Team <span className="muted small">optional</span>
          </span>
          <input value={values.team} onChange={(e) => set({ team: e.target.value })} maxLength={120} placeholder="e.g. U19" />
        </label>
        <div className="field">
          <span className="field-label">
            Athletes <span className="muted small">optional</span>
          </span>
          <AthletePicker value={values.athletes} onChange={(athletes) => set({ athletes })} />
        </div>
      </div>
    </div>
  );
}

/** "24.10.2026 · Match · Team U19 · Athletes: Mia K. · Profile: Ice Hockey Goalie" */
export function SessionInfo({ session, links = false }: { session: SessionDto; links?: boolean }) {
  const parts: ReactNode[] = [formatDate(session.date), TYPE_LABELS[session.type]];
  if (session.team) parts.push(`Team ${session.team}`);
  if (session.athletes.length > 0) {
    const names = session.athletes.map((a) => a.name).join(', ');
    parts.push(
      <>
        Athletes: {links ? <a href={href.athletes()}>{names}</a> : names}
      </>,
    );
  }
  parts.push(
    session.sportProfileId ? (
      <>Profile: {links ? <a href={href.profile(session.sportProfileId)}>{session.sportProfileName}</a> : session.sportProfileName}</>
    ) : (
      <span className="warning">No sport profile</span>
    ),
  );
  return (
    <span className="session-info">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part}
        </span>
      ))}
    </span>
  );
}

export function SessionSetup({ session, onSaved }: { session: SessionDto; onSaved: (session: SessionDto) => void }) {
  const [editing, setEditing] = useState(false);
  const profiles = useActiveProfiles();
  const [values, setValues] = useState(() => valuesOf(session));
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setValues(valuesOf(session));
    setError(null);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (
      session.sportProfileId &&
      values.profileId !== session.sportProfileId &&
      !confirm('Switch the sport profile? Existing scenes keep the profile they were tagged with.')
    ) {
      return;
    }
    try {
      const res = await api<{ session: SessionDto }>(`/sessions/${session.id}`, { method: 'PATCH', body: bodyOf(values) });
      onSaved(res.session);
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!editing) {
    return (
      <section className="card stack-sm">
        <div className="row wrap">
          <h1 className="grow">{session.title}</h1>
          <button onClick={startEditing}>Edit</button>
        </div>
        <div className="muted">
          <SessionInfo session={session} links /> · {formatBytes(session.totalBytes)}
        </div>
      </section>
    );
  }

  // Keep the current profile selectable even if it was archived in the meantime.
  const options =
    !session.sportProfileId || profiles.some((p) => p.id === session.sportProfileId)
      ? profiles
      : [...profiles, { id: session.sportProfileId, name: `${session.sportProfileName} (archived)` }];

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Edit session</h2>
      <SessionFields values={values} onChange={setValues} profiles={options} />
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button className="primary">Save</button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
