// Debug: test the full apply flow with screenshots at each step
const { chromium } = require('./node_modules/playwright');
const path = require('path');
const os = require('os');

const TEST_CODE = process.argv[2] || 'TESTCODE99';
const PROMO_URL = 'https://postmates.com/feed?diningMode=DELIVERY&mod=promos&ps=1';
const profileDir = path.join(os.homedir(), 'Claude/postmates-promo-app/data/browser-profile');

(async () => {
  console.log(`\n🧪 Testing promo code: ${TEST_CODE}\n`);

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // ── Step 1: navigate ──────────────────────────────────────────────────────
  console.log('Step 1: navigating to promo URL...');
  await page.goto(PROMO_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/debug_step1_after_nav.png' });
  console.log('  → screenshot: /tmp/debug_step1_after_nav.png');

  // ── Step 2: dismiss popups ────────────────────────────────────────────────
  for (const text of ['Got it', 'Accept', 'OK', 'DONE']) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click();
        await page.waitForTimeout(400);
        console.log(`  → dismissed popup: "${text}"`);
      }
    } catch {}
  }

  // ── Step 3: wait for promo modal ──────────────────────────────────────────
  console.log('Step 2: waiting for promo modal [role=dialog]...');
  const modalLocator = page.locator('[role="dialog"], [aria-modal="true"]').first();
  let modalFound = false;
  try {
    await modalLocator.waitFor({ state: 'visible', timeout: 8000 });
    modalFound = true;
    console.log('  ✅ Modal appeared!');
  } catch {
    console.log('  ❌ Modal did NOT appear within 8 seconds');
  }
  await page.screenshot({ path: '/tmp/debug_step2_modal_check.png' });
  console.log('  → screenshot: /tmp/debug_step2_modal_check.png');

  if (!modalFound) {
    // Print all visible inputs on the page so we can diagnose what's there
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(el => ({
        type: el.type,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        name: el.name,
        id: el.id,
        visible: el.offsetParent !== null,
      }))
    );
    console.log('\n  All inputs on page:', JSON.stringify(inputs, null, 2));
    console.log('\n  Exiting — cannot safely proceed without the modal.');
    await context.close();
    return;
  }

  // Print what's in the modal
  const modalText = await modalLocator.evaluate(el => el.innerText).catch(() => '(error reading modal text)');
  console.log('  Modal text preview:', modalText.slice(0, 200).replace(/\n/g, ' | '));

  // ── Step 4: find promo input inside modal ─────────────────────────────────
  console.log('Step 3: finding promo input inside modal...');
  const inputSelectors = [
    'input[placeholder*="promo" i]',
    'input[placeholder*="code" i]',
    'input[data-testid*="promo"]',
    'input[name*="promo"]',
    'input[aria-label*="promo" i]',
    'input[aria-label*="code" i]',
  ];

  let inputLocator = null;
  for (const sel of inputSelectors) {
    try {
      const loc = modalLocator.locator(sel).first();
      if (await loc.isVisible({ timeout: 3000 })) {
        inputLocator = loc;
        console.log(`  ✅ Found input via: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!inputLocator) {
    console.log('  Trying fallback: any input inside modal...');
    try {
      const loc = modalLocator.locator('input').first();
      if (await loc.isVisible({ timeout: 3000 })) {
        inputLocator = loc;
        const info = await loc.evaluate(el => ({
          type: el.type, placeholder: el.placeholder,
          ariaLabel: el.getAttribute('aria-label'), name: el.name,
        }));
        console.log('  ✅ Found input via fallback:', info);
      }
    } catch {}
  }

  if (!inputLocator) {
    const allInputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(el => ({
        type: el.type, placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'), name: el.name, id: el.id,
        visible: el.offsetParent !== null,
      }))
    );
    console.log('  ❌ No input found in modal. All inputs on page:', JSON.stringify(allInputs, null, 2));
    await context.close();
    return;
  }

  // ── Step 5: type code ─────────────────────────────────────────────────────
  console.log(`Step 4: typing code "${TEST_CODE}"...`);
  await inputLocator.click({ clickCount: 3 });
  await inputLocator.fill('');
  await page.keyboard.type(TEST_CODE, { delay: 80 });
  await page.waitForTimeout(600);

  const typedVal = await inputLocator.inputValue();
  console.log(`  → input value: "${typedVal}" ${typedVal === TEST_CODE ? '✅' : '❌ MISMATCH'}`);
  await page.screenshot({ path: '/tmp/debug_step3_typed.png' });
  console.log('  → screenshot: /tmp/debug_step3_typed.png');

  // ── Step 6: click Apply ───────────────────────────────────────────────────
  console.log('Step 5: clicking Apply...');
  let clicked = false;
  for (const text of ['APPLY', 'Apply', 'Redeem', 'Submit']) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        clicked = true;
        console.log(`  ✅ Clicked button: "${text}"`);
        break;
      }
    } catch {}
  }
  if (!clicked) {
    await inputLocator.press('Enter');
    console.log('  → pressed Enter as fallback');
  }

  // ── Step 7: read result at intervals ─────────────────────────────────────
  console.log('Step 6: reading result...');
  const successWords = ['enjoy', 'eligible', 'applied', 'added to your account', 'promo applied'];
  const rejectWords  = ['not valid', 'not eligible', 'expired', 'invalid', 'oops', 'error applying',
                        'already used', 'already been used', 'unable', 'sorry'];

  for (let i = 1; i <= 8; i++) {
    await page.waitForTimeout(1000);
    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
    const hits = [...successWords, ...rejectWords].filter(w => body.includes(w));
    const tag = successWords.some(w => body.includes(w)) ? '✅ SUCCESS signal'
              : rejectWords.some(w => body.includes(w)) ? '❌ REJECT signal'
              : '⏳ no signal yet';
    console.log(`  t+${i}s: ${tag} [${hits.join(', ')}]`);
    if (hits.length) {
      const lines = body.split('\n').filter(l => hits.some(h => l.includes(h)));
      lines.slice(0, 4).forEach(l => console.log('    >', l.trim().slice(0, 120)));
      await page.screenshot({ path: `/tmp/debug_step4_result_t${i}s.png` });
      console.log(`  → screenshot: /tmp/debug_step4_result_t${i}s.png`);
      break;
    }
  }

  await page.screenshot({ path: '/tmp/debug_step4_final.png' });
  console.log('  → final screenshot: /tmp/debug_step4_final.png');

  console.log('\nDone. Closing browser...');
  await context.close();
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
