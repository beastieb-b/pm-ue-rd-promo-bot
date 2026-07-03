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

test('getRecentlyApplied: only codes inside the window', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const day = 86400000;
  const ledger = {
    FRESH: new Date(now - 2 * day).toISOString(),      // 2 days ago — inside
    EDGE: new Date(now - 13.9 * day).toISOString(),    // just inside 14d
    OLD: new Date(now - 15 * day).toISOString(),       // outside — eligible again
    BROKEN: 'not-a-date',                              // ignored
  };
  const recent = state.getRecentlyApplied(state.REAPPLY_SKIP_DAYS, ledger, now);
  assert.ok(recent.has('FRESH'));
  assert.ok(recent.has('EDGE'));
  assert.ok(!recent.has('OLD'));
  assert.ok(!recent.has('BROKEN'));
  assert.strictEqual(state.REAPPLY_SKIP_DAYS, 14);
});

test('computeThreadState: found / waiting / stale / unknown', () => {
  const G = state.STALE_THREAD_GRACE_DAYS; // 3
  // Current-month thread loaded → found (regardless of day)
  assert.strictEqual(state.computeThreadState('2026-07', '2026-07', 1), 'found');
  assert.strictEqual(state.computeThreadState('2026-07', '2026-07', 20), 'found');
  // Behind, but within the grace window → waiting (NOT stale). This is the
  // rollover case the local/UTC skew bug used to misreport as stale.
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', 1), 'waiting');
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', G - 1), 'waiting');
  // Behind, past the grace window → stale
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', G), 'stale');
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', 10), 'stale');
  // No month recorded yet → unknown
  assert.strictEqual(state.computeThreadState(null, '2026-07', 5), 'unknown');
});
