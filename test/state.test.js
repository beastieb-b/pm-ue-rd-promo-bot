const assert = require('assert');
const { test } = require('node:test');
const state = require('../src/state');

test('normalizes safe promo codes', () => {
  assert.strictEqual(state.normalizeCode(' save20 '), 'SAVE20');
  assert.strictEqual(state.normalizeCode('ABC_123-XYZ'), 'ABC_123-XYZ');
});

test('rejects unsafe or line-based promo code input', () => {
  assert.strictEqual(state.normalizeCode('A\nB'), null);
  assert.strictEqual(state.normalizeCode('<IMG SRC=x>'), null);
  assert.strictEqual(state.normalizeCode('abc'), null);
  assert.strictEqual(state.normalizeCode('A'.repeat(33)), null);
});
