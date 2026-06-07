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
