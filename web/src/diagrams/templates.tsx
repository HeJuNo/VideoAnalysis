// Built-in diagram backgrounds. Schematic drawings based on common rule-book dimensions
// (NHL rink in feet, FIFA/IHF/IBF/FIBA courts in metres), not exact to scale.
// Points are stored relative to the viewBox (0–1), so a drawing can be refined later without
// moving stored points much; the viewBox itself must not change.
import type { ReactNode } from 'react';
import type { DiagramTemplate } from '../../../shared/profile.ts';

export interface TemplateSpec {
  viewBox: [x: number, y: number, width: number, height: number];
  /** `uid` keeps clip-path ids unique when several diagrams are on one page. */
  render: (uid: string) => ReactNode;
}

const RED = '#c8102e';
const BLUE = '#1f4fa3';
const ICE = '#f1f6fa';
const BOARD = '#4b5563';
const CREASE = '#b9d6f2';

/** Draws the left half; the right half is its mirror image. */
function Mirrored({ width, children }: { width: number; children: ReactNode }) {
  return (
    <>
      {children}
      <g transform={`translate(${width} 0) scale(-1 1)`}>{children}</g>
    </>
  );
}

function hockeyFull(uid: string) {
  const clip = `${uid}-rink`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect width={200} height={85} rx={28} />
        </clipPath>
      </defs>
      <rect width={200} height={85} rx={28} fill={ICE} />
      <g clipPath={`url(#${clip})`}>
        <Mirrored width={200}>
          <line x1={11} x2={11} y1={0} y2={85} stroke={RED} strokeWidth={0.6} />
          <rect x={74.5} width={1} height={85} fill={BLUE} />
        </Mirrored>
        <rect x={99.5} width={1} height={85} fill={RED} />
      </g>
      <circle cx={100} cy={42.5} r={15} fill="none" stroke={BLUE} strokeWidth={0.5} />
      <circle cx={100} cy={42.5} r={0.8} fill={BLUE} />
      <Mirrored width={200}>
        {[20.5, 64.5].map((y) => (
          <g key={y}>
            <circle cx={31} cy={y} r={15} fill="none" stroke={RED} strokeWidth={0.5} />
            <circle cx={31} cy={y} r={1} fill={RED} />
            <circle cx={80} cy={y} r={1} fill={RED} />
          </g>
        ))}
        <path d="M11,36.5 A6,6 0 0 1 11,48.5 Z" fill={CREASE} stroke={RED} strokeWidth={0.3} />
        <rect x={7.7} y={39.5} width={3.3} height={6} fill="none" stroke={RED} strokeWidth={0.4} />
      </Mirrored>
      <rect width={200} height={85} rx={28} fill="none" stroke={BOARD} strokeWidth={1} />
    </>
  );
}

/** Defensive zone seen from above: centre line at the top, own goal at the bottom. */
function hockeyHalf(uid: string) {
  const clip = `${uid}-half`;
  const outline = 'M0,0 H85 V72 A28,28 0 0 1 57,100 H28 A28,28 0 0 1 0,72 Z';
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <path d={outline} />
        </clipPath>
      </defs>
      <path d={outline} fill={ICE} />
      <g clipPath={`url(#${clip})`}>
        <rect width={85} height={1} fill={RED} />
        <rect y={24.5} width={85} height={1} fill={BLUE} />
        <line x1={0} x2={85} y1={89} y2={89} stroke={RED} strokeWidth={0.6} />
      </g>
      <path d="M27.5,0 A15,15 0 0 0 57.5,0" fill="none" stroke={BLUE} strokeWidth={0.5} />
      {[20.5, 64.5].map((x) => (
        <g key={x}>
          <circle cx={x} cy={20} r={1} fill={RED} />
          <circle cx={x} cy={69} r={15} fill="none" stroke={RED} strokeWidth={0.5} />
          <circle cx={x} cy={69} r={1} fill={RED} />
        </g>
      ))}
      <path d="M36.5,89 A6,6 0 0 1 48.5,89 Z" fill={CREASE} stroke={RED} strokeWidth={0.3} />
      <rect x={39.5} y={89} width={6} height={3.3} fill="none" stroke={RED} strokeWidth={0.4} />
      <path d={outline} fill="none" stroke={BOARD} strokeWidth={1} />
    </>
  );
}

/** Goal from the shooter's view: 6 × 4 ft opening with room around it for shots that miss. */
function hockeyGoal() {
  const mesh: ReactNode[] = [];
  for (let x = 0.5; x < 6; x += 0.5) mesh.push(<line key={`x${x}`} x1={x} x2={x} y1={0} y2={4} />);
  for (let y = 0.5; y < 4; y += 0.5) mesh.push(<line key={`y${y}`} x1={0} x2={6} y1={y} y2={y} />);
  return (
    <>
      <rect x={-1.5} y={-1.2} width={9} height={6} fill="#f7f9fb" />
      <rect x={-1.5} y={4} width={9} height={0.8} fill={ICE} />
      <rect x={0} y={0} width={6} height={4} fill="#ffffff" />
      <g stroke="#d5dbe1" strokeWidth={0.03}>{mesh}</g>
      <g stroke="#9aa1ad" strokeWidth={0.03} strokeDasharray="0.12 0.12">
        <line x1={2} x2={2} y1={0} y2={4} />
        <line x1={4} x2={4} y1={0} y2={4} />
        <line x1={0} x2={6} y1={2} y2={2} />
      </g>
      <line x1={-1.5} x2={7.5} y1={4} y2={4} stroke={RED} strokeWidth={0.1} />
      <path d="M0,4 V0 H6 V4" fill="none" stroke={RED} strokeWidth={0.2} />
    </>
  );
}

