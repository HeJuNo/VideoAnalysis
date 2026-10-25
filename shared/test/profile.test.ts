import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributesFor, diagramsFor, keyFromLabel, type ProfileDefinition } from '../profile.ts';

test('keys come from labels and stay unique', () => {
  assert.equal(keyFromLabel('Shot type', []), 'shot-type');
  assert.equal(keyFromLabel('Shot type', ['shot-type']), 'shot-type-2');
  assert.equal(keyFromLabel('Shot type', ['shot-type', 'shot-type-2']), 'shot-type-3');
  assert.equal(keyFromLabel('Torhüter – Fanghand', []), 'torhuter-fanghand');
  assert.equal(keyFromLabel('  !!! ', []), 'item');
  assert.equal(keyFromLabel('Tip/Deflection', []), 'tip-deflection');
});

const def: ProfileDefinition = {
  eventTypes: [
    { key: 'save', label: 'Save', color: '#1a7f37', hotkey: 's', kind: 'scene' },
    { key: 'goal', label: 'Goal', color: '#b42318', hotkey: 'g', kind: 'scene' },
  ],
  attributes: [
    { key: 'notes', label: 'Notes', type: 'text', options: [], appliesTo: [] },
    { key: 'technique', label: 'Technique', type: 'multi', options: [], appliesTo: ['save'] },
    { key: 'preventable', label: 'Preventable', type: 'boolean', options: [], appliesTo: ['goal'] },
  ],
  diagrams: [
    { key: 'net', label: 'Net', background: { kind: 'template', template: 'hockey-goal' }, appliesTo: ['save', 'goal'] },
  ],
};

test('attributes and diagrams are filtered by event type', () => {
  assert.deepEqual(
    attributesFor(def, 'save').map((a) => a.key),
    ['notes', 'technique'],
  );
  assert.deepEqual(
    attributesFor(def, 'goal').map((a) => a.key),
    ['notes', 'preventable'],
  );
  assert.deepEqual(
    attributesFor(def, null).map((a) => a.key),
    ['notes'],
  );
  assert.equal(diagramsFor(def, 'save').length, 1);
  assert.equal(diagramsFor(def, null).length, 0);
});
