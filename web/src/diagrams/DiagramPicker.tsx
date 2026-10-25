// A click diagram: shows the background and the picked point; clicking stores x/y from 0 to 1.
import { useId, useRef, type MouseEvent } from 'react';
import type { DiagramBackground } from '../../../shared/profile.ts';
import { TEMPLATES } from './templates.tsx';

export interface DiagramPoint {
  x: number;
  y: number;
}

interface Props {
  background: DiagramBackground;
  value?: DiagramPoint | null;
  onChange?: (point: DiagramPoint | null) => void;
  label?: string;
  className?: string;
}

function viewBoxOf(background: DiagramBackground): [number, number, number, number] {
  return background.kind === 'template' ? TEMPLATES[background.template].viewBox : [0, 0, background.width, background.height];
}

export function DiagramPicker({ background, value, onChange, label, className }: Props) {
  const uid = useId().replace(/:/g, '');
  const svg = useRef<SVGSVGElement>(null);
  const [vx, vy, vw, vh] = viewBoxOf(background);
  const markerRadius = Math.min(vw, vh) * 0.025;

  const pick = (event: MouseEvent<SVGSVGElement>) => {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!el || !matrix || !onChange) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
    onChange({ x: clamp((p.x - vx) / vw), y: clamp((p.y - vy) / vh) });
  };

  return (
    <figure className={`diagram ${className ?? ''}`}>
      <svg
        ref={svg}
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        role={onChange ? 'button' : 'img'}
        aria-label={label}
        className={onChange ? 'pickable' : undefined}
        onClick={pick}
      >
        {background.kind === 'template' ? (
          TEMPLATES[background.template].render(uid)
        ) : (
          <image href={`/api/assets/${background.assetId}/file`} width={vw} height={vh} />
        )}
        {value && (
          <circle
            cx={vx + value.x * vw}
            cy={vy + value.y * vh}
            r={markerRadius}
            fill="#f59e0b"
            stroke="#111827"
            strokeWidth={markerRadius * 0.3}
          />
        )}
      </svg>
      {(label || (onChange && value)) && (
        <figcaption className="row small">
          <span className="grow">{label}</span>
          {onChange && value && (
            <button className="link" onClick={() => onChange(null)}>
              Clear point
            </button>
          )}
        </figcaption>
      )}
    </figure>
  );
}
