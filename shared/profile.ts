// Sport profiles are pure configuration: the app builds tagger buttons, analysis forms and
// statistics from a ProfileDefinition at runtime. Nothing sport-specific lives in code or schema.
//
// Keys are generated once from the label and never change afterwards, so labels can be renamed
// freely without breaking stored scenes. Every saved change creates a new immutable version.

export type AttributeType = 'single' | 'multi' | 'number' | 'text' | 'boolean' | 'rating';

/**
 * scene: a range around the moment (preset ±s) that analysts review.
 * moment, period-start, period-end: a point in time, not reviewed. Period markers split a video
 * into game periods (thirds, halves …) for per-period counts.
 */
export type EventKind = 'scene' | 'moment' | 'period-start' | 'period-end';

export interface EventTypeDef {
  key: string;
  label: string;
  /** #rrggbb */
  color: string;
  /** Single key (a-z, 0-9) for the tagger; null for none. */
  hotkey: string | null;
  kind: EventKind;
}

export interface OptionDef {
  key: string;
  label: string;
}

export interface AttributeDef {
  key: string;
  label: string;
  type: AttributeType;
  /** Choices for `single` and `multi`; empty for other types. */
  options: OptionDef[];
  /** Event type keys this attribute is asked for; empty means all event types. */
  appliesTo: string[];
}

export type DiagramTemplate =
  | 'hockey-half'
  | 'hockey-full'
  | 'hockey-goal'
  | 'football'
  | 'handball'
  | 'floorball'
  | 'basketball';

export type DiagramBackground =
  | { kind: 'template'; template: DiagramTemplate }
  | { kind: 'image'; assetId: string; width: number; height: number };

/** A click diagram; a picked point is stored as x/y from 0 to 1 relative to the background. */
export interface DiagramDef {
  key: string;
  label: string;
  background: DiagramBackground;
  appliesTo: string[];
}

export interface ProfileDefinition {
  eventTypes: EventTypeDef[];
  attributes: AttributeDef[];
  diagrams: DiagramDef[];
}

export const EVENT_KINDS: { kind: EventKind; label: string }[] = [
  { kind: 'scene', label: 'Scene (range)' },
  { kind: 'moment', label: 'Moment (point in time)' },
  { kind: 'period-start', label: 'Period start' },
  { kind: 'period-end', label: 'Period end' },
];

export const isPointKind = (kind: EventKind) => kind !== 'scene';

/** Standard markers offered for every profile; labels can be renamed afterwards (e.g. "Half start"). */
export const STANDARD_MARKERS: EventTypeDef[] = [
  { key: 'period-start', label: 'Period start', color: '#4b5563', hotkey: 'b', kind: 'period-start' },
  { key: 'period-end', label: 'Period end', color: '#4b5563', hotkey: 'e', kind: 'period-end' },
  { key: 'foul-home', label: 'Foul home team', color: '#0e7490', hotkey: 'h', kind: 'scene' },
  { key: 'foul-away', label: 'Foul away team', color: '#be185d', hotkey: 'a', kind: 'scene' },
];

/**
 * The standard markers the profile does not have yet (by key, and only one period start/end
 * type). A hotkey already in use is left empty.
 */
export function missingStandardMarkers(def: ProfileDefinition): EventTypeDef[] {
  const keys = new Set(def.eventTypes.map((e) => e.key));
  const kinds = new Set(def.eventTypes.map((e) => e.kind));
  const hotkeys = new Set(def.eventTypes.map((e) => e.hotkey));
  return STANDARD_MARKERS.filter((m) => !keys.has(m.key) && !(m.kind !== 'scene' && kinds.has(m.kind))).map((m) => ({
    ...m,
    hotkey: m.hotkey && hotkeys.has(m.hotkey) ? null : m.hotkey,
  }));
}

/** Definitions stored before event kinds existed have no `kind`; they are scenes. */
export function normalizeDefinition(def: ProfileDefinition): ProfileDefinition {
  return { ...def, eventTypes: def.eventTypes.map((e) => ({ ...e, kind: e.kind ?? 'scene' })) };
}

export const ATTRIBUTE_TYPES: { type: AttributeType; label: string; hasOptions: boolean }[] = [
  { type: 'single', label: 'Single choice', hasOptions: true },
  { type: 'multi', label: 'Multiple choice', hasOptions: true },
  { type: 'number', label: 'Number', hasOptions: false },
  { type: 'text', label: 'Text', hasOptions: false },
  { type: 'boolean', label: 'Yes / no', hasOptions: false },
  { type: 'rating', label: 'Rating 1–5', hasOptions: false },
];

export const DIAGRAM_TEMPLATES: { template: DiagramTemplate; label: string }[] = [
  { template: 'hockey-half', label: 'Ice hockey – defensive zone' },
  { template: 'hockey-full', label: 'Ice hockey – full rink' },
  { template: 'hockey-goal', label: 'Ice hockey – goal (front view)' },
  { template: 'football', label: 'Football pitch' },
  { template: 'handball', label: 'Handball court' },
  { template: 'floorball', label: 'Floorball rink' },
  { template: 'basketball', label: 'Basketball court' },
];

export const LIMITS = {
  eventTypes: 50,
  attributes: 100,
  options: 50,
  diagrams: 10,
  label: 60,
};

export const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HOTKEY_PATTERN = /^[a-z0-9]$/;

export function emptyDefinition(): ProfileDefinition {
  return { eventTypes: [], attributes: [], diagrams: [] };
}

/** A stable key derived from the label, unique among `taken` ("Shot type" → "shot-type", "shot-type-2"). */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'item';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const appliesToEvent = (appliesTo: string[], eventKey: string | null) =>
  appliesTo.length === 0 || (eventKey !== null && appliesTo.includes(eventKey));

/** Attributes asked for a scene of this event type (all-purpose ones when no type is set). */
export function attributesFor(def: ProfileDefinition, eventKey: string | null): AttributeDef[] {
  return def.attributes.filter((a) => appliesToEvent(a.appliesTo, eventKey));
}

export function diagramsFor(def: ProfileDefinition, eventKey: string | null): DiagramDef[] {
  return def.diagrams.filter((d) => appliesToEvent(d.appliesTo, eventKey));
}