function football() {
  const line = { fill: 'none', stroke: '#ffffff', strokeWidth: 0.25 };
  return (
    <>
      <rect x={-3} y={-2} width={111} height={72} fill="#5f9e4a" />
      <rect width={105} height={68} {...line} />
      <line x1={52.5} x2={52.5} y1={0} y2={68} {...line} />
      <circle cx={52.5} cy={34} r={9.15} {...line} />
      <circle cx={52.5} cy={34} r={0.35} fill="#ffffff" />
      <Mirrored width={105}>
        <rect y={13.84} width={16.5} height={40.32} {...line} />
        <rect y={24.84} width={5.5} height={18.32} {...line} />
        <circle cx={11} cy={34} r={0.35} fill="#ffffff" />
        <path d="M16.5,26.69 A9.15,9.15 0 0 1 16.5,41.31" {...line} />
        <rect x={-2} y={30.34} width={2} height={7.32} {...line} />
        <path d="M1,0 A1,1 0 0 1 0,1" {...line} />
        <path d="M0,67 A1,1 0 0 1 1,68" {...line} />
      </Mirrored>
    </>
  );
}

function handball(uid: string) {
  const clip = `${uid}-court`;
  const line = { fill: 'none', stroke: '#ffffff', strokeWidth: 0.1 };
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect width={40} height={20} />
        </clipPath>
      </defs>
      <rect x={-2} y={-1} width={44} height={22} fill="#2f6aa8" />
      <rect width={40} height={20} fill="#4a8bd0" stroke="#ffffff" strokeWidth={0.1} />
      <line x1={20} x2={20} y1={0} y2={20} {...line} />
      <Mirrored width={40}>
        <path d="M0,2.5 A6,6 0 0 1 6,8.5 L6,11.5 A6,6 0 0 1 0,17.5 Z" fill="#6fa8e6" stroke="#ffffff" strokeWidth={0.1} />
        <path
          d="M0,-0.5 A9,9 0 0 1 9,8.5 L9,11.5 A9,9 0 0 1 0,20.5"
          {...line}
          strokeDasharray="0.4 0.4"
          clipPath={`url(#${clip})`}
        />
        <line x1={7} x2={7} y1={9.5} y2={10.5} {...line} />
        <rect x={-1} y={8.5} width={1} height={3} {...line} />
      </Mirrored>
    </>
  );
}

function floorball() {
  const line = { fill: 'none', stroke: '#ffffff', strokeWidth: 0.08 };
  const dot = (cx: number, cy: number) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={0.15} fill="#ffffff" />;
  return (
    <>
      <rect x={-1} y={-1} width={42} height={22} fill="#e5e7eb" />
      <rect width={40} height={20} rx={2} fill="#3d7fbf" stroke="#1f2937" strokeWidth={0.15} />
      <line x1={20} x2={20} y1={0} y2={20} {...line} />
      {[dot(20, 10), dot(20, 1.5), dot(20, 18.5)]}
      <Mirrored width={40}>
        <rect x={2.85} y={7.5} width={4} height={5} {...line} />
        <rect x={3.5} y={8.75} width={1} height={2.5} {...line} />
        <rect x={2.85} y={9.2} width={0.65} height={1.6} fill="none" stroke="#ef4444" strokeWidth={0.08} />
        {[dot(3.5, 1.5), dot(3.5, 18.5)]}
      </Mirrored>
    </>
  );
}

function basketball() {
  const ink = '#5c3d1e';
  const line = { fill: 'none', stroke: ink, strokeWidth: 0.08 };
  return (
    <>
      <rect x={-1} y={-1} width={30} height={17} fill="#d9b382" />
      <rect width={28} height={15} fill="#e8c79c" stroke={ink} strokeWidth={0.08} />
      <line x1={14} x2={14} y1={0} y2={15} {...line} />
      <circle cx={14} cy={7.5} r={1.8} {...line} />
      <Mirrored width={28}>
        <rect y={5.05} width={5.8} height={4.9} fill="#d79c5f" stroke={ink} strokeWidth={0.08} />
        <circle cx={5.8} cy={7.5} r={1.8} {...line} />
        <path d="M0,0.9 H2.99 A6.75,6.75 0 0 1 2.99,14.1 H0" {...line} />
        <line x1={1.2} x2={1.2} y1={6.6} y2={8.4} stroke={ink} strokeWidth={0.12} />
        <circle cx={1.575} cy={7.5} r={0.225} fill="none" stroke="#d9480f" strokeWidth={0.06} />
      </Mirrored>
    </>
  );
}

export const TEMPLATES: Record<DiagramTemplate, TemplateSpec> = {
  'hockey-half': { viewBox: [-1, -1, 87, 102], render: hockeyHalf },
  'hockey-full': { viewBox: [-1, -1, 202, 87], render: hockeyFull },
  'hockey-goal': { viewBox: [-1.5, -1.2, 9, 6], render: hockeyGoal },
  football: { viewBox: [-3, -2, 111, 72], render: football },
  handball: { viewBox: [-2, -1, 44, 22], render: handball },
  floorball: { viewBox: [-1, -1, 42, 22], render: floorball },
  basketball: { viewBox: [-1, -1, 30, 17], render: basketball },
};
