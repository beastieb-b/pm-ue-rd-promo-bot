const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const cfg = require('./config');
const state = require('./state');
const { notifySuccess } = require('./notify');
const { isUsableLocation, extractAppliedLocation, formatRegion } = require('./region');

let _context = null;
let _setupRunning = false;
let _applyRunning = false;

// Tracks actual login state based on real navigation results (not cookies)
// null = unknown, true = confirmed working, false = confirmed not logged in.
// Persisted so "Logged in" status survives daemon restarts. Tracks both
// Postmates and UberEats sessions (UberEats needs its own login).
let _sessionState = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.SESSION_STATE_FILE, 'utf8'));
    return { sessionValid: data.sessionValid ?? null, ueSessionValid: data.ueSessionValid ?? null };
  } catch { return { sessionValid: null, ueSessionValid: null }; }
})();

function persistSessionState() {
  try { fs.writeFileSync(cfg.SESSION_STATE_FILE, JSON.stringify(_sessionState)); } catch {}
}
// True while the browser is held by an apply run, the self-test, or a login
// window — index.js checks this before firing an on-arrival apply, because its
// own applyRunning flag doesn't cover the self-test/setup paths.
function isBusy() { return _applyRunning || _setupRunning; }

function getSessionValid() { return _sessionState.sessionValid; }
function setSessionValid(v) { _sessionState.sessionValid = v; persistSessionState(); }
function getUeSessionValid() { return _sessionState.ueSessionValid; }
function setUeSessionValid(v) { _sessionState.ueSessionValid = v; persistSessionState(); }

// Per-platform apply config. Postmates and UberEats share the same Uber feed
// promo modal, so applyCode() works for both — only the URL, the logged-in
// domain check, and which session flag to set differ.
const PLATFORMS = {
  postmates: {
    name: 'Postmates',
    promoUrl: cfg.PROMO_URL,
    homeUrl: 'https://postmates.com',       // warm-up that reliably restores the session
    onDomain: (url) => url.includes('postmates.com') && !/\/login|\/signin/.test(url),
    setValid: setSessionValid,
  },
  ubereats: {
    name: 'UberEats',
    promoUrl: cfg.UBEREATS_PROMO_URL,
    homeUrl: 'https://www.ubereats.com',
    onDomain: (url) => url.includes('ubereats.com') && !/\/login|\/signin|auth\.uber\.com/.test(url),
    setValid: setUeSessionValid,
  },
};

async function getBrowserContext(headless = true) {
  if (_context) return _context;

  _context = await chromium.launchPersistentContext(cfg.BROWSER_PROFILE_DIR, {
    channel: 'chrome',
    headless,
    chromiumSandbox: true,   // prevents Playwright from injecting --no-sandbox
    // Drop Playwright's default --enable-automation so Chrome doesn't show the
    // "controlled by automated software" / "unsupported command-line flag"
    // infobars (the yellow banner). We achieve the anti-detection that the old
    // --disable-blink-features=AutomationControlled flag gave us via an init
    // script below instead, which doesn't trigger the banner.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--disable-default-apps',
    ],
    viewport: { width: 1280, height: 800 },
  });

  // Hide the automation fingerprint without a command-line flag.
  await _context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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

