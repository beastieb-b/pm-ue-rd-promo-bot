const { test } = require('node:test');
const assert = require('node:assert');
const { detectRegionRestriction, isUsableLocation, extractAppliedLocation, formatRegion } = require('../src/region');

test('isUsableLocation: home / statewide / national count as usable', () => {
  for (const loc of ['Los Angeles', 'SoCal', 'Southern California', 'California', 'Nationwide', 'United States', 'Everywhere', null, '']) {
    assert.equal(isUsableLocation(loc), true, `${loc} should be usable`);
  }
});

test('isUsableLocation: specific non-SoCal localities are NOT usable', () => {
  for (const loc of ['Las Vegas', 'Phoenix', 'San Francisco', 'San Diego', 'New York', 'Seattle']) {
    assert.equal(isUsableLocation(loc), false, `${loc} should not be usable`);
  }
});

test('extractAppliedLocation: pulls the Location field from modal text', () => {
  const modal = 'enjoy $10 off\nexpiration\njun 21\nlocation\nlas vegas\ndetails\n$25 minimum';
  assert.equal(extractAppliedLocation(modal), 'las vegas');
  assert.equal(extractAppliedLocation('promo applied\nsee eligible stores'), null);
});

test('detectRegionRestriction: flags non-home "only" restrictions, not bare mentions', () => {
  assert.equal(detectRegionRestriction('VEGAS20 vegas only').restricted, true);
  assert.equal(detectRegionRestriction('CODE only works in phoenix').restricted, true);
  assert.equal(detectRegionRestriction('SAVE worked in los angeles').restricted, false);
  // a bare "worked in vegas" mention is not a restriction
  assert.equal(detectRegionRestriction('SPRING worked in vegas for me'), null);
});

test('formatRegion: uppercases known abbreviations', () => {
  assert.equal(formatRegion('lv'), 'LV');
  assert.equal(formatRegion('las vegas'), 'Las Vegas');
});
