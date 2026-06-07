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

parserTest('parses Slickdeals thread: code from meta description, community signals', () => {
  const html = `
    <html>
      <head>
        <meta name="description" content="Postmates $20 off $30+ for Los Angeles. Expires 05-25-2027 Use promo code: BEACHRUN">
        <title>Postmates $20 off $30</title>
      </head>
      <body>
        <h1>Postmates $20 off $30+ for Los Angeles</h1>
        <div>Expires 05-25-2027</div>
        <div class="comment">Worked for me in Los Angeles</div>
        <div class="comment">Still working tonight</div>
      </body>
    </html>
  `;

  const parsed = parseSlickdealsThread(html, 'https://slickdeals.net/f/example');
  assert.ok(parsed, 'should return an entry for a live deal');
  assert.strictEqual(parsed.code, 'BEACHRUN');
  assert.strictEqual(parsed.sourceKey, 'slickdeals_postmates');
  assert.strictEqual(parsed.region, 'Los Angeles');
  assert.strictEqual(parsed.expiresAt, '2027-05-25');
  assert.strictEqual(parsed.statusHint, 'Community verified');
});

parserTest('skips expired Slickdeals threads', () => {
  const html = `
    <html>
      <head>
        <meta name="description" content="Postmates deal. Use promo code: OLDCODE">
      </head>
      <body>
        <div class="expiredDealAlertBar">Heads up, this deal has expired.</div>
        <div class="slickdealsBadge dealCardBadge dealCardBadge--expired">expired</div>
      </body>
    </html>
  `;

  assert.strictEqual(parseSlickdealsThread(html, 'https://slickdeals.net/f/example'), null);
});

parserTest('filters new-customer Slickdeals offers', () => {
  const html = `
    <html>
      <head>
        <meta name="description" content="Postmates new customer offer. Use promo code: FRESH20">
      </head>
      <body>
        <h1>Postmates new customer offer</h1>
        <div>For new customers on first order only</div>
      </body>
    </html>
  `;

  assert.strictEqual(parseSlickdealsThread(html, 'https://slickdeals.net/f/example'), null);
});
