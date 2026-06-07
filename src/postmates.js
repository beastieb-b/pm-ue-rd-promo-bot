const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const cfg = require('./config');
const state = require('./state');
const { notifySuccess } = require('./notify');

let _context = null;

// Tracks actual login state based on real navigation results (not cookies)
// null = unknown, true = confirmed working, false = confirmed not logged in
let _sessionValid = null;
function getSessionValid() { return _sessionValid; }
function setSessionValid(v) { _sessionValid = v; }

async function getBrowserContext(headless = true) {
  if (_context) {
    try {
      const pages = await _context.pages();
      // Also verify the browser process is still alive by checking page count
      if (pages !== undefined) return _context;
      throw new Error('dead context');
    } catch {
      // Context is stale — close it and start fresh
      try { await _context.close(); } catch {}
      _context = null;
    }
  }

  _context = await chromium.launchPersistentContext(cfg.BROWSER_PROFILE_DIR, {
    channel: 'chrome',
    headless,
    args: [
      '--no-first-run',
      '--disable-default-apps',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 800 },
  });

  return _context;
}

async function closeBrowser() {
  if (_context) {
    try { await _context.close(); } catch {}
    _context = null;
  }
}

// ── First-run setup: open headed browser so user can log in ─────────────────

async function setupLogin() {
  console.log('\n🔐 Opening Postmates in Chrome for login...');
  console.log('   Please log in, then close the browser window when done.\n');

  const ctx = await getBrowserContext(false); // headed
  const page = await ctx.newPage();
  await page.goto('https://postmates.com', { waitUntil: 'domcontentloaded' });

  // Wait until user closes the browser
  await new Promise(resolve => ctx.on('close', resolve));
  _context = null;
  _sessionValid = null; // reset — will be confirmed on next apply run
  console.log('\n✅ Browser closed — login session saved.\n');
}

// ── Result detection from page content ──────────────────────────────────────

function extractRejectionReason(bodyText) {
  if (bodyText.includes('expired')) return 'Code expired';
  if (bodyText.includes('not eligible')) return 'Not eligible for your account';
  if (bodyText.includes('not valid') || bodyText.includes('promotion code is not')) return 'Code not valid';
  if (bodyText.includes('already been used') || bodyText.includes('already used')) return 'Already used';
  if (bodyText.includes('invalid')) return 'Invalid code';
  if (bodyText.includes('oops')) return 'Error applying code';
  if (bodyText.includes('error') && !bodyText.includes('delivery')) return 'Error applying code';
  return null;
}

async function detectResult(page) {
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

  // Rate limit signals
  if (
    bodyText.includes('too many') ||
    bodyText.includes('rate limit') ||
    bodyText.includes('toomany') ||
    bodyText.includes('too many requests')
  ) {
    return { result: 'ratelimited', detail: 'Rate limit detected' };
  }

  // Success: promo applied — require specific combination to avoid false positives
  // ("enjoy" alone appears in footers/banners; must be paired with a dollar amount or specific phrases)
  const successSignal =
    bodyText.includes('see eligible stores') ||
    bodyText.includes('promo applied') ||
    bodyText.includes('added to your account') ||
    /enjoy\s+\$\d+\s+off/.test(bodyText) ||
    /enjoy.*\d+%\s+off/.test(bodyText);
  if (successSignal) {
    // Extract the savings amount in whatever format Postmates shows it
    const savingsMatch =
      bodyText.match(/enjoy\s+(\$\d+(?:\.\d+)?)\s+off/i) ||   // "Enjoy $20 off"
      bodyText.match(/enjoy\s+(\d+%)\s+off/i) ||               // "Enjoy 10% off"
      bodyText.match(/(\$\d+(?:\.\d+)?)\s+off\s+your/i) ||     // "$20 off your order"
      bodyText.match(/save\s+(\$\d+(?:\.\d+)?)/i) ||           // "Save $20"
      bodyText.match(/(\d+%\s+off)/i);                          // "10% off"
    const savings = savingsMatch
      ? savingsMatch[1].trim().replace(/^\w/, c => c.toUpperCase())
      : null;
    return { result: 'success', detail: savings ? `${savings} off` : 'Applied!' };
  }

  // Rejection signals — extract specific reason
  const reason1 = extractRejectionReason(bodyText);
  if (reason1) return { result: 'rejected', detail: reason1 };

  // If no signal yet, wait and check again — run the full success check, not a subset
  await page.waitForTimeout(3000);
  const bodyText2 = await page.evaluate(() => document.body.innerText.toLowerCase());
  const reason2 = extractRejectionReason(bodyText2);
  if (reason2) return { result: 'rejected', detail: reason2 };
  const successSignal2 =
    bodyText2.includes('see eligible stores') ||
    bodyText2.includes('promo applied') ||
    bodyText2.includes('added to your account') ||
    /enjoy\s+\$\d+(?:\.\d+)?\s+off/.test(bodyText2) ||
    /enjoy.*\d+%\s+off/.test(bodyText2);
  if (successSignal2) {
    const savingsMatch2 =
      bodyText2.match(/enjoy\s+(\$\d+(?:\.\d+)?)\s+off/i) ||
      bodyText2.match(/enjoy\s+(\d+%)\s+off/i) ||
      bodyText2.match(/(\$\d+(?:\.\d+)?)\s+off\s+your/i) ||
      bodyText2.match(/save\s+(\$\d+(?:\.\d+)?)/i) ||
      bodyText2.match(/(\d+%\s+off)/i);
    const savings2 = savingsMatch2 ? savingsMatch2[1].trim().replace(/^\w/, c => c.toUpperCase()) : null;
    return { result: 'success', detail: savings2 ? `${savings2} off` : 'Applied!' };
  }

  // Save a screenshot for debugging — helps identify what Postmates shows when
  // detection strings don't match the current UI.
  try {
    const debugDir = path.join(cfg.DATA_DIR, 'debug-screenshots');
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(debugDir, `unknown-${ts}.png`), fullPage: false });
  } catch {}

  return { result: 'unknown', detail: 'Could not determine result' };
}

