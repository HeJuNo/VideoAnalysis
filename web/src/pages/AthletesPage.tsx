import { useEffect, useState, type FormEvent } from 'react';
import type { CatchHand } from '../../../shared/goal-zones.ts';
import type { AthleteDto, AthleteUsageDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { EditableText } from '../components.tsx';

export function AthletesPage() {
  const [athletes, setAthletes] = useState<AthleteUsageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = () =>
    api<{ athletes: AthleteUsageDto[] }>('/athletes')
      .then((res) => setAthletes(res.athletes))
      .catch((err) => setError(errorMessage(err)));

  useEffect(() => {
    void load();
  }, []);

  const patch = async (athlete: AthleteDto, body: { name?: string; catchHand?: CatchHand | null }) => {
    const res = await api<{ athlete: AthleteDto }>(`/athletes/${athlete.id}`, { method: 'PATCH', body });
    setAthletes((list) => list?.map((a) => (a.id === athlete.id ? { ...a, ...res.athlete } : a)) ?? null);
  };

  const remove = async (athlete: AthleteUsageDto) => {
    if (!confirm(`Delete ${athlete.name}?`)) return;
    try {
      await api(`/athletes/${athlete.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api('/athletes', { body: { name } });
      setName('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="stack-lg">
      <div>
        <h1>Athletes</h1>
        <p className="muted">
          Athletes are added automatically when you name them in a session. The catching hand (goalies) or dominant hand
          lets the app name goal zones “glove side” and “blocker side”.
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      <section className="card">
        {athletes?.length === 0 && <p className="muted">No athletes yet.</p>}
        {athletes && athletes.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Catching / dominant hand</th>
                  <th className="num">Sessions</th>
                  <th className="num">Scenes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {athletes.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <EditableText value={a.name} label="athlete" maxLength={120} onSave={(n) => patch(a, { name: n })} />
                    </td>
                    <td>
                      <select
                        value={a.catchHand ?? ''}
                        onChange={(e) =>
                          patch(a, { catchHand: (e.target.value || null) as CatchHand | null }).catch((err) =>
                            setError(errorMessage(err)),
                          )
                        }
                        aria-label={`Hand of ${a.name}`}
                      >
                        <option value="">Not set</option>
                        <option value="left">Left</option>
                        <option value="right">Right</option>
                      </select>
                    </td>
                    <td className="num">{a.sessionCount}</td>
                    <td className="num">{a.sceneCount}</td>
                    <td className="actions">
                      {a.sessionCount === 0 && a.sceneCount === 0 ? (
                        <button onClick={() => remove(a)}>Delete</button>
                      ) : (
                        <span className="muted small" title="Remove the athlete from its sessions and scenes first">
                          in use
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>New athlete</h2>
        <form className="row wrap" onSubmit={add}>
          <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required maxLength={120} />
          <button className="primary">Add</button>
        </form>
      </section>
    </div>
  );
}
