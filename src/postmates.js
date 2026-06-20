const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const cfg = require('./config');
const state = require('./state');
const { notifySuccess } = require('./notify');

let _context = null;
let _setupRunning = false;
let _applyRunning = false;

// Tracks actual login state based on real navigation results (not cookies)
// null = unknown, true = confirmed working, false = confirmed not logged in
// Load persisted session state so "Logged in" status survives daemon restarts.
let _sessionValid = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.SESSION_STATE_FILE, 'utf8'));
    return data.sessionValid ?? null;
  } catch { return null; }
})();

function getSessionValid() { return _sessionValid; }
function setSessionValid(v) {
  _sessionValid = v;
  try { fs.writeFileSync(cfg.SESSION_STATE_FILE, JSON.stringify({ sessionValid: v })); } catch {}
}

async function getBrowserContext(headless = true) {
  if (_context) return _context;

  _context = await chromium.launchPersistentContext(cfg.BROWSER_PROFILE_DIR, {
    channel: 'chrome',
    headless,
    chromiumSandbox: true,   // prevents Playwright from injecting --no-sandbox
    args: [
      '--no-first-run',
      '--disable-default-apps',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 800 },
  });

  return _context;
}

// Open a new page, surviving a dead cached context. context.pages() reads
// Playwright's local state and never detects that Chrome actually quit —
// newPage() is the only honest liveness check, so we try it and relaunch
// the browser once if the cached context turns out to be closed.
async function getPage(headless = false) {
  const ctx = await getBrowserContext(headless);
  try {
    return await ctx.newPage();
  } catch (err) {
    if (!/closed/i.test(err.message)) throw err;
    try { await _context.close(); } catch {}
    _context = null;
    const fresh = await getBrowserContext(headless);
    return await fresh.newPage();
  }
}

async function closeBrowser() {
  if (_context) {
    try { await _context.close(); } catch {}
    _context = null;
  }
}

// ── First-run setup: open headed browser so user can log in ─────────────────

async function setupLogin() {
  if (_applyRunning) throw new Error('Code applier is running; try login again when it finishes');
  if (_setupRunning) throw new Error('Login setup is already running');
  _setupRunning = true;
  console.log('\n🔐 Opening Postmates in Chrome for login...');
  console.log('   Please log in, then close the browser window when done.\n');

  try {
    const page = await getPage(false); // headed
    await page.goto('https://postmates.com', { waitUntil: 'domcontentloaded' });

    // Wait until user closes the browser
    await new Promise(resolve => page.context().on('close', resolve));
    _context = null;
    setSessionValid(null); // reset — will be confirmed on next apply run
    console.log('\n✅ Browser closed — login session saved.\n');
  } finally {
    _setupRunning = false;
  }
}

// ── Result detection from page content ──────────────────────────────────────

// Each rejection signal: the phrase Postmates shows → the human-readable reason.
// Order matters — more specific phrases first.
const REJECTION_SIGNALS = [
  ['promotion code is not valid', 'Code not valid'],
  ['not valid', 'Code not valid'],
  ['not eligible', 'Not eligible for your account'],
  ['already been used', 'Already used'],
  ['already used', 'Already used'],
  ['expired', 'Code expired'],
  ['invalid', 'Invalid code'],
  ['oops', 'Error applying code'],
];

// Returns { phrase, reason } for the first rejection phrase found, or null.
function findRejection(text) {
  for (const [phrase, reason] of REJECTION_SIGNALS) {
    if (text.includes(phrase)) return { phrase, reason };
  }
  return null;
}

function extractRejectionReason(bodyText) {
  return findRejection(bodyText)?.reason || null;
}

async function getResultText(page) {
  // Read the modal's text only — avoids false matches from nav, footer,
  // or unrelated toasts that contain words like "error" or "expired".
  // Falls back to full body if no modal is present.
  return page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
    return (modal || document.body).innerText.toLowerCase();
  });
}

function extractSavings(text) {
  const m =
    text.match(/enjoy\s+(\$\d+(?:\.\d+)?)\s+off/i) ||
    text.match(/enjoy\s+(\d+%)\s+off/i) ||
    text.match(/(\$\d+(?:\.\d+)?)\s+off\s+your/i) ||
    text.match(/save\s+(\$\d+(?:\.\d+)?)/i) ||
    text.match(/(\$\d+(?:\.\d+)?)\s+off/i) ||
    text.match(/(\d+%\s+off)/i);
  return m ? m[1].trim() : null;
}

