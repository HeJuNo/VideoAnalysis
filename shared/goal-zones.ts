// Zones on the "hockey-goal" diagram (front view from the shooter, 6 × 4 ft opening). Points are
// stored relative to the template's viewBox (-1.5, -1.2, 9, 6 in feet), see web/src/diagrams/templates.tsx.
import type { DiagramPoint } from './annotation.ts';

export type CatchHand = 'left' | 'right';

export interface GoalZone {
  /** Stable key for statistics, e.g. "high-glove", "five-hole", "miss". */
  key: string;
  label: string;
}

const VIEW = { x: -1.5, y: -1.2, width: 9, height: 6 };
const GOAL = { width: 6, height: 4 };

/**
 * Splits the opening into thirds across and halves top/bottom. With the goalie's catching hand
 * known, the sides are named glove/blocker; a goalie catching left has the glove on the shooter's
 * right. Otherwise the sides are left/right as the shooter sees them.
 */
export function hockeyGoalZone(point: DiagramPoint, catchHand: CatchHand | null): GoalZone {
  const fx = point.x * VIEW.width + VIEW.x;
  const fy = point.y * VIEW.height + VIEW.y;
  if (fx < 0 || fx > GOAL.width || fy < 0 || fy > GOAL.height) return { key: 'miss', label: 'Missed the net' };

  const column = fx < GOAL.width / 3 ? 'left' : fx < (2 * GOAL.width) / 3 ? 'center' : 'right';
  const high = fy < GOAL.height / 2;
  if (column === 'center') return high ? { key: 'high-center', label: 'High center' } : { key: 'five-hole', label: 'Five-hole' };

  const row = high ? 'high' : 'low';
  const Row = high ? 'High' : 'Low';
  if (catchHand) {
    const gloveColumn = catchHand === 'left' ? 'right' : 'left';
    const side = column === gloveColumn ? 'glove' : 'blocker';
    return { key: `${row}-${side}`, label: `${Row} ${side} side` };
  }
  return { key: `${row}-${column}`, label: `${Row} ${column} (shooter's view)` };
}
