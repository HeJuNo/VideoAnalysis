import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countEvents, periodAt, periodsOf, type KindOf } from '../periods.ts';
import { missingStandardMarkers, normalizeDefinition, type ProfileDefinition } from '../profile.ts';

const kinds: Record<string, ReturnType<KindOf>> = {
  start: 'period-start',
  end: 'period-end',
  save: 'scene',
  goal: 'scene',
  icing: 'moment',
};
const kindOf: KindOf = (key) => (key ? (kinds[key] ?? null) : null);
const m = (startSec: number, eventTypeKey: string | null) => ({ startSec, eventTypeKey });

test('periods run from start to end marker', () => {
  const marks = [m(1500, 'start'), m(2700, 'end'), m(100, 'start'), m(1300, 'end'), m(2900, 'start')];
  assert.deepEqual(periodsOf(marks, kindOf), [
    { number: 1, start: 100, end: 1300 },
    { number: 2, start: 1500, end: 2700 },
    { number: 3, start: 2900, end: null },
  ]);
});

test('a missing end closes at the next start; a missing first start begins at 0', () => {
  assert.deepEqual(periodsOf([m(10, 'start'), m(500, 'start')], kindOf), [
    { number: 1, start: 10, end: 500 },
    { number: 2, start: 500, end: null },
  ]);
  assert.deepEqual(periodsOf([m(800, 'end'), m(900, 'start')], kindOf), [
    { number: 1, start: 0, end: 800 },
    { number: 2, start: 900, end: null },
  ]);
  assert.deepEqual(periodsOf([m(5, 'save')], kindOf), []);
});

test('counts per event type, per period and overall', () => {
  const marks = [
    m(100, 'start'),
    m(150, 'save'),
    m(400, 'save'),
    m(500, 'goal'),
    m(1300, 'end'),
    m(1350, 'save'), // between periods
    m(1500, 'start'),
    m(1600, 'save'),
    m(1700, 'icing'),
    m(1800, null),
  ];
  const periods = periodsOf(marks, kindOf);
  assert.deepEqual(Object.fromEntries(countEvents(marks, kindOf)), { save: 4, goal: 1, icing: 1 });
  assert.deepEqual(Object.fromEntries(countEvents(marks, kindOf, periodAt(periods, 1650))), { save: 1, icing: 1 });
  assert.deepEqual(Object.fromEntries(countEvents(marks, kindOf, periodAt(periods, 200))), { save: 2, goal: 1 });
  assert.equal(periodAt(periods, 1400), null);
});

test('standard markers are added once, without clashing keys, kinds or hotkeys', () => {
  const def: ProfileDefinition = normalizeDefinition({
    eventTypes: [
      { key: 'save', label: 'Save', color: '#000000', hotkey: 'h' } as ProfileDefinition['eventTypes'][number],
      { key: 'half-start', label: 'Half start', color: '#000000', hotkey: null, kind: 'period-start' },
    ],
    attributes: [],
    diagrams: [],
  });
  assert.equal(def.eventTypes[0].kind, 'scene');
  const missing = missingStandardMarkers(def);
  assert.deepEqual(
    missing.map((e) => [e.key, e.hotkey]),
    [
      ['period-end', 'e'],
      ['foul-home', null],
      ['foul-away', 'a'],
    ],
  );
  assert.deepEqual(missingStandardMarkers({ ...def, eventTypes: [...def.eventTypes, ...missing] }), []);
});
