// Whole-video timeline with colour-coded scene segments. Overlapping scenes get their own lane.
import type { MouseEvent } from 'react';
import type { LocalScene } from '../../../shared/scene-outbox.ts';

const UNCATEGORISED = '#8b949e';
const MAX_LANES = 4;

interface Props {
  scenes: LocalScene[];
  /** Point-in-time marks (moments, period start/end), drawn as lines instead of segments. */
  isPoint: (scene: LocalScene) => boolean;
  duration: number;
  time: number;
  colors: Record<string, string>;
  selectedRef: string | null;
  /** Shaded parts outside the trimmed range. */
  playable: { start: number; end: number };
  onSelect: (scene: LocalScene) => void;
  onSeek: (sec: number) => void;
}

/** Greedy lane assignment: each scene goes into the first lane that is free at its start. */
function assignLanes(scenes: LocalScene[]): Map<string, number> {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const scene of scenes) {
    let lane = laneEnds.findIndex((end) => end <= scene.startSec);
    if (lane === -1) lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1;
    laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, scene.endSec);
    lanes.set(scene.ref, lane);
  }
  return lanes;
}

export function SceneTimeline({ scenes, isPoint, duration, time, colors, selectedRef, playable, onSelect, onSeek }: Props) {
  if (duration <= 0) return <div className="scene-timeline empty" />;
  const points = scenes.filter(isPoint);
  const ranges = scenes.filter((s) => !isPoint(s));
  const lanes = assignLanes(ranges);
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const pct = (sec: number) => `${(Math.min(Math.max(sec, 0), duration) / duration) * 100}%`;

  const seekFromClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(((event.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <div
      className="scene-timeline"
      style={{ height: `${laneCount * 14 + 8}px` }}
      onClick={seekFromClick}
      role="presentation"
    >
      {playable.start > 0 && <div className="timeline-out" style={{ left: 0, width: pct(playable.start) }} />}
      {playable.end < duration && <div className="timeline-out" style={{ left: pct(playable.end), right: 0 }} />}
      {ranges.map((scene) => (
        <button
          key={scene.ref}
          className={`segment${scene.ref === selectedRef ? ' selected' : ''}${scene.pending ? ' pending' : ''}`}
          style={{
            left: pct(scene.startSec),
            width: `max(4px, ${((scene.endSec - scene.startSec) / duration) * 100}%)`,
            top: `${4 + (lanes.get(scene.ref) ?? 0) * 14}px`,
            background: scene.eventTypeKey ? (colors[scene.eventTypeKey] ?? UNCATEGORISED) : UNCATEGORISED,
          }}
          title={scene.comment ?? undefined}
          aria-label={`Scene at ${Math.round(scene.startSec)} s`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(scene);
          }}
        />
      ))}
      {points.map((scene) => (
        <button
          key={scene.ref}
          className={`point-mark${scene.ref === selectedRef ? ' selected' : ''}${scene.pending ? ' pending' : ''}`}
          style={{
            left: pct(scene.startSec),
            background: scene.eventTypeKey ? (colors[scene.eventTypeKey] ?? UNCATEGORISED) : UNCATEGORISED,
          }}
          title={scene.comment ?? undefined}
          aria-label={`Marker at ${Math.round(scene.startSec)} s`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(scene);
          }}
        />
      ))}
      <div className="playhead" style={{ left: pct(time) }} />
    </div>
  );
}
