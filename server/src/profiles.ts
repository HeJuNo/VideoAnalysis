// Sport profile storage and validation. A saved definition is never modified: changes create a
// new version, and sessions/scenes keep pointing at the version they were recorded with.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ATTRIBUTE_TYPES,
  DIAGRAM_TEMPLATES,
  EVENT_KINDS,
  HOTKEY_PATTERN,
  KEY_PATTERN,
  LIMITS,
  normalizeDefinition,
  type ProfileDefinition,
} from '../../shared/profile.ts';
import type { ProfileDto, ProfileSummaryDto } from '../../shared/types.ts';
import { now, transaction, type Db } from './db.ts';

const label = z.string().trim().min(1).max(LIMITS.label);
const key = z.string().max(40).regex(KEY_PATTERN, 'Keys use lowercase letters, digits and dashes');
const appliesTo = z.array(key).max(LIMITS.eventTypes);

export const definitionSchema = z.strictObject({
  eventTypes: z
    .array(
      z.strictObject({
        key,
        label,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors are #rrggbb'),
        hotkey: z.string().regex(HOTKEY_PATTERN, 'Hotkeys are a single letter or digit').nullable(),
        // Definitions saved before kinds existed omit it.
        kind: z.enum(EVENT_KINDS.map((k) => k.kind) as [string, ...string[]]).default('scene'),
      }),
    )
    .min(1, 'A profile needs at least one event type')
    .max(LIMITS.eventTypes),
  attributes: z
    .array(
      z.strictObject({
        key,
        label,
        type: z.enum(ATTRIBUTE_TYPES.map((t) => t.type) as [string, ...string[]]),
        options: z.array(z.strictObject({ key, label })).max(LIMITS.options),
        appliesTo,
      }),
    )
    .max(LIMITS.attributes),
  diagrams: z
    .array(
      z.strictObject({
        key,
        label,
        background: z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('template'),
            template: z.enum(DIAGRAM_TEMPLATES.map((t) => t.template) as [string, ...string[]]),
          }),
          z.strictObject({
            kind: z.literal('image'),
            assetId: z.string().min(1).max(64),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }),
        ]),
        appliesTo,
      }),
    )
    .max(LIMITS.diagrams),
});

/** Cross-references the schema cannot express. Returns a message for the first problem found. */
export function checkDefinition(def: ProfileDefinition, assetIsReady: (id: string) => boolean): string | null {
  const duplicate = (values: string[]) => values.find((v, i) => values.indexOf(v) !== i);

  const eventKeys = def.eventTypes.map((e) => e.key);
  const dupEvent = duplicate(eventKeys);
  if (dupEvent) return `Event type key "${dupEvent}" is used twice`;
  const dupHotkey = duplicate(def.eventTypes.flatMap((e) => (e.hotkey ? [e.hotkey] : [])));
  if (dupHotkey) return `Hotkey "${dupHotkey}" is used by two event types`;
  for (const kind of ['period-start', 'period-end'] as const) {
    if (def.eventTypes.filter((e) => e.kind === kind).length > 1) {
      return `Only one event type can be the ${kind === 'period-start' ? 'period start' : 'period end'}`;
    }
  }

  const dupAttribute = duplicate(def.attributes.map((a) => a.key));
  if (dupAttribute) return `Attribute key "${dupAttribute}" is used twice`;
  const dupDiagram = duplicate(def.diagrams.map((d) => d.key));
  if (dupDiagram) return `Diagram key "${dupDiagram}" is used twice`;

  for (const item of [...def.attributes, ...def.diagrams]) {
    const unknown = item.appliesTo.find((k) => !eventKeys.includes(k));
    if (unknown) return `"${item.label}" refers to unknown event type "${unknown}"`;
    if (duplicate(item.appliesTo)) return `"${item.label}" lists an event type twice`;
  }

  for (const attribute of def.attributes) {
    const hasOptions = ATTRIBUTE_TYPES.find((t) => t.type === attribute.type)!.hasOptions;
    if (hasOptions && attribute.options.length === 0) return `"${attribute.label}" needs at least one choice`;
    if (!hasOptions && attribute.options.length > 0) return `"${attribute.label}" cannot have choices`;
    const dupOption = duplicate(attribute.options.map((o) => o.key));
    if (dupOption) return `"${attribute.label}" has the choice key "${dupOption}" twice`;
  }

  for (const diagram of def.diagrams) {
    if (diagram.background.kind === 'image' && !assetIsReady(diagram.background.assetId)) {
      return `The image of diagram "${diagram.label}" is missing`;
    }
  }
  return null;
}

interface ProfileRow {
  id: string;
  name: string;
  sport: string;
  current_version: number;
  archived_at: string | null;
  updated_at: string;
  session_count: number;
}

const PROFILE_SELECT = `
  select p.id, p.name, p.sport, p.current_version, p.archived_at, p.updated_at,
    (select count(*) from sessions s where s.sport_profile_id = p.id) as session_count
  from sport_profiles p`;

function toSummary(row: ProfileRow): ProfileSummaryDto {
  return {
    id: row.id,
    name: row.name,
    sport: row.sport,
    currentVersion: row.current_version,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
  };
}

export function listProfiles(db: Db, includeArchived: boolean): ProfileSummaryDto[] {
  const where = includeArchived ? '' : 'where p.archived_at is null';
  const rows = db.prepare(`${PROFILE_SELECT} ${where} order by p.name collate nocase`).all();
  return (rows as unknown as ProfileRow[]).map(toSummary);
}

/** The profile with the definition of `version`, or of the current version when omitted. */
export function getProfile(db: Db, id: string, version?: number): ProfileDto | undefined {
  const row = db.prepare(`${PROFILE_SELECT} where p.id = ?`).get(id) as ProfileRow | undefined;
  if (!row) return undefined;
  const v = version ?? row.current_version;
  const def = db
    .prepare('select definition from sport_profile_versions where profile_id = ? and version = ?')
    .get(id, v);
  if (!def) return undefined;
  const definition = normalizeDefinition(JSON.parse(String(def.definition)) as ProfileDefinition);
  return { ...toSummary(row), version: v, definition };
}

export function createProfile(
  db: Db,
  input: { name: string; sport: string; definition: ProfileDefinition; userId: string | null },
): string {
  const id = randomUUID();
  const at = now();
  transaction(db, () => {
    db.prepare(
      `insert into sport_profiles (id, name, sport, current_version, created_by, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, input.name, input.sport, input.userId, at, at);
    db.prepare(
      'insert into sport_profile_versions (profile_id, version, definition, created_by, created_at) values (?, 1, ?, ?, ?)',
    ).run(id, JSON.stringify(input.definition), input.userId, at);
  });
  return id;
}

/** Updates name/sport, and stores the definition as a new version if it changed. */
export function saveProfile(
  db: Db,
  current: ProfileDto,
  input: { name: string; sport: string; definition: ProfileDefinition; userId: string | null },
): void {
  const at = now();
  const changed = JSON.stringify(input.definition) !== JSON.stringify(current.definition);
  const version = changed ? current.currentVersion + 1 : current.currentVersion;
  transaction(db, () => {
    if (changed) {
      db.prepare(
        'insert into sport_profile_versions (profile_id, version, definition, created_by, created_at) values (?, ?, ?, ?, ?)',
      ).run(current.id, version, JSON.stringify(input.definition), input.userId, at);
    }
    db.prepare('update sport_profiles set name = ?, sport = ?, current_version = ?, updated_at = ? where id = ?').run(
      input.name,
      input.sport,
      version,
      at,
      current.id,
    );
  });
}
