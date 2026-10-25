// Video with non-destructive edits applied: rotation via CSS, trim by keeping playback and
// seeking inside the range. Uses its own controls because native ones would rotate with the picture.
//
// Keyboard (when `shortcuts` is on): Space play/pause (or `playKey`) · ←/→ 5 s (Shift: 10 s)
// · , / . one frame · ↑/↓ speed · = / - zoom. Letters stay free for the tagger's event hotkeys.
// Pan and zoom (usePanZoom) are a viewing aid and are not stored with the video.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Rotation } from '../../../shared/types.ts';
import { formatTimecode } from '../format.ts';
import { MAX_ZOOM, usePanZoom } from './usePanZoom.ts';

export interface PlayRange {
  start: number;
  /** null: to the end of the file. */
  end: number | null;
}

interface Props {
  src: string;
  rotation: Rotation;
  range: PlayRange;
  /** true: playback and seeking stay inside `range`. false (editing): the whole file, range only shown. */
  constrained: boolean;
  /** Frame rate for frame stepping; 30 is assumed when unknown. */
  fps?: number | null;
  shortcuts?: boolean;
  /** Key that toggles playback; the tagger uses Enter because Space marks a moment there. */
  playKey?: ' ' | 'Enter';
  /** Aspect ratio to use until the browser has read the video's real size. */
  initialSize?: { width: number; height: number } | null;
  onTime?: (sec: number) => void;
  onError?: (el: HTMLVideoElement) => void;
  onLoaded?: (el: HTMLVideoElement) => void;
}

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const DEFAULT_FPS = 30;

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

/** Keys typed into a field must not trigger shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * A focused button would also react to Space/Enter (on key-up) after we handled the key as a
 * shortcut, e.g. clicking "Pause" and then pressing Space would pause and play again.
 */
export function releaseButtonFocus(): void {
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
}

