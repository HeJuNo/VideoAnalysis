// Zoomed timeline around one scene with draggable start/end handles. Handles snap to frames;
// while dragging, the video shows the frame under the handle.
import { useRef, useState, type PointerEvent } from 'react';
import { formatPrecise } from '../format.ts';

interface Props {
  start: number;
  end: number;
  time: number;
  fps: number;
  /** Playable part of the video (after trimming). */
  min: number;
  max: number;
  onChange: (start: number, end: number) => void;
  onSeek: (sec: number) => void;
}

type Handle = 'start' | 'end';

export function SceneRangeEditor({ start, end, time, fps, min, max, onChange, onSeek }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  // The visible window is fixed while dragging, otherwise it would move under the pointer.
  const [frozen, setFrozen] = useState<{ from: number; to: number } | null>(null);
  const frame = 1 / fps;
  const snap = (sec: number) => Math.round(sec * fps) / fps;

  const pad = Math.max(5, (end - start) * 0.5);
  const view = frozen ?? { from: Math.max(min, start - pad), to: Math.min(max, end + pad) };
  const span = Math.max(view.to - view.from, frame);
  const pct = (sec: number) => `${((Math.min(Math.max(sec, view.from), view.to) - view.from) / span) * 100}%`;

  const set = (handle: Handle, sec: number) => {
    const value = snap(Math.min(Math.max(sec, min), max));
    if (handle === 'start') onChange(Math.min(value, end - frame), end);
    else onChange(start, Math.max(value, start + frame));
    onSeek(handle === 'start' ? Math.min(value, end - frame) : Math.max(value, start + frame));
  };

  const secAt = (event: { clientX: number }) => {
    const rect = bar.current!.getBoundingClientRect();
    return view.from + ((event.clientX - rect.left) / rect.width) * span;
  };

  const dragProps = (handle: Handle) => ({
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setFrozen(view);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) set(handle, secAt(event));
    },
    onPointerUp: () => setFrozen(null),
  });

  return (
    <div className="range-editor stack-sm">
      <div
        ref={bar}
        className="range-bar"
        onClick={(event) => {
          if (event.target === bar.current) onSeek(secAt(event));
        }}
      >
        <div className="range-selected" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
        <div className="range-handle" style={{ left: pct(start) }} aria-label="Scene start" role="slider" aria-valuenow={start} {...dragProps('start')} />
        <div className="range-handle" style={{ left: pct(end) }} aria-label="Scene end" role="slider" aria-valuenow={end} {...dragProps('end')} />
        <div className="playhead" style={{ left: pct(time) }} />
      </div>
      <div className="row wrap small">
        <span className="edit-label">Start</span>
        <span className="timecode">{formatPrecise(start)}</span>
        <button onClick={() => set('start', start - frame)} aria-label="Start one frame earlier">
          −1 frame
        </button>
        <button onClick={() => set('start', start + frame)} aria-label="Start one frame later">
          +1 frame
        </button>
        <button onClick={() => set('start', time)}>Set to playhead</button>
        <span className="spacer" />
        <span className="edit-label">End</span>
        <span className="timecode">{formatPrecise(end)}</span>
        <button onClick={() => set('end', end - frame)} aria-label="End one frame earlier">
          −1 frame
        </button>
        <button onClick={() => set('end', end + frame)} aria-label="End one frame later">
          +1 frame
        </button>
        <button onClick={() => set('end', time)}>Set to playhead</button>
      </div>
    </div>
  );
}
