import { useState, type FormEvent } from 'react';
import type { UserDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';

export function LoginPage({ onLogin }: { onLogin: (user: UserDto) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: UserDto }>('/auth/login', { body: { email, password } });
      onLogin(res.user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <h1>Video Analysis</h1>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