// ── Apply a single promo code ────────────────────────────────────────────────

async function dismissPopups(page) {
  // Dismiss cookie banners / consent notices — deliberately excludes 'Close' and 'Dismiss'
  // because those words appear on the promo modal's own X button and would close it.
  const dismissTexts = ['Got it', 'Accept', 'OK', 'DONE'];
  for (const text of dismissTexts) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click();
        await page.waitForTimeout(400);
      }
    } catch {}
  }
}

async function applyCode(page, code) {
  // Navigate to promo modal URL
  await page.goto(cfg.PROMO_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Dismiss any blocking popups before interacting
  await dismissPopups(page);

  // Check if we got redirected away from Postmates entirely (not logged in)
  // Allow any postmates.com page — only flag if we left the domain or hit /login
  const url = page.url();
  const onPostmates = url.includes('postmates.com') && !url.includes('/login') && !url.includes('/signin');
  if (!onPostmates) {
    _sessionValid = false;
    return { result: 'not_logged_in', detail: 'Redirected — use Settings → Log in to Postmates' };
  }
  _sessionValid = true;

  // Wait up to 8s for the promo modal to appear — the URL params trigger it
  // lazily in React, so it often renders after the initial page load.
  const modalLocator = page.locator('[role="dialog"], [aria-modal="true"]').first();
  try {
    await modalLocator.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    // Modal didn't appear — take a debug screenshot and bail; typing into
    // the global search bar (the next visible input) is worse than failing.
    try {
      const debugDir = path.join(cfg.DATA_DIR, 'debug-screenshots');
      fs.mkdirSync(debugDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: path.join(debugDir, `no-modal-${ts}.png`), fullPage: false });
    } catch {}
    return { result: 'error', detail: 'Promo modal did not open' };
  }

  // Dismiss any popups that appeared after navigation before clicking the input
  await dismissPopups(page);

  // Find the promo code input — scope to the modal so we never match the
  // global search bar. 'input[type="text"]' is intentionally excluded; it is
  // far too broad and would match any input on the page.
  const inputSelectors = [
    'input[placeholder*="promo" i]',
    'input[placeholder*="code" i]',
    'input[data-testid*="promo"]',
    'input[name*="promo"]',
    'input[aria-label*="promo" i]',
    'input[aria-label*="code" i]',
  ];

  let inputLocator = null;

  // Try modal-scoped selectors first
  for (const sel of inputSelectors) {
    try {
      const loc = modalLocator.locator(sel).first();
      if (await loc.isVisible({ timeout: 3000 })) {
        inputLocator = loc;
        break;
      }
    } catch {}
  }

  // Fallback: any input inside the modal (excludes the global search bar)
  if (!inputLocator) {
    try {
      const loc = modalLocator.locator('input').first();
      if (await loc.isVisible({ timeout: 3000 })) {
        inputLocator = loc;
      }
    } catch {}
  }

  if (!inputLocator) {
    return { result: 'error', detail: 'Could not find promo input inside modal' };
  }

  // Clear and type the code
  await inputLocator.click({ clickCount: 3 });
  await inputLocator.fill('');
  await page.keyboard.type(code, { delay: 80 });
  await page.waitForTimeout(500);

  // Verify text appeared in input
  const inputVal = await inputLocator.inputValue();
  if (!inputVal.trim()) {
    // Retry once with a slower type
    await inputLocator.fill('');
    for (const char of code) {
      await page.keyboard.type(char);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);
    const inputVal2 = await inputLocator.inputValue();
    if (!inputVal2.trim()) {
      return { result: 'error', detail: 'Text did not appear in input field' };
    }
  }

  // Find and click the Apply button using Playwright's locator API
  // waitForSelector with :has-text() is unreliable in Playwright 1.40+ — use locators instead
  let clicked = false;

  // Try text-based locators first (most precise)
  const textCandidates = ['APPLY', 'Apply', 'Redeem', 'Submit'];
  for (const text of textCandidates) {
    try {
      const loc = page.getByRole('button', { name: text, exact: true });
      if (await loc.isVisible({ timeout: 2000 })) {
        await loc.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  // Try data-testid fallback
  if (!clicked) {
    try {
      const loc = page.locator('[data-testid*="apply"]');
      if (await loc.isVisible({ timeout: 1500 })) { await loc.click(); clicked = true; }
    } catch {}
  }

  // Last resort — press Enter in the input field
  if (!clicked) {
    await inputLocator.press('Enter');
  }

  return await detectResult(page);
}

// ── Main apply run ───────────────────────────────────────────────────────────

async function runApplyCodes(options = {}) {
  const { maxCodes = cfg.MAX_CODES_PER_RUN, onProgress } = options;

  state.appendLog({ type: 'apply_run_start' });

  const queue = state.getQueue();
  const processed = new Set(state.getProcessed().map(r => r.code));
  const pending = queue.filter(c => !processed.has(c)).slice(0, maxCodes);

  if (!pending.length) {
    state.appendLog({ type: 'apply_run_done', reason: 'no_pending_codes' });
    return { applied: 0, results: [], reason: 'No codes in queue' };
  }

  let ctx;
  try {
    // Must run headed — Postmates detects and blocks headless Chrome
    ctx = await getBrowserContext(false);
  } catch (err) {
    state.appendLog({ type: 'apply_run_error', error: err.message });
    return { error: `Browser failed to launch: ${err.message}` };
  }

  const page = await ctx.newPage();
  const results = [];
  let rateLimited = false;

  for (const code of pending) {
    if (rateLimited) break;

    if (onProgress) onProgress({ code, status: 'trying' });

    let applyResult;
    try {
      applyResult = await applyCode(page, code);
    } catch (err) {
      applyResult = { result: 'error', detail: err.message.slice(0, 100) };
    }

    results.push({ code, ...applyResult });
    state.appendLog({ type: 'code_result', code, result: applyResult.result, detail: applyResult.detail });

    if (onProgress) onProgress({ code, status: applyResult.result, detail: applyResult.detail });

    if (applyResult.result === 'ratelimited') {
      rateLimited = true;
      // Code that hit the limit + all remaining pending codes stay in queue automatically
      // (markResult is never called → removeFromQueue is never called)
      const remaining = pending.slice(pending.indexOf(code)); // includes this code
      state.appendLog({ type: 'rate_limited', code, codes_preserved: remaining.length });
      if (onProgress) onProgress({ code, status: 'rate_limited_stop', preserved: remaining.length });
      break;
    }

    if (applyResult.result === 'not_logged_in' || applyResult.result === 'error') {
      // Transient failure — code stays in queue and retries automatically next run
      state.appendLog({ type: 'code_deferred', code, reason: applyResult.result, note: 'will retry next run' });
      continue;
    }

    // Permanent results (success / rejected / unknown) — mark and remove from queue
    state.markResult(code, applyResult.result, applyResult.detail);

    if (applyResult.result === 'success') {
      notifySuccess(code, applyResult.detail);
    }

    // Wait between codes to avoid rate limiting (skip wait after last code)
    if (code !== pending[pending.length - 1] && !rateLimited) {
      if (onProgress) onProgress({ code, status: 'waiting', waitMs: cfg.CODE_WAIT_MS });
      await page.waitForTimeout(cfg.CODE_WAIT_MS);
    }
  }

  await page.close();

  state.appendLog({
    type: 'apply_run_done',
    applied: results.length,
    successes: results.filter(r => r.result === 'success').length,
    rateLimited,
  });

  return { applied: results.length, results, rateLimited };
}

module.exports = { runApplyCodes, setupLogin, closeBrowser, getBrowserContext, getSessionValid };
