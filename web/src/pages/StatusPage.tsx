import { useEffect, useState } from 'react';
import type { HealthDto } from '../../../shared/types.ts';
import { errorMessage } from '../api.ts';
import { formatDateTime } from '../format.ts';

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div className="row wrap">
      <span className="grow">{label}</span>
      <span className={ok ? 'ok' : 'error'}>{ok ? 'OK' : (detail ?? 'Unreachable')}</span>
    </div>
  );
}

export function StatusPage() {
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // A plain fetch, not the `api()` helper: /api/health returns a meaningful body on a 503 too
  // (the whole point is to show which check failed), but `api()` throws away the body on any
  // non-2xx response.
  const check = () => {
    setChecking(true);
    setError(null);
    fetch('/api/health')
      .then((res) => res.json() as Promise<HealthDto>)
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
            <CheckRow label="Upload CORS policy" ok={health.cors.ok} detail={health.cors.reason} />
            <CheckRow label="Server clock" ok={health.clockSkew.ok} detail={health.clockSkew.reason} />
            <p className="muted small">
              {health.ok ? 'Everything looks fine.' : 'Something is unreachable — check the server logs for details.'}{' '}
              {!health.cors.ok && 'The CORS policy issue above will block uploads even when everything else is fine. '}
              {!health.clockSkew.ok &&
                'A skewed clock makes upload URLs expire early or immediately, which looks like a CORS/network error. '}
              Last checked {formatDateTime(health.checkedAt)}.
            </p>
          </>
        )}
        {error && <p className="error">Could not reach the server: {error}</p>}
      </section>
    </div>
  );
}