// Classify the modal/page state. `before` is the modal text captured before
// clicking Apply — we compare against it so the always-present default promos
// ("$20 off", "10% off") don't register as a fresh success.
function classify(text, before) {
  // Rate limit — highest priority, stops the whole run
  if (/too\s*many|rate limit|too many requests|slow down/.test(text)) {
    return { result: 'ratelimited', detail: 'Rate limit detected' };
  }

  // Rejection — only trust a phrase that was NOT already in the modal before
  // applying (the modal lists existing promos whose text could contain words
  // like "expired"). Comparing the trigger phrase, not the label, avoids that.
  const rejection = findRejection(text);
  if (rejection && !before.includes(rejection.phrase)) {
    return { result: 'rejected', detail: rejection.reason };
  }
  // Generic rejection phrasing that the helper may not cover
  if (/couldn'?t (be )?appl|not be applied|unable to|isn'?t valid|doesn'?t exist|no longer valid/.test(text)) {
    return { result: 'rejected', detail: 'Code not valid' };
  }

  // Success — a confirmation interstitial appears with these phrases.
  // "see eligible stores"/"promo applied" are unambiguous success markers.
  const strongSuccess =
    text.includes('see eligible stores') ||
    text.includes('promo applied') ||
    text.includes('added to your account') ||
    text.includes('successfully applied') ||
    /you'?ll (get|enjoy|save)/.test(text);
  if (strongSuccess) {
    const savings = extractSavings(text);
    return { result: 'success', detail: savings ? `${savings} off` : 'Applied!' };
  }

  return null; // undetermined
}

