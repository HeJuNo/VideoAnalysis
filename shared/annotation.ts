// What an analyst records for a scene, keyed by the profile's attribute and diagram keys.
// A value or point can carry a flag: "uncertain" (a best guess, e.g. obscured angle) or
// "unknown" (cannot be judged; then it has no value).
import type { ProfileDefinition } from './profile.ts';

export type AttributeValue = string | string[] | number | boolean;
export type Certainty = 'unknown' | 'uncertain';

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface SceneAnnotation {
  values: Record<string, AttributeValue>;
  points: Record<string, DiagramPoint>;
  valueFlags: Record<string, Certainty>;
  pointFlags: Record<string, Certainty>;
}

export function emptyAnnotation(): SceneAnnotation {
  return { values: {}, points: {}, valueFlags: {}, pointFlags: {} };
}

/** Fills in missing parts, e.g. for scenes stored before an analyst touched them (`{}`). */
export function normalizeAnnotation(raw: Partial<SceneAnnotation> | null | undefined): SceneAnnotation {
  return { ...emptyAnnotation(), ...raw };
}

const MAX_TEXT = 1000;

/** Checks values against the profile version the scene was recorded with. */
export function checkAnnotation(def: ProfileDefinition, annotation: SceneAnnotation): string | null {
  for (const [key, value] of Object.entries(annotation.values)) {
    const attribute = def.attributes.find((a) => a.key === key);
    if (!attribute) return `Unknown attribute "${key}"`;
    const options = new Set(attribute.options.map((o) => o.key));
    const label = `"${attribute.label}"`;
    switch (attribute.type) {
      case 'single':
        if (typeof value !== 'string' || !options.has(value)) return `${label} has an invalid choice`;
        break;
      case 'multi':
        if (!Array.isArray(value) || value.some((v) => !options.has(v)) || new Set(value).size !== value.length) {
          return `${label} has invalid choices`;
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number`;
        break;
      case 'text':
        if (typeof value !== 'string' || value.length > MAX_TEXT) return `${label} must be text up to ${MAX_TEXT} characters`;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return `${label} must be yes or no`;
        break;
      case 'rating':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) return `${label} must be 1 to 5`;
        break;
    }
  }

  for (const [key, point] of Object.entries(annotation.points)) {
    if (!def.diagrams.some((d) => d.key === key)) return `Unknown diagram "${key}"`;
    if (![point.x, point.y].every((n) => typeof n === 'number' && n >= 0 && n <= 1)) {
      return `The point for "${key}" is outside the diagram`;
    }
  }

  for (const [key, flag] of Object.entries(annotation.valueFlags)) {
    const attribute = def.attributes.find((a) => a.key === key);
    if (!attribute) return `Unknown attribute "${key}"`;
    if (flag === 'unknown' && key in annotation.values) return `"${attribute.label}" is marked unknown but has a value`;
  }
  for (const [key, flag] of Object.entries(annotation.pointFlags)) {
    const diagram = def.diagrams.find((d) => d.key === key);
    if (!diagram) return `Unknown diagram "${key}"`;
    if (flag === 'unknown' && key in annotation.points) return `"${diagram.label}" is marked unknown but has a point`;
  }
  return null;
}
