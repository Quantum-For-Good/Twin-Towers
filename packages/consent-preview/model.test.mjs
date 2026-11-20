import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleValue, initialSelection, selectedCategories } from './model.mjs';

test('example values and categories follow the selected fields', () => {
  assert.equal(exampleValue(initialSelection), '2.50');
  assert.equal(exampleValue({ ...initialSelection, routes: false }), '1.80');
  assert.deepEqual(selectedCategories({ distance: true, routes: false, shoe: true }), ['Distance & pace', 'Shoe type']);
});

test('all combinations use exact cents without negative or rounding errors', () => {
  for (let mask = 0; mask < 8; mask++) {
    const selection = { distance: !!(mask & 1), routes: !!(mask & 2), shoe: !!(mask & 4) };
    const cents = (selection.distance ? 90 : 0) + (selection.routes ? 70 : 0) + (selection.shoe ? 90 : 0);
    assert.equal(exampleValue(selection), (cents / 100).toFixed(2));
    assert.equal(selectedCategories(selection).length, Object.values(selection).filter(Boolean).length);
  }
});
