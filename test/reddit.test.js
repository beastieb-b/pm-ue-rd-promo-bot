const assert = require('assert');
const { test } = require('node:test');
const { parseSlickdealsThread, parseSimplyCodesPage } = require('../src/reddit');

const hasCheerio = (() => {
  try {
    require.resolve('cheerio');
    return true;
  } catch {
    return false;
  }
})();

const parserTest = hasCheerio ? test : test.skip;

parserTest('parses Slickdeals Postmates thread metadata and comment signals', () => {
  const html = `
    <html>
      <head><title>Postmates $20 off $30</title></head>
      <body>
        <h1>Postmates $20 off $30+ for Los Angeles</h1>
        <div>Use promo code: BEACHRUN</div>
        <div>Expires 05-25-2026</div>
        <div class="comment">Worked for me in Los Angeles</div>
        <div class="comment">Still working tonight</div>
      </body>
    </html>
  `;

  const parsed = parseSlickdealsThread(html, 'https://slickdeals.net/f/example');
  assert.ok(parsed);
  assert.strictEqual(parsed.code, 'BEACHRUN');
  assert.strictEqual(parsed.sourceKey, 'slickdeals_postmates');
  assert.strictEqual(parsed.region, 'Los Angeles');
  assert.strictEqual(parsed.expiresAt, '2026-05-25');
  assert.strictEqual(parsed.statusHint, 'Community verified');
});

parserTest('filters new-customer Slickdeals offers', () => {
  const html = `
    <html>
      <body>
        <h1>Postmates new customer offer</h1>
        <div>Use promo code: FRESH20</div>
        <div>For new customers on first order only</div>
      </body>
    </html>
  `;

  assert.strictEqual(parseSlickdealsThread(html, 'https://slickdeals.net/f/example'), null);
});

parserTest('parses reusable SimplyCodes verification activity', () => {
  const body = [
    'Random heading',
    'Jane reported promo code affeats10us526 as working successfully 2 hours ago',
    'More surrounding text',
    'Another user verified promo code affeats10us526 today',
  ].join('\n');

  const parsed = parseSimplyCodesPage(body, 'https://simplycodes.com/store/ubereats.com');
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].code, 'AFFEATS10US526');
  assert.strictEqual(parsed[0].sourceKey, 'simplycodes_ubereats');
  assert.strictEqual(parsed[0].statusHint, 'Recently verified');
});

parserTest('filters first-order and referral SimplyCodes entries', () => {
  const body = [
    'Alice reported promo code FIRST20 as working successfully',
    'first order only for new customers',
    'Bob verified promo code REFER25',
    'referral bonus',
  ].join('\n');

  const parsed = parseSimplyCodesPage(body, 'https://simplycodes.com/store/ubereats.com');
  assert.deepStrictEqual(parsed, []);
});
