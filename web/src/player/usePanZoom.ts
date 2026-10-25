// Pan and zoom for the video stage. A viewing aid only: nothing is stored with the video.
//
// Zoom: Ctrl/⌘ + wheel or trackpad pinch (zooms around the pointer), two-finger pinch on touch
// screens, or zoomBy() from buttons/keys (zooms around the centre). Pan: drag while zoomed.
// A drag never counts as a click, so clicking the picture can still play/pause.
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

export interface PanZoomView {
  scale: number;
  /** Offset of the zoomed picture from the stage centre, in screen pixels. */
  x: number;
  y: number;
}

export const MAX_ZOOM = 8;
const IDENTITY: PanZoomView = { scale: 1, x: 0, y: 0 };
const DRAG_THRESHOLD_PX = 4;

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

/** Keeps the picture covering the stage: no panning past its edges, no zooming below 100 %. */
function constrain(view: PanZoomView, box: { width: number; height: number } | null): PanZoomView {
  const scale = clamp(view.scale, 1, MAX_ZOOM);
  if (!box || scale === 1) return IDENTITY;
  const maxX = ((scale - 1) * box.width) / 2;
  const maxY = ((scale - 1) * box.height) / 2;
  return { scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

interface Gesture {
  start: { x: number; y: number };
  moved: boolean;
  pinch: { distance: number; scale: number; mid: { x: number; y: number } } | null;
}

export function usePanZoom(
  stage: RefObject<HTMLDivElement | null>,
  box: { width: number; height: number } | null,
  resetKey: unknown,
) {
  const [view, setView] = useState<PanZoomView>(IDENTITY);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const boxRef = useRef(box);
  boxRef.current = box;

  /**
   * Zooms to the scale `scaleFrom` returns for the current one, keeping the screen point
   * (clientX, clientY) still; the stage centre by default. Computing from the current scale
   * inside the update makes quick successive wheel events compound correctly.
   */
  const zoom = (scaleFrom: (current: number) => number, clientX?: number, clientY?: number) =>
    setView((current) => {
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return current;
      const next = clamp(scaleFrom(current.scale), 1, MAX_ZOOM);
      const px = clientX === undefined ? 0 : clientX - (rect.left + rect.width / 2);
      const py = clientY === undefined ? 0 : clientY - (rect.top + rect.height / 2);
      const ratio = next / current.scale;
      return constrain({ scale: next, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }, boxRef.current);
    });

  const zoomBy = (factor: number, clientX?: number, clientY?: number) => zoom((s) => s * factor, clientX, clientY);

  const reset = () => setView(IDENTITY);

  // A new video starts unzoomed.
  useEffect(() => setView(IDENTITY), [resetKey]);

  // Keep the view valid when the stage is resized (window, fullscreen, rotation).
  useEffect(() => setView((current) => constrain(current, box)), [box]);

  // Wheel needs a non-passive listener to stop the page from zooming or scrolling.
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // Trackpad pinches send small deltas, mouse wheels large ones; both feel smooth this way.
      zoomByRef.current(Math.exp(-clamp(event.deltaY, -50, 50) * 0.01), event.clientX, event.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stage]);

  const pinchOf = (): Gesture['pinch'] => {
    const [a, b] = [...pointers.current.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: scaleRef.current,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (pointers.current.size === 1) {
        gesture.current = { start: { x: event.clientX, y: event.clientY }, moved: false, pinch: null };
      } else if (pointers.current.size === 2 && gesture.current) {
        gesture.current.pinch = pinchOf();
        gesture.current.moved = true;
      }
    },

    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const previous = pointers.current.get(event.pointerId);
      const g = gesture.current;
      if (!previous || !g) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.current.size >= 2 && g.pinch) {
        const now = pinchOf()!;
        const target = g.pinch.scale * (now.distance / g.pinch.distance);
        zoom(() => target, now.mid.x, now.mid.y);
        const dx = now.mid.x - g.pinch.mid.x;
        const dy = now.mid.y - g.pinch.mid.y;
        g.pinch.mid = now.mid;
        setView((current) => constrain({ ...current, x: current.x + dx, y: current.y + dy }, boxRef.current));
        return;
      }

      if (!g.moved && Math.hypot(event.clientX - g.start.x, event.clientY - g.start.y) > DRAG_THRESHOLD_PX) g.moved = true;
      if (g.moved && scaleRef.current > 1) {
        const dx = event.clientX - previous.x;
        const dy = event.clientY - previous.y;
        setView((current) => constrain({ ...current, x: current.x + dx, y: current.y + dy }, boxRef.current));
      }
    },

    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size === 0) {
        suppressClick.current = gesture.current?.moved ?? false;
        gesture.current = null;
      } else if (gesture.current) {
        // One finger left after a pinch: continue as a pan from here.
        gesture.current.pinch = null;
      }
    },

    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size === 0) gesture.current = null;
    },
  };

  /** True once after a drag or pinch, so the click that ends it does not play/pause. */
  const consumeClick = () => {
    const suppress = suppressClick.current;
    suppressClick.current = false;
    return suppress;
  };

  return { view, zoomBy, reset, handlers, consumeClick };
}
