// Debug: run the REAL applyCode() path against a test code and print the verdict.
const { chromium } = require('./node_modules/playwright');
const path = require('path');
const os = require('os');

const TEST_CODE = process.argv[2] || 'TESTCODE99';
const profileDir = path.join(os.homedir(), 'Claude/postmates-promo-app/data/browser-profile');

// Load the real module functions by requiring postmates internals is hard
// (they're not exported), so replicate the flow using the same logic inline
// is error-prone. Instead, just drive a browser and call the exported runner
// would apply many codes. For a single-code test we inline a minimal version
// that mirrors applyCode + detectResult closely enough to observe behavior.

(async () => {
  console.log(`\n🧪 Testing: ${TEST_CODE}\n`);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const URL = 'https://postmates.com/feed?diningMode=DELIVERY&mod=promos&ps=1';

  const dismiss = async () => {
    for (const t of ['Got it', 'Accept', 'OK', 'DONE']) {
      try { const b = page.getByRole('button', { name: t, exact: true });
        if (await b.isVisible({ timeout: 600 })) { await b.click(); await page.waitForTimeout(300); } } catch {}
    }
  };
  const modalText = () => page.evaluate(() => {
    const m = document.querySelector('[role="dialog"], [aria-modal="true"]');
    return (m || document.body).innerText.toLowerCase();
  });
  const modalSel = '[role="dialog"]:has(input), [aria-modal="true"]:has(input)';

  // Load twice
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000); await dismiss();
  let open = await page.locator(modalSel).first().isVisible({ timeout: 6000 }).catch(() => false);
  if (!open) {
    console.log('  modal not open on load 1, reloading...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500); await dismiss();
  }
  const modal = page.locator(modalSel).first();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  console.log('  ✅ modal open');

  const input = modal.locator('input[placeholder*="promo" i], input[placeholder*="code" i], input').first();
  await input.click({ clickCount: 3 }); await input.fill('');
  await page.keyboard.type(TEST_CODE, { delay: 70 });
  await page.waitForTimeout(500);
  console.log('  typed, value =', JSON.stringify(await input.inputValue()));

  const before = await modalText();
  console.log('  BEFORE text:', before.replace(/\s+/g, ' ').slice(0, 120));

  // Click apply
  let clicked = false;
  for (const t of ['Apply', 'Redeem', 'Submit']) {
    try { const b = page.getByRole('button', { name: t, exact: false });
      if (await b.isVisible({ timeout: 1500 })) { await b.click(); clicked = true; console.log('  clicked', t); break; } } catch {}
  }
  if (!clicked) { await input.press('Enter'); console.log('  pressed Enter'); }

  // Poll
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(2000);
    const t = await modalText();
    const stillOpen = await page.locator(modalSel).first().isVisible({ timeout: 400 }).catch(() => false);
    const newText = t.split('').length !== before.split('').length;
    console.log(`  t+${i*2}s modalOpen=${stillOpen} | text: ${t.replace(/\s+/g, ' ').slice(0, 130)}`);
  }

  await page.screenshot({ path: '/tmp/debug_final.png' });
  console.log('\n  screenshot: /tmp/debug_final.png');
  await context.close();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