export function VideoStage({
  src,
  rotation,
  range,
  constrained,
  fps,
  shortcuts = false,
  playKey = ' ',
  initialSize,
  onTime,
  onError,
  onLoaded,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState(() =>
    initialSize?.width && initialSize.height ? initialSize : { width: 16, height: 9 },
  );
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const panZoom = usePanZoom(stage, box, src);
  const zoomed = panZoom.view.scale > 1;

  const rangeEnd = range.end ?? duration;
  const lo = constrained ? range.start : 0;
  const hi = constrained ? rangeEnd : duration;

  // Track the stage size (also in fullscreen) to fit the rotated picture into it.
  useLayoutEffect(() => {
    const el = stage.current!;
    // Measure before the first paint, so a rotated video never shows briefly at the wrong size.
    const rect = el.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // timeupdate fires only ~4 times a second; check every frame so playback stops right at the trim end.
  useEffect(() => {
    const end = range.end;
    if (!playing || !constrained || end === null) return;
    let frame = requestAnimationFrame(function check() {
      const el = video.current;
      if (el && el.currentTime >= end) {
        el.pause();
        el.currentTime = end;
        return;
      }
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, constrained, range.end]);

  // Leaving edit mode or changing the range moves the playhead back inside the range.
  useEffect(() => {
    const el = video.current;
    if (!el || !constrained || el.readyState === 0) return;
    if (el.currentTime < range.start || (range.end !== null && el.currentTime > range.end)) {
      el.currentTime = range.start;
    }
  }, [constrained, range.start, range.end]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
  }, [speed]);

  const togglePlay = () => {
    const el = video.current;
    if (!el) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    if (constrained && range.end !== null && el.currentTime >= range.end - 0.05) el.currentTime = range.start;
    void el.play();
  };

  const seek = (sec: number) => {
    if (video.current) video.current.currentTime = clamp(sec, lo, hi);
  };

  const seekBy = (delta: number) => {
    if (video.current) seek(video.current.currentTime + delta);
  };

  // Lands just inside the target frame, so the browser shows that frame and not its neighbour.
  const stepFrame = (direction: 1 | -1) => {
    const el = video.current;
    if (!el) return;
    el.pause();
    const rate = fps && fps > 0 ? fps : DEFAULT_FPS;
    const frame = Math.round(el.currentTime * rate);
    seek((frame + direction) / rate + 0.001);
  };

  const changeSpeed = (direction: 1 | -1) =>
    setSpeed((s) => SPEEDS[clamp(SPEEDS.indexOf(s) + direction, 0, SPEEDS.length - 1)]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen();
  };

  // The key handler is registered once; it always calls the latest versions of these actions.
  const zoomBy = panZoom.zoomBy;
  const actions = useRef({ togglePlay, seekBy, stepFrame, changeSpeed, zoomBy });
  actions.current = { togglePlay, seekBy, stepFrame, changeSpeed, zoomBy };

  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const a = actions.current;
      const handled = (() => {
        if (event.key === playKey) {
          a.togglePlay();
          return true;
        }
        switch (event.key) {
          case 'ArrowLeft':
            a.seekBy(event.shiftKey ? -10 : -5);
            return true;
          case 'ArrowRight':
            a.seekBy(event.shiftKey ? 10 : 5);
            return true;
          case ',':
            a.stepFrame(-1);
            return true;
          case '.':
            a.stepFrame(1);
            return true;
          case 'ArrowUp':
            a.changeSpeed(1);
            return true;
          case 'ArrowDown':
            a.changeSpeed(-1);
            return true;
          case '=':
          case '+':
            a.zoomBy(1.25);
            return true;
          case '-':
            a.zoomBy(0.8);
            return true;
          default:
            return false;
        }
      })();
      if (handled) {
        event.preventDefault();
        releaseButtonFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts, playKey]);

  // Fit the picture as displayed (width/height swapped at 90°/270°) into the stage, then size the
  // unrotated <video> box so that after rotating it covers exactly that area.
  const rotated = rotation % 180 !== 0;
  const displayRatio = rotated ? size.height / size.width : size.width / size.height;
  let videoStyle: CSSProperties = { width: '100%', height: '100%' };
  if (box && box.width > 0 && box.height > 0) {
    const fitWidth = box.width / box.height > displayRatio ? box.height * displayRatio : box.width;
    const fitHeight = fitWidth / displayRatio;
    videoStyle = rotated ? { width: fitHeight, height: fitWidth } : { width: fitWidth, height: fitHeight };
  }

  const shownTime = constrained ? clamp(time, lo, hi) - lo : time;
  const shownTotal = constrained ? Math.max(0, hi - lo) : duration;

  return (
    <div ref={root} className="video-stage">
      <div
        ref={stage}
        className={`stage${zoomed ? ' zoomed' : ''}`}
        style={{ aspectRatio: displayRatio, width: `min(100%, calc(70vh * ${displayRatio}))` }}
        {...panZoom.handlers}
        onClick={() => {
          if (!panZoom.consumeClick()) togglePlay();
        }}
        onDoubleClick={() => zoomed && panZoom.reset()}
      >
        <div
          className="zoom-layer"
          style={{ transform: `translate(${panZoom.view.x}px, ${panZoom.view.y}px) scale(${panZoom.view.scale})` }}
        >
          <video
            ref={video}
            src={src}
            playsInline
            preload="metadata"
            style={{ ...videoStyle, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0) setSize({ width: el.videoWidth, height: el.videoHeight });
              setDuration(el.duration);
              // A new source resets the rate to the default.
              el.defaultPlaybackRate = speed;
              el.playbackRate = speed;
              if (constrained && range.start > 0) el.currentTime = range.start;
              onLoaded?.(el);
            }}
            onTimeUpdate={(e) => {
              setTime(e.currentTarget.currentTime);
              onTime?.(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => {
              setTime(e.currentTarget.currentTime);
              onTime?.(e.currentTarget.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={(e) => onError?.(e.currentTarget)}
          />
        </div>
      </div>
      <div className="timeline">
        {!constrained && duration > 0 && (
          <>
            <div className="trim-out" style={{ left: 0, width: `${(range.start / duration) * 100}%` }} />
            {range.end !== null && <div className="trim-out" style={{ left: `${(range.end / duration) * 100}%`, right: 0 }} />}
          </>
        )}
        <input
          type="range"
          aria-label="Position"
          min={lo}
          max={hi || 0}
          step={0.01}
          value={clamp(time, lo, hi || 0)}
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
      <div className="controls">
        <button className="play" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="button-group">
          <button onClick={() => seekBy(-10)} title="Back 10 s (Shift+←)">
            −10s
          </button>
          <button onClick={() => seekBy(-5)} title="Back 5 s (←)">
            −5s
          </button>
          <button onClick={() => stepFrame(-1)} title="Previous frame (,)" aria-label="Previous frame">
            ◀︎ frame
          </button>
          <button onClick={() => stepFrame(1)} title="Next frame (.)" aria-label="Next frame">
            frame ▶︎
          </button>
          <button onClick={() => seekBy(5)} title="Forward 5 s (→)">
            +5s
          </button>
          <button onClick={() => seekBy(10)} title="Forward 10 s (Shift+→)">
            +10s
          </button>
        </span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed" title="Speed (↑/↓)">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <span className="button-group" aria-label="Zoom">
          <button onClick={() => panZoom.zoomBy(0.8)} disabled={!zoomed} title="Zoom out (-)" aria-label="Zoom out">
            −
          </button>
          <button
            className="zoom-level"
            onClick={panZoom.reset}
            disabled={!zoomed}
            title="Reset zoom (or double-click the picture)"
          >
            {Math.round(panZoom.view.scale * 100)}%
          </button>
          <button
            onClick={() => panZoom.zoomBy(1.25)}
            disabled={panZoom.view.scale >= MAX_ZOOM}
            title="Zoom in (=)"
            aria-label="Zoom in"
          >
            +
          </button>
        </span>
        <span className="timecode grow">
          {formatTimecode(shownTime)} / {formatTimecode(shownTotal)}
        </span>
        <button onClick={toggleFullscreen}>Fullscreen</button>
      </div>
      {shortcuts && (
        <p className="muted small shortcuts">
          <kbd>{playKey === ' ' ? 'Space' : playKey}</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> 5 s (<kbd>Shift</kbd> 10 s) · <kbd>,</kbd>/<kbd>.</kbd> frame ·{' '}
          <kbd>↑</kbd>/<kbd>↓</kbd> speed · <kbd>=</kbd>/<kbd>-</kbd> or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+scroll zoom, drag
          to pan, double-click resets
        </p>
      )}
    </div>
  );
}