async function detectResult(page, beforeText = '') {
  const before = (beforeText || '').toLowerCase();

  // Poll for up to ~12s — the response can take a few seconds to render
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    const text = await getResultText(page);
    const verdict = classify(text, before);
    if (verdict) return verdict;

    // If the modal CLOSED entirely after applying, that's a success signal on
    // Postmates (the modal dismisses and shows the applied promo on the feed).
    const modalStillOpen = await page
      .locator('[role="dialog"]:has(input), [aria-modal="true"]:has(input)')
      .first().isVisible({ timeout: 500 }).catch(() => false);
    if (!modalStillOpen) {
      const text2 = await getResultText(page);
      const savings = extractSavings(text2);
      return { result: 'success', detail: savings ? `${savings} off` : 'Applied!' };
    }
  }

  // Still undetermined — screenshot for debugging
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
  // Navigate to promo modal URL.
  // First load often redirects to mod=messagingInterstitial ("what's new" popup)
  // instead of the promos modal, so we load, dismiss, then load again.
  await page.goto(cfg.PROMO_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  // Check if we got redirected away from Postmates entirely (not logged in)
  const url = page.url();
  const onPostmates = url.includes('postmates.com') && !url.includes('/login') && !url.includes('/signin');
  if (!onPostmates) {
    setSessionValid(false);
    return { result: 'not_logged_in', detail: 'Redirected — use Settings → Log in to Postmates' };
  }
  setSessionValid(true);

  // Scope to dialogs that contain an input so we never grab a cookie banner or
  // address confirmation modal that happens to appear at the same time.
  const modalSelector = '[role="dialog"]:has(input), [aria-modal="true"]:has(input)';
  let modalLocator = page.locator(modalSelector).first();
  let modalOpen = await modalLocator.isVisible({ timeout: 6000 }).catch(() => false);

  // If the interstitial hijacked the first load, navigate again — the promo
  // modal reliably appears on the second visit.
  if (!modalOpen) {
    await page.goto(cfg.PROMO_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    await dismissPopups(page);
    modalLocator = page.locator(modalSelector).first();
  }

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

  // Snapshot the modal text BEFORE applying. The promo modal always shows the
  // default "$20 off" / "10% off" promos, so we can only trust text that appears
  // AFTER clicking Apply. detectResult() diffs against this baseline.
  const beforeText = await getResultText(page);

  // Find and click the Apply button using Playwright's locator API
  // waitForSelector with :has-text() is unreliable in Playwright 1.40+ — use locators instead
  let clicked = false;

  // Try text-based locators — use exact:false so "Apply Code" / "Apply Promo"
  // variants also match, but filter by a short name to avoid matching unrelated buttons.
  const textCandidates = ['Apply', 'Redeem', 'Submit'];
  for (const text of textCandidates) {
    try {
      const loc = page.getByRole('button', { name: text, exact: false });
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

  return await detectResult(page, beforeText);
}

// ── Main apply run ───────────────────────────────────────────────────────────

async function runApplyCodes(options = {}) {
  if (_setupRunning) return { error: 'Login setup is running' };
  if (_applyRunning) return { error: 'Apply run already running' };
  _applyRunning = true;
  const { maxCodes = cfg.MAX_CODES_PER_RUN, onProgress } = options;

  state.appendLog({ type: 'apply_run_start' });

  let page = null;
  try {
    const queue = state.getQueue();
    const processed = new Set(state.getProcessed().map(r => r.code));
    const pending = queue.filter(c => !processed.has(c)).slice(0, maxCodes);

    if (!pending.length) {
      state.appendLog({ type: 'apply_run_done', reason: 'no_pending_codes' });
      return { applied: 0, results: [], reason: 'No codes in queue' };
    }

    // Region restrictions are read from the code catalog (populated during the
    // Reddit scan). Codes locked to a metro other than Los Angeles are skipped
    // so we don't burn apply attempts / rate-limit budget on codes that can't
    // work here. They're marked with a clear reason and can be re-queued by
    // deleting the result if the user wants to try one anyway.
    const catalog = state.getCodeCatalog();

    // Must run headed — Postmates detects and blocks headless Chrome
    page = await getPage(false);
    const results = [];
    let rateLimited = false;

    for (const code of pending) {
      if (rateLimited) break;

      const meta = catalog.codes[code] || {};
      if (meta.regionRestricted) {
        const detail = meta.regionNote || `${meta.region || 'Other region'}-only — not valid in Los Angeles`;
        results.push({ code, result: 'region_skip', detail });
        state.appendLog({ type: 'code_result', code, result: 'region_skip', detail });
        state.markResult(code, 'region_skip', detail);
        if (onProgress) onProgress({ code, status: 'region_skip', detail });
        continue;
      }

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

      if (['not_logged_in', 'error', 'unknown'].includes(applyResult.result)) {
        // Transient or ambiguous failure — code stays in queue and retries automatically next run.
        // Add a short cooldown so consecutive failures don't hammer the site back-to-back.
        state.appendLog({ type: 'code_deferred', code, reason: applyResult.result, note: 'will retry next run' });
        if (applyResult.result !== 'not_logged_in' && code !== pending[pending.length - 1]) {
          await page.waitForTimeout(20_000); // 20s cooldown between transient failures
        }
        continue;
      }

      // Permanent results (success / rejected) — mark and remove from queue
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

    state.appendLog({
      type: 'apply_run_done',
      applied: results.length,
      successes: results.filter(r => r.result === 'success').length,
      rateLimited,
    });

    // Health check: if every attempt this run came back unknown/error, the
    // Postmates UI has probably changed and detection is broken. Alert loudly
    // instead of failing silently for days.
    const broken = results.length >= 2 && results.every(r => ['unknown', 'error'].includes(r.result));
    if (broken) {
      state.appendLog({ type: 'detection_health_warning', runs: results.length });
      state.setHealthWarning('All codes returned unknown/error on the last run — the Postmates UI may have changed. Run the self-test in Settings → System Health.');
    }

    return { applied: results.length, results, rateLimited, detectionWarning: broken };
  } catch (err) {
    state.appendLog({ type: 'apply_run_error', error: err.message });
    return { error: `Apply run failed: ${err.message}` };
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    _applyRunning = false;
  }
}

// ── Self-test ────────────────────────────────────────────────────────────────
// End-to-end pipeline check: applies a deliberately fake code through the real
// applyCode() path. A healthy system returns "rejected" (Postmates says the
// code is not valid). Anything else means navigation, input, or detection broke.

async function testDetection() {
  if (_setupRunning) return { ok: false, error: 'Login setup is running' };
  if (_applyRunning) return { ok: false, error: 'Apply run in progress — try again after it finishes' };
  _applyRunning = true;

  const fakeCode = 'SELFTEST' + Math.floor(1000 + Math.random() * 9000);
  let page = null;
  try {
    page = await getPage(false);
    const verdict = await applyCode(page, fakeCode);

    const ok = verdict.result === 'rejected';
    state.appendLog({ type: 'self_test', code: fakeCode, result: verdict.result, ok });
    if (ok) {
      state.clearHealthWarning(); // pipeline proven healthy — retire the banner
    } else {
      state.setHealthWarning(`Self-test failed: expected "rejected" but got "${verdict.result}". The Postmates UI may have changed.`);
    }
    return {
      ok,
      result: verdict.result,
      detail: verdict.detail,
      message: ok
        ? 'Detection pipeline healthy — fake code was correctly rejected.'
        : `Expected "rejected" but got "${verdict.result}" — the Postmates UI may have changed.`,
    };
  } catch (err) {
    state.appendLog({ type: 'self_test', code: fakeCode, result: 'crash', ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    _applyRunning = false;
  }
}

module.exports = { runApplyCodes, setupLogin, closeBrowser, getBrowserContext, getSessionValid, testDetection };
