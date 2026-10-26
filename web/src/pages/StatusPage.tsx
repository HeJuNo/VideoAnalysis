import { useEffect, useState } from 'react';
import type { HealthDto } from '../../../shared/types.ts';
import { api, errorMessage } from '../api.ts';
import { formatDateTime } from '../format.ts';

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="row">
      <span className="grow">{label}</span>
      <span className={ok ? 'ok' : 'error'}>{ok ? 'OK' : 'Unreachable'}</span>
    </div>
  );
}

export function StatusPage() {
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = () => {
    setChecking(true);
    setError(null);
    api<HealthDto>('/health')
      .then(setHealth)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setChecking(false));
  };

  useEffect(check, []);

  return (
    <div className="stack-lg">
      <div className="row wrap">
        <h1 className="grow">Status</h1>
        <button onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <section className="card stack-sm">
        {health && (
          <>
            <CheckRow label="Database" ok={health.database.ok} />
            <CheckRow label="Object storage (S3)" ok={health.storage.ok} />
            <p className="muted small">
              {health.ok ? 'Everything looks fine.' : 'Something is unreachable — check the server logs for details.'}{' '}
              Last checked {formatDateTime(health.checkedAt)}.
            </p>
          </>
        )}
        {error && <p className="error">Could not reach the server: {error}</p>}
      </section>
    </div>
  );
}
