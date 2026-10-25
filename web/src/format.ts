export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 5025 → "1:23:45"; 83 → "1:23". */
export function formatDuration(totalSec: number): string {
  const sec = Math.round(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 83.47 → "1:23.4" (tenths, truncated so a trim point never displays later than it is). */
export function formatTimecode(totalSec: number): string {
  const tenths = Math.floor(totalSec * 10) % 10;
  return `${formatDuration(Math.floor(totalSec))}.${tenths}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "2026-10-24" or an ISO timestamp → "24.10.2026". */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // A plain date has no time zone; parse it as local so it never shifts by a day.
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** 83.476 → "1:23.47" (hundredths, for frame-level trimming). */
export function formatPrecise(totalSec: number): string {
  const hundredths = Math.floor(Math.round(totalSec * 1000) / 10) % 100;
  return `${formatDuration(Math.floor(totalSec))}.${String(hundredths).padStart(2, '0')}`;
}

/** ISO timestamp → "24.10.2026, 14:05" (local time). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(iso)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
