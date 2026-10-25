import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAnnotation, emptyAnnotation, normalizeAnnotation, type SceneAnnotation } from '../annotation.ts';
import { hockeyGoalZone } from '../goal-zones.ts';
import type { ProfileDefinition } from '../profile.ts';

const def: ProfileDefinition = {
  eventTypes: [{ key: 'save', label: 'Save', color: '#000000', hotkey: null, kind: 'scene' }],
  attributes: [
    { key: 'shot', label: 'Shot', type: 'single', options: [{ key: 'wrist', label: 'Wrist' }, { key: 'slap', label: 'Slap' }], appliesTo: [] },
    { key: 'tech', label: 'Technique', type: 'multi', options: [{ key: 'glove', label: 'Glove' }, { key: 'pad', label: 'Pad' }], appliesTo: [] },
    { key: 'danger', label: 'Danger', type: 'rating', options: [], appliesTo: [] },
    { key: 'distance', label: 'Distance', type: 'number', options: [], appliesTo: [] },
    { key: 'notes', label: 'Notes', type: 'text', options: [], appliesTo: [] },
    { key: 'screen', label: 'Screened', type: 'boolean', options: [], appliesTo: [] },
  ],
  diagrams: [{ key: 'net', label: 'Net', background: { kind: 'template', template: 'hockey-goal' }, appliesTo: [] }],
};

const with_ = (patch: Partial<SceneAnnotation>): SceneAnnotation => ({ ...emptyAnnotation(), ...patch });

test('accepts valid answers of every type', () => {
  const ok = with_({
    values: { shot: 'wrist', tech: ['glove', 'pad'], danger: 4, distance: 12.5, notes: 'late reaction', screen: false },
    points: { net: { x: 0.2, y: 0.4 } },
    valueFlags: { shot: 'uncertain', distance: 'uncertain' },
    pointFlags: {},
  });
  assert.equal(checkAnnotation(def, ok), null);
  assert.equal(checkAnnotation(def, with_({ valueFlags: { danger: 'unknown' }, pointFlags: { net: 'unknown' } })), null);
});

test('rejects answers that do not fit the profile', () => {
  const cases: [Partial<SceneAnnotation>, RegExp][] = [
    [{ values: { speed: 3 } }, /Unknown attribute "speed"/],
    [{ values: { shot: 'lob' } }, /"Shot" has an invalid choice/],
    [{ values: { tech: ['glove', 'glove'] } }, /"Technique" has invalid choices/],
    [{ values: { danger: 6 } }, /"Danger" must be 1 to 5/],
    [{ values: { danger: 2.5 } }, /1 to 5/],
    [{ values: { distance: '12' } }, /must be a number/],
    [{ values: { screen: 'yes' } }, /yes or no/],
    [{ points: { net: { x: 1.2, y: 0.5 } } }, /outside the diagram/],
    [{ points: { rink: { x: 0.5, y: 0.5 } } }, /Unknown diagram "rink"/],
    [{ values: { shot: 'slap' }, valueFlags: { shot: 'unknown' } }, /marked unknown but has a value/],
    [{ points: { net: { x: 0.5, y: 0.5 } }, pointFlags: { net: 'unknown' } }, /marked unknown but has a point/],
  ];
  for (const [patch, message] of cases) assert.match(checkAnnotation(def, with_(patch)) ?? '', message, JSON.stringify(patch));
});

test('old scenes without an annotation read as empty', () => {
  assert.deepEqual(normalizeAnnotation({}), emptyAnnotation());
  assert.deepEqual(normalizeAnnotation(null), emptyAnnotation());
});

// Points in viewBox units (feet): x from -1.5, y from -1.2; the opening is 0..6 × 0..4.
const at = (fx: number, fy: number) => ({ x: (fx + 1.5) / 9, y: (fy + 1.2) / 6 });

test('goal zones follow the goalie catching hand', () => {
  // Goalie catching left: glove is on the shooter's right.
  assert.deepEqual(hockeyGoalZone(at(5, 1), 'left'), { key: 'high-glove', label: 'High glove side' });
  assert.deepEqual(hockeyGoalZone(at(1, 3), 'left'), { key: 'low-blocker', label: 'Low blocker side' });
  assert.equal(hockeyGoalZone(at(5, 1), 'right').key, 'high-blocker');
  assert.equal(hockeyGoalZone(at(3, 3.5), 'left').key, 'five-hole');
  assert.equal(hockeyGoalZone(at(3, 0.5), null).key, 'high-center');
  assert.deepEqual(hockeyGoalZone(at(1, 1), null), { key: 'high-left', label: "High left (shooter's view)" });
  assert.equal(hockeyGoalZone(at(6.5, 2), 'left').key, 'miss');
  assert.equal(hockeyGoalZone(at(3, -0.5), 'left').key, 'miss');
});
