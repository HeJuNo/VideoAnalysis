// Game periods (thirds, halves …) from "period start"/"period end" markers, and per-period counts
// of marked events.
import type { EventKind } from './profile.ts';

export interface TimedMark {
  startSec: number;
  eventTypeKey: string | null;
}

export interface Period {
  /** 1-based, in time order. */
  number: number;
  start: number;
  /** null: runs to the end of the video. */
  end: number | null;
}

export type KindOf = (eventTypeKey: string | null) => EventKind | null;

/**
 * A start marker opens a period (closing an open one); an end marker closes it. An end marker
 * before any start means the recording began mid-period, so that period starts at 0.
 */
export function periodsOf(marks: TimedMark[], kindOf: KindOf): Period[] {
  const periods: Period[] = [];
  let open: Period | null = null;
  const boundaries = marks
    .filter((m) => {
      const kind = kindOf(m.eventTypeKey);
      return kind === 'period-start' || kind === 'period-end';
    })
    .sort((a, b) => a.startSec - b.startSec);

  for (const mark of boundaries) {
    if (kindOf(mark.eventTypeKey) === 'period-start') {
      if (open) open.end = mark.startSec;
      open = { number: periods.length + 1, start: mark.startSec, end: null };
      periods.push(open);
    } else if (open) {
      open.end = mark.startSec;
      open = null;
    } else if (periods.length === 0) {
      periods.push({ number: 1, start: 0, end: mark.startSec });
    }
  }
  return periods;
}

export function periodAt(periods: Period[], sec: number): Period | null {
  return periods.find((p) => sec >= p.start && (p.end === null || sec < p.end)) ?? null;
}

/** How often each event type was marked (period markers themselves are not counted). */
export function countEvents(marks: TimedMark[], kindOf: KindOf, within?: Period | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mark of marks) {
    if (!mark.eventTypeKey) continue;
    const kind = kindOf(mark.eventTypeKey);
    if (kind !== 'scene' && kind !== 'moment') continue;
    if (within && (mark.startSec < within.start || (within.end !== null && mark.startSec >= within.end))) continue;
    counts.set(mark.eventTypeKey, (counts.get(mark.eventTypeKey) ?? 0) + 1);
  }
  return counts;
}
