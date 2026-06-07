const assert = require('assert');
const { test } = require('node:test');
const { extractCodes } = require('../src/extractor');

test('extracts common promo code shapes', () => {
  assert.deepStrictEqual([...extractCodes(['code: SAVE20'])], ['SAVE20']);
  assert.deepStrictEqual([...extractCodes(['OneDay10 worked for me'])], ['ONEDAY10']);
  assert.deepStrictEqual([...extractCodes(['use ABCD for $5 off'])], ['ABCD']);
});

test('filters common false positives and markup fragments', () => {
  assert.deepStrictEqual([...extractCodes(['I tried FLAGSTAFF and it worked'])], []);
  assert.deepStrictEqual([...extractCodes(['promo: <IMG SRC=x ONERROR=alert(1)> $5 off'])], []);
});