async function setupLogin({ target = 'postmates' } = {}) {
  if (_applyRunning) throw new Error('Browser is busy (apply run or session check) — try login again in a moment');
  if (_setupRunning) throw new Error('Login setup is already running');
  _setupRunning = true;
  const isUE = target === 'ubereats';
  const url = isUE ? 'https://www.ubereats.com/' : 'https://postmates.com';
  const name = isUE ? 'UberEats' : 'Postmates';
  console.log(`\n🔐 Opening ${name} in Chrome for login...`);
  console.log('   Please log in, then close the browser window when done.\n');

  try {
    const page = await getPage(false); // headed
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait until user closes the browser
    await new Promise(resolve => page.context().on('close', resolve));
    _context = null;
    // reset the relevant session — confirmed on the next apply run
    if (isUE) setUeSessionValid(null); else setSessionValid(null);
    console.log(`\n✅ Browser closed — ${name} login session saved.\n`);
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

  // "Oops, you already applied this promotion" — the code IS already on the
  // account, so it's a win, not a failure. Must be checked BEFORE the rejection
  // scan because that message also contains "oops" (a generic-error trigger),
  // which would otherwise mislabel an applied code as "Error applying code".
  if (/already applied|already redeemed/.test(text) &&
      !/already applied|already redeemed/.test(before)) {
    return { result: 'success', detail: 'Already applied' };
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
  // The applied-promo detail sheet ("Enjoy $X Off" + an Expiration section that
  // wasn't in the pre-apply modal) is also a success.
  const savings = extractSavings(text);
  const appliedSheet = !!savings && text.includes('expiration') && !before.includes('expiration');
  const strongSuccess =
    text.includes('see eligible stores') ||
    text.includes('promo applied') ||
    text.includes('added to your account') ||
    text.includes('successfully applied') ||
    /you'?ll (get|enjoy|save)/.test(text) ||
    appliedSheet;
  if (strongSuccess) {
    // Postmates shows a "Location" on city-locked promos (e.g. Las Vegas).
    // National / California-wide / LA promos are all usable; only a specific
    // other-area location makes a code useless here, so mark those region_skip
    // (applied but excluded from total saved).
    const loc = extractAppliedLocation(text);
    if (loc && !isUsableLocation(loc)) {
      return {
        result: 'region_skip',
        detail: `${savings ? savings + ' off' : 'Applied'} — ${formatRegion(loc)} only`,
      };
    }
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

// Postmates sometimes covers the code-entry modal with a promotional offer
// modal ("Enjoy 20% Off … See eligible stores") that has no input field. If a
// dialog is open but contains no input, close it (Escape) so the code-entry
// modal underneath can be reached. Returns true if it dismissed something.
// Never touches a dialog that HAS an input — that's the code-entry modal.
async function dismissNoInputModal(page) {
  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').first();
  const visible = await dialog.isVisible({ timeout: 500 }).catch(() => false);
  if (!visible) return false;
  const hasInput = await dialog.locator('input').first().isVisible({ timeout: 300 }).catch(() => false);
  if (hasInput) return false; // it's the code-entry modal — leave it alone
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);
  return true;
}

// Detect the logged-out marketing landing page. When a session expires, the
// saved auth cookie can still be present and unexpired, so isLoggedIn() (a
// cookie-presence check) keeps reporting "logged in" — but the site bounces us
// to the logged-out homepage (hero + "Log in" / "Sign up"). A logged-in session
// never renders a "Sign up" affordance, so a visible Sign-up button/link is a
// reliable "not authenticated" signal on both postmates.com and ubereats.com.
async function looksLoggedOut(page) {
  try {
    const signup = page.getByRole('button', { name: /sign\s*up/i })
      .or(page.getByRole('link', { name: /sign\s*up/i }));
    return await signup.first().isVisible({ timeout: 3000 }).catch(() => false);
  } catch { return false; }
}

// Scope to dialogs that contain an input so we never grab a cookie banner or
// address confirmation modal that happens to appear at the same time.
const MODAL_SELECTOR = '[role="dialog"]:has(input), [aria-modal="true"]:has(input)';

// Shared preamble for anything that needs the code-entry modal: navigate to the
// promo deep-link, clear interstitials, and retry through transient blips.
// The modal is sometimes covered by the messagingInterstitial or a no-input
// offer modal ("Enjoy 20% Off …"), and the deep-link *occasionally* comes back
// as the logged-out landing page even when the session is valid — so we never
// conclude "logged out" from a single read: on a logged-out-looking page we
// warm the session via the home feed (which reliably re-establishes it) and
// retry. Returns how far we got:
//   'open'       — code-entry modal is visible (session definitely valid)
//   'off_domain' — bounced off the platform entirely (not logged in)
//   'logged_out' — persistently on the logged-out landing page (session dead)
//   'blocked'    — on-domain and logged-in-looking, but the modal never opened
async function openPromoModal(page, plat) {
  await page.goto(plat.promoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  if (!plat.onDomain(page.url())) return 'off_domain';

  let modalOpen = false;
  let sawLoggedOut = false;
  for (let attempt = 0; attempt < 3 && !modalOpen; attempt++) {
    if (attempt > 0) {
      if (sawLoggedOut && plat.homeUrl) {
        await page.goto(plat.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      await page.goto(plat.promoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
    }
    await dismissPopups(page);
    await dismissNoInputModal(page);
    modalOpen = await page.locator(MODAL_SELECTOR).first().isVisible({ timeout: 6000 }).catch(() => false);
    if (!modalOpen) sawLoggedOut = await looksLoggedOut(page);
  }
  if (modalOpen) return 'open';

  // Persistently couldn't open the modal — take a debug screenshot, then
  // distinguish a genuinely dead session (still logged out after retries +
  // warm-up) from a UI/modal problem while logged in.
  try {
    const debugDir = path.join(cfg.DATA_DIR, 'debug-screenshots');
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(debugDir, `no-modal-${ts}.png`), fullPage: false });
  } catch {}
  return (await looksLoggedOut(page)) ? 'logged_out' : 'blocked';
}

// Session probe that types nothing and applies nothing — used to confirm a
// login right after setup and by the daily check, so the dashboard's
// "Unverified" state resolves without waiting for a real apply run (the
// UberEats session may otherwise go days between fallback attempts).
// Definitive outcomes update the session flag; 'blocked' is inconclusive
// (probably logged in, but unproven) and deliberately leaves the flag alone.
async function verifySession(platform = 'postmates') {
  const plat = PLATFORMS[platform] || PLATFORMS.postmates;
  if (_setupRunning) return { verified: null, error: 'Login setup is running' };
  if (_applyRunning) return { verified: null, error: 'Apply run in progress' };
  _applyRunning = true; // hold the browser exactly like an apply run would
  let page = null;
  try {
    page = await getPage(false);
    const outcome = await openPromoModal(page, plat);
    const verified = outcome === 'open' ? true
      : (outcome === 'off_domain' || outcome === 'logged_out') ? false
      : null;
    if (verified !== null) plat.setValid(verified);
    state.appendLog({ type: 'session_verified', platform, ok: verified, outcome });
    return { verified, outcome };
  } catch (err) {
    state.appendLog({ type: 'session_verified', platform, ok: null, error: err.message.slice(0, 100) });
    return { verified: null, error: err.message };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    _applyRunning = false;
  }
}

// ── Reddit comment fetch via the browser ────────────────────────────────────
// On 2026-07-20 Reddit started requiring a login for thread pages fetched by
// plain HTTP clients (302 → /login?reason=lor2): old.reddit HTML, .json and
// .rss all bounce to a login gate, while SEARCH pages still work anonymously —
// so thread detection kept succeeding while comment fetches silently read
// nothing. A real rendered browser still gets the new-Reddit page logged out,
// so when curl comes back empty the scanner reads the thread through our own
// Chrome instead. No Reddit account or cookie is needed for this.
async function fetchRedditComments(threadId, subreddit) {
  if (_setupRunning) return null; // never fight the login window for the browser
  const page = await getPage(false);
  try {
    await page.goto(`https://www.reddit.com/r/${subreddit}/comments/${threadId}/?limit=500`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // The new frontend lazy-loads comments in batches behind "View more
    // comments" buttons — scrolling alone tops out around 25 comments on long
    // threads (a thread measured 92 when clicked through). Click load-more
    // when present, otherwise scroll, until the count stabilizes twice.
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 15 && stable < 2; i++) {
      const more = page.getByRole('button', { name: /view more comments|more replies|load more/i }).first();
      if (await more.isVisible({ timeout: 500 }).catch(() => false)) {
        await more.click().catch(() => {});
        await page.waitForTimeout(1500);
      } else {
        await page.mouse.wheel(0, 6000).catch(() => {});
        await page.waitForTimeout(1000);
      }
      const n = await page.locator('shreddit-comment').count().catch(() => 0);
      stable = n === prev ? stable + 1 : 0;
      prev = n;
    }

    const comments = await page.evaluate(() => {
      return [...document.querySelectorAll('shreddit-comment')].map(el => {
        // querySelector returns the element's OWN body: in document order it
        // precedes any nested reply's slot, so replies don't duplicate parents.
        const body = el.querySelector('[slot="comment"]');
        return {
          author: (el.getAttribute('author') || '').toLowerCase(),
          distinguished: el.getAttribute('distinguished') || null,
          text: (body ? body.innerText : '').trim(),
          permalink: el.getAttribute('permalink'),
        };
      });
    });

    // Same exclusions as the old.reddit parser: AutoModerator + mod posts.
    return comments
      .filter(c => c.author !== 'automoderator' && !c.distinguished && c.text && c.text.length > 3)
      .map(c => ({ text: c.text, permalink: c.permalink ? `https://www.reddit.com${c.permalink}` : null }));
  } finally {
    try { await page.close(); } catch {}
  }
}

async function applyCode(page, code, platform = 'postmates') {
  const plat = PLATFORMS[platform] || PLATFORMS.postmates;
  const outcome = await openPromoModal(page, plat);
  if (outcome === 'off_domain') {
    plat.setValid(false);
    return { result: 'not_logged_in', detail: `Redirected — use Settings → Log in to ${plat.name}` };
  }
  if (outcome === 'logged_out') {
    plat.setValid(false);
    return { result: 'not_logged_in', detail: `${plat.name} session expired — Settings → Log in to ${plat.name}` };
  }
  if (outcome === 'blocked') {
    return { result: 'error', detail: 'Promo modal did not open' };
  }

  const modalLocator = page.locator(MODAL_SELECTOR).first();
  // Modal opened — the session is definitely valid.
  plat.setValid(true);

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

  // Locate the input and type the code, verifying it landed. The site
  // occasionally re-renders and detaches the modal mid-entry (the recurring
  // "locator.inputValue: Timeout 30000ms" flake — 9 hits in July 2026, once
  // six runs in a row on one code). Interacting with a detached locator used
  // to hang for the 30s default timeout and crash the whole attempt, costing a
  // 2h defer; instead, use short explicit timeouts and, if the modal vanished,
  // reopen it and retype once — the second pass almost always sticks.
  let inputLocator = null;
  for (let entryAttempt = 0; entryAttempt < 2 && !inputLocator; entryAttempt++) {
    if (entryAttempt > 0) {
      const reopened = await openPromoModal(page, plat);
      if (reopened !== 'open') {
        return { result: 'error', detail: 'Promo modal closed mid-entry and did not reopen' };
      }
    }
    try {
      // Modal-scoped selectors first, then any input inside the modal.
      let loc = null;
      for (const sel of inputSelectors) {
        const cand = modalLocator.locator(sel).first();
        if (await cand.isVisible({ timeout: 3000 }).catch(() => false)) { loc = cand; break; }
      }
      if (!loc) {
        const cand = modalLocator.locator('input').first();
        if (await cand.isVisible({ timeout: 3000 }).catch(() => false)) loc = cand;
      }
      if (!loc) {
        if (entryAttempt > 0) return { result: 'error', detail: 'Could not find promo input inside modal' };
        continue; // modal may have detached — reopen and retry
      }

      // Clear and type the code
      await loc.click({ clickCount: 3, timeout: 5000 });
      await loc.fill('', { timeout: 5000 });
      await page.keyboard.type(code, { delay: 80 });
      await page.waitForTimeout(500);

      // Verify text appeared in input
      let val = await loc.inputValue({ timeout: 5000 });
      if (!val.trim()) {
        // Retry once with a slower type
        await loc.fill('', { timeout: 5000 });
        for (const char of code) {
          await page.keyboard.type(char);
          await page.waitForTimeout(50);
        }
        await page.waitForTimeout(500);
        val = await loc.inputValue({ timeout: 5000 });
        if (!val.trim()) {
          return { result: 'error', detail: 'Text did not appear in input field' };
        }
      }
      inputLocator = loc; // typed and verified
    } catch (err) {
      // Locator interactions threw (detached modal / re-render). One reopen.
      if (entryAttempt > 0) {
        return { result: 'error', detail: 'Promo modal closed mid-entry (site re-render)' };
      }
      state.appendLog({ type: 'modal_reopen', code, platform, error: err.message.slice(0, 80) });
    }
  }
  if (!inputLocator) {
    return { result: 'error', detail: 'Could not find promo input inside modal' };
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
    const processed = new Set(state.getProcessed().map(r => r.code));
    // Order the queue so the best candidates get the limited per-run budget
    // first — codes containing digits (far more likely to be real promo codes
    // than a stray word), then higher catalog confidence, then most recently
    // seen. We never SKIP anything: lower-priority codes are simply tried on
    // later runs, so a "dead/expired" community note never excludes a code
    // (those reports are often wrong).
    const pending = state.getQueueDetails()
      .filter(e => !processed.has(e.code))
      .map(e => ({
        code: e.code,
        score: (/\d/.test(e.code) ? 1000 : 0) + (Number(e.confidenceScore) || 0),
        seen: e.lastSeenAt ? (Date.parse(e.lastSeenAt) || 0) : 0,
      }))
      .sort((a, b) => (b.score - a.score) || (b.seen - a.seen))
      .slice(0, maxCodes)
      .map(e => e.code);

    if (!pending.length) {
      state.appendLog({ type: 'apply_run_done', reason: 'no_pending_codes' });
      return { applied: 0, results: [], reason: 'No codes in queue' };
    }

    // Every queued code is tried in Postmates — Postmates' own location field is
    // the source of truth. A Reddit comment hint (regionRestricted) is shown in
    // the queue but never blocks the attempt, since those reports are sometimes
    // wrong. Codes that come back applied-but-localized to a non-SoCal area are
    // marked region_skip during detection and excluded from total saved.

    // Must run headed — Postmates detects and blocks headless Chrome
    page = await getPage(false);
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

      if (applyResult.result === 'not_logged_in') {
        // Session is dead — every remaining code would hit the same wall, so
        // stop the run now. Codes stay queued and resume once the user re-logs
        // in (the dashboard shows a session-expired banner in the meantime).
        state.appendLog({ type: 'code_deferred', code, reason: 'not_logged_in', note: 'session invalid — stopping run' });
        if (onProgress) onProgress({ code, status: 'login_required', detail: applyResult.detail });
        break;
      }

      if (['error', 'unknown'].includes(applyResult.result)) {
        // Transient or ambiguous failure — code stays in queue and retries automatically next run.
        // Add a short cooldown so consecutive failures don't hammer the site back-to-back.
        state.appendLog({ type: 'code_deferred', code, reason: applyResult.result, note: 'will retry next run' });
        if (code !== pending[pending.length - 1]) {
          await page.waitForTimeout(20_000); // 20s cooldown between transient failures
        }
        continue;
      }

      // UberEats fallback: a code rejected on Postmates for any reason EXCEPT
      // "Code expired" may be a valid UberEats code (many come from r/UberEATS).
      // Retry it on UberEats using the same modal/detection + rate handling.
      if (applyResult.result === 'rejected' && applyResult.detail !== 'Code expired') {
        if (onProgress) onProgress({ code, status: 'trying_ubereats' });
        state.appendLog({ type: 'ubereats_fallback', code, postmates_detail: applyResult.detail });
        // Up to 2 attempts: the UberEats modal occasionally closes mid-flow
        // (transient — a fresh visit works). Without the retry a blip would
        // permanently forfeit the code's UberEats chance, since an error here
        // finalizes the Postmates rejection and the code never re-queues.
        let ue;
        for (let ueAttempt = 0; ueAttempt < 2; ueAttempt++) {
          try {
            ue = await applyCode(page, code, 'ubereats');
          } catch (err) {
            try {
              const debugDir = path.join(cfg.DATA_DIR, 'debug-screenshots');
              fs.mkdirSync(debugDir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              await page.screenshot({ path: path.join(debugDir, `ue-error-${ts}.png`), fullPage: false });
            } catch {}
            ue = { result: 'error', detail: err.message.slice(0, 100) };
          }
          if (ue.result !== 'error') break;
          if (ueAttempt === 0) {
            state.appendLog({ type: 'ubereats_fallback_retry', code, error: ue.detail });
            await page.waitForTimeout(5000);
          }
        }
        state.appendLog({ type: 'code_result', code, result: ue.result, detail: ue.detail, platform: 'ubereats' });
        if (onProgress) onProgress({ code, status: ue.result, detail: ue.detail, platform: 'ubereats' });

        if (ue.result === 'ratelimited') {
          rateLimited = true;
          const remaining = pending.slice(pending.indexOf(code));
          state.appendLog({ type: 'rate_limited', code, codes_preserved: remaining.length, platform: 'ubereats' });
          if (onProgress) onProgress({ code, status: 'rate_limited_stop', preserved: remaining.length });
          break;
        }
        if (ue.result === 'success' || ue.result === 'region_skip') {
          // Worked (or region-locked) on UberEats — relabel and tag the platform.
          applyResult = { result: ue.result, detail: `${ue.detail} · UberEats` };
          state.mergeCodeMeta(code, { appliedOn: 'ubereats' });
          results[results.length - 1] = { code, ...applyResult };
        } else {
          // Also failed on UberEats — keep the Postmates rejection, but note the
          // UberEats outcome in the detail so the Results row tells the whole
          // story without digging through the Activity Log.
          const ueNote =
            ue.result === 'rejected'
              ? (ue.detail === applyResult.detail ? 'also on UberEats' : `UberEats: ${ue.detail}`)
              : ue.result === 'not_logged_in'
                ? 'UberEats: login needed'
                : 'UberEats attempt errored';
          applyResult = { result: applyResult.result, detail: `${applyResult.detail} · ${ueNote}` };
          results[results.length - 1] = { code, ...applyResult };
        }
      }

      // Permanent results (success / rejected) — mark and remove from queue
      state.markResult(code, applyResult.result, applyResult.detail);

      if (applyResult.result === 'success' && !/^Already applied/.test(applyResult.detail || '')) {
        // Fresh wins only — "Already applied" confirms an earlier cycle's code
        // is still on the account; texting a success for it is just noise.
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
      // Pipeline proven healthy — retire the banner, but never someone else's:
      // a passing self-test says nothing about a stale monthly thread.
      const existing = state.getHealthWarning();
      if (!existing || existing.source !== 'thread_stale') state.clearHealthWarning();
    } else {
      state.setHealthWarning(`Self-test failed: expected "rejected" but got "${verdict.result}". The Postmates UI may have changed.`, 'self_test');
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
    // A crash is as loud as a wrong verdict — without this, a crashed daily
    // self-test only reached the console log and the banner stayed silent.
    state.setHealthWarning(`Self-test crashed (${err.message.slice(0, 80)}) — run it again from Settings → System Health; if it keeps failing the Postmates UI may have changed.`, 'self_test');
    return { ok: false, error: err.message };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    _applyRunning = false;
  }
}

module.exports = { runApplyCodes, applyCode, classify, setupLogin, closeBrowser, getBrowserContext, getSessionValid, getUeSessionValid, isBusy, testDetection, verifySession, fetchRedditComments };
