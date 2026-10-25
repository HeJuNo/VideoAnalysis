// Choose a session's athletes from the existing ones, or add a new one by name. The server links
// names to athlete records and creates the new ones when the session is saved.
import { useEffect, useState } from 'react';
import type { AthleteDto } from '../../../shared/types.ts';
import { api } from '../api.ts';

const NEW = '\u0000new';

export function AthletePicker({ value, onChange }: { value: string[]; onChange: (names: string[]) => void }) {
  const [athletes, setAthletes] = useState<AthleteDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    api<{ athletes: AthleteDto[] }>('/athletes')
      .then((res) => setAthletes(res.athletes))
      .catch(() => setAthletes([]));
  }, []);

  const chosen = new Set(value.map((n) => n.toLowerCase()));
  const available = athletes.filter((a) => !chosen.has(a.name.toLowerCase()));

  const add = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Reuse the existing spelling when the name is already known.
    const existing = athletes.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
    const finalName = existing?.name ?? trimmed;
    if (!chosen.has(finalName.toLowerCase())) onChange([...value, finalName]);
  };

  const finishAdding = () => {
    add(newName);
    setNewName('');
    setAdding(false);
  };

  return (
    <div className="athlete-picker chips">
      {value.map((name) => (
        <span key={name} className="chip selected removable">
          {name}
          <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(value.filter((n) => n !== name))}>
            ✕
          </button>
        </span>
      ))}
      {adding ? (
        <span className="row">
          <input
            autoFocus
            value={newName}
            maxLength={120}
            placeholder="Name of the new athlete"
            aria-label="New athlete"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                finishAdding();
              }
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <button type="button" onClick={finishAdding} disabled={!newName.trim()}>
            Add
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <select
          value=""
          aria-label="Add athlete"
          onChange={(e) => {
            if (e.target.value === NEW) setAdding(true);
            else add(e.target.value);
          }}
        >
          <option value="">Add athlete…</option>
          {available.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
          <option value={NEW}>+ New athlete…</option>
        </select>
      )}
    </div>
  );
}
