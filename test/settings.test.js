const assert = require('assert');
const { test } = require('node:test');
const settings = require('../src/settings');

test('normalizes unsupported intervals to fallback values', () => {
  assert.strictEqual(settings.normalizeInterval(1.5, settings.SCAN_INTERVALS, 2), 2);
  assert.strictEqual(settings.normalizeInterval(0.5, settings.SCAN_INTERVALS, 2), 0.5);
});

test('converts supported hour intervals to cron expressions', () => {
  assert.strictEqual(settings.hoursToCron(0.5), '*/30 * * * *');
  assert.strictEqual(settings.hoursToCron(1), '0 * * * *');
  assert.strictEqual(settings.hoursToCron(4), '0 */4 * * *');
  assert.strictEqual(settings.hoursToCron(24), '0 0 * * *');
});

test('computes wall-clock next run matching cron schedule', () => {
  const twoHours = settings.nextRunFromInterval(2, new Date(2026, 5, 6, 12, 45, 20));
  assert.strictEqual(twoHours.getHours(), 14);
  assert.strictEqual(twoHours.getMinutes(), 0);

  const halfHour = settings.nextRunFromInterval(0.5, new Date(2026, 5, 6, 12, 31, 20));
  assert.strictEqual(halfHour.getHours(), 13);
  assert.strictEqual(halfHour.getMinutes(), 0);
});

test('shouldApplyOnArrival: fires only for new codes with all guards clear', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const base = { queued: 2, applyRunning: false, lastApplyAt: null, lastRateLimitedAt: null, now };

  assert.strictEqual(settings.shouldApplyOnArrival(base), true);
  // no new codes → never
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, queued: 0 }), false);
  // a run is already in progress → never
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, applyRunning: true }), false);
  // last run finished 10 min ago → inside the 30-min gap
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, lastApplyAt: new Date(now - 10 * 60000) }), false);
  // last run finished 31 min ago → gap cleared
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, lastApplyAt: new Date(now - 31 * 60000) }), true);
  // rate-limited 1h ago → inside the 2h backoff, even with the gap cleared
  assert.strictEqual(settings.shouldApplyOnArrival({
    ...base, lastApplyAt: new Date(now - 31 * 60000), lastRateLimitedAt: new Date(now - 60 * 60000),
  }), false);
  // rate-limited 3h ago → backoff cleared
  assert.strictEqual(settings.shouldApplyOnArrival({
    ...base, lastApplyAt: new Date(now - 31 * 60000), lastRateLimitedAt: new Date(now - 180 * 60000),
  }), true);
});
