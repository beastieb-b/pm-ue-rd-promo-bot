const assert = require('assert');
const { test } = require('node:test');
const { parseSlickdealsThread } = require('../src/reddit');

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
