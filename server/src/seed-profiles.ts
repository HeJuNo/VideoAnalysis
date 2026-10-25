// Starter profile, created once when the database has no profiles. It is ordinary data:
// analysts edit, copy or archive it in the app like any other profile.
import {
  missingStandardMarkers,
  STANDARD_MARKERS,
  type AttributeDef,
  type OptionDef,
  type ProfileDefinition,
} from '../../shared/profile.ts';
import { now, type Db } from './db.ts';
import { createProfile, getProfile, saveProfile } from './profiles.ts';

const SHOTS = ['save', 'goal-against'];
const GAME_EVENTS = ['save', 'goal-against', 'puck-play', 'positioning'];

function options(...labels: [key: string, label: string][]): OptionDef[] {
  return labels.map(([key, label]) => ({ key, label }));
}

function attribute(
  key: string,
  label: string,
  type: AttributeDef['type'],
  appliesTo: string[],
  choices: OptionDef[] = [],
): AttributeDef {
  return { key, label, type, options: choices, appliesTo };
}

export const ICE_HOCKEY_GOALIE: ProfileDefinition = {
  eventTypes: [
    { key: 'save', label: 'Save', color: '#1a7f37', hotkey: 's', kind: 'scene' },
    { key: 'goal-against', label: 'Goal against', color: '#c8102e', hotkey: 'g', kind: 'scene' },
    { key: 'puck-play', label: 'Puck play', color: '#1f6feb', hotkey: 'p', kind: 'scene' },
    { key: 'positioning', label: 'Positioning', color: '#8250df', hotkey: 'o', kind: 'scene' },
    { key: 'drill-rep', label: 'Drill rep', color: '#9a6700', hotkey: 'd', kind: 'scene' },
    ...STANDARD_MARKERS,
  ],
  attributes: [
    attribute(
      'shot-type',
      'Shot type',
      'single',
      SHOTS,
      options(
        ['wrist', 'Wrist'],
        ['snap', 'Snap'],
        ['slap', 'Slap'],
        ['backhand', 'Backhand'],
        ['one-timer', 'One-timer'],
        ['tip-deflection', 'Tip/Deflection'],
        ['wraparound', 'Wraparound'],
      ),
    ),
    attribute(
      'play-type',
      'Play type',
      'single',
      SHOTS,
      options(
        ['rush', 'Rush'],
        ['breakaway', 'Breakaway'],
        ['odd-man-rush', 'Odd-man rush'],
        ['zone-play', 'Zone play'],
        ['rebound', 'Rebound'],
        ['scramble', 'Scramble'],
        ['penalty-shot', 'Penalty shot'],
      ),
    ),
    attribute(
      'situation',
      'Situation',
      'single',
      GAME_EVENTS,
      options(['even-strength', 'Even strength'], ['power-play-against', 'Power play against'], ['short-handed', 'Short-handed']),
    ),
    attribute('screen', 'Screen', 'single', SHOTS, options(['none', 'None'], ['partial', 'Partial'], ['full', 'Full'])),
    attribute('cross-crease-pass', 'Cross-crease pass before shot', 'boolean', SHOTS),
    attribute(
      'save-technique',
      'Save technique',
      'multi',
      ['save'],
      options(
        ['glove', 'Glove'],
        ['blocker', 'Blocker'],
        ['pad', 'Pad'],
        ['stick', 'Stick'],
        ['body', 'Body'],
        ['butterfly', 'Butterfly'],
        ['paddle-down', 'Paddle-down'],
        ['rvh', 'RVH'],
      ),
    ),
    attribute(
      'rebound-control',
      'Rebound control',
      'single',
      ['save'],
      options(['frozen', 'Frozen'], ['safe-rebound', 'Safe rebound'], ['dangerous-rebound', 'Dangerous rebound']),
    ),
    attribute('danger-level', 'Danger level', 'rating', SHOTS),
    attribute('positioning-rating', 'Positioning', 'rating', []),
    attribute('preventable', 'Preventable', 'boolean', ['goal-against']),
    attribute('coaching-notes', 'Coaching notes', 'text', []),
  ],
  diagrams: [
    {
      key: 'shot-location',
      label: 'Shot location',
      background: { kind: 'template', template: 'hockey-half' },
      appliesTo: SHOTS,
    },
    {
      key: 'goal-placement',
      label: 'Goal placement',
      background: { kind: 'template', template: 'hockey-goal' },
      appliesTo: SHOTS,
    },
  ],
};

export function ensureSeedProfiles(db: Db): void {
  if (!db.prepare('select 1 from sport_profiles limit 1').get()) {
    createProfile(db, { name: 'Ice Hockey Goalie', sport: 'Ice hockey', definition: ICE_HOCKEY_GOALIE, userId: null });
  }
  addStandardMarkersOnce(db);
}

/**
 * One-time upgrade (2026-10-23): the starter profile created before standard markers existed gets
 * them as a new version. Recorded in schema_migrations so markers deleted later stay deleted.
 */
function addStandardMarkersOnce(db: Db): void {
  const step = 'data:standard-markers';
  if (db.prepare('select 1 from schema_migrations where version = ?').get(step)) return;
  const starters = db.prepare('select id from sport_profiles where created_by is null').all();
  for (const row of starters) {
    const profile = getProfile(db, String(row.id));
    if (!profile) continue;
    const missing = missingStandardMarkers(profile.definition);
    if (missing.length === 0) continue;
    const definition = { ...profile.definition, eventTypes: [...profile.definition.eventTypes, ...missing] };
    saveProfile(db, profile, { name: profile.name, sport: profile.sport, definition, userId: null });
  }
  db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(step, now());
}
