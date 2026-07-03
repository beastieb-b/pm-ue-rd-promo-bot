const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');

const SETTINGS_FILE = path.join(cfg.DATA_DIR, 'settings.json');
const SERVICE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.postmates.promo.plist');
const SETUP_STATUS_TTL_MS = 10_000;
let setupStatusCache = null;
let setupStatusCacheAt = 0;

const DEFAULTS = {
  scanIntervalHours: 2,
  applyIntervalHours: 4,
  // Home market. A promo localized to anywhere matching homeAliases (or to the
  // state / nationwide) is usable; anything else is region-locked and excluded
  // from savings. homeRegion is the human label used in messages.
  homeRegion: 'Los Angeles',
  homeAliases: ['los angeles', 'la', 'socal', 'so cal', 'southern california'],
};

const SCAN_INTERVALS = [0.5, 1, 2, 3, 4, 6, 12, 24];
const APPLY_INTERVALS = [1, 2, 3, 4, 6, 12, 24];

function normalizeInterval(value, allowed, fallback) {
  const n = Number(value);
  return allowed.includes(n) ? n : fallback;
}

function normalizeHomeRegion(value) {
  const s = String(value || '').trim();
  return s || DEFAULTS.homeRegion;
}

// Aliases are lowercased, de-duped, and always include the home region label
// itself so a plain "Los Angeles" location always matches.
function normalizeAliases(value, homeRegion) {
  let list = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const label = normalizeHomeRegion(homeRegion).toLowerCase();
  list = [...list, label]
    .map(a => String(a).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(list)];
}

function load() {
  if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
  try {
    const loaded = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    return {
      scanIntervalHours: normalizeInterval(loaded.scanIntervalHours, SCAN_INTERVALS, DEFAULTS.scanIntervalHours),
      applyIntervalHours: normalizeInterval(loaded.applyIntervalHours, APPLY_INTERVALS, DEFAULTS.applyIntervalHours),
      homeRegion: normalizeHomeRegion(loaded.homeRegion),
      homeAliases: normalizeAliases(loaded.homeAliases, loaded.homeRegion),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(updates) {
  const current = load();
  const homeRegion = updates.homeRegion !== undefined
    ? normalizeHomeRegion(updates.homeRegion)
    : current.homeRegion;
  const next = {
    scanIntervalHours: updates.scanIntervalHours !== undefined
      ? normalizeInterval(updates.scanIntervalHours, SCAN_INTERVALS, current.scanIntervalHours)
      : current.scanIntervalHours,
    applyIntervalHours: updates.applyIntervalHours !== undefined
      ? normalizeInterval(updates.applyIntervalHours, APPLY_INTERVALS, current.applyIntervalHours)
      : current.applyIntervalHours,
    homeRegion,
    homeAliases: updates.homeAliases !== undefined
      ? normalizeAliases(updates.homeAliases, homeRegion)
      : normalizeAliases(current.homeAliases, homeRegion),
  };
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

function hoursToCron(hours) {
  const n = parseFloat(hours);
  if (!isFinite(n) || n <= 0) return '0 */2 * * *'; // safe fallback
  if (n < 1) {
    // Fractional hours → minute-based cron (e.g. 0.5 → every 30 min)
    const mins = Math.round(n * 60);
    return `*/${mins} * * * *`;
  }
  const h = Math.round(n);
  if (h === 1) return '0 * * * *';
  if (h >= 24) return '0 0 * * *';
  return `0 */${h} * * *`;
}

function nextRunFromInterval(hours, now = new Date()) {
  const n = Number(hours);
  const next = new Date(now);
  next.setSeconds(0, 0);

  if (n < 1) {
    const mins = Math.round(n * 60);
    const nextMinute = Math.ceil((next.getMinutes() + 1) / mins) * mins;
    if (nextMinute >= 60) {
      next.setHours(next.getHours() + 1, 0, 0, 0);
    } else {
      next.setMinutes(nextMinute);
    }
    return next;
  }

  const h = Math.round(n);
  next.setMinutes(0, 0, 0);
  if (h >= 24) {
    next.setDate(next.getDate() + 1);
    next.setHours(0);
    return next;
  }

  const nextHour = Math.ceil((next.getHours() + 1) / h) * h;
  if (nextHour >= 24) {
    next.setDate(next.getDate() + 1);
    next.setHours(0);
  } else {
    next.setHours(nextHour);
  }
  return next;
}

function isLoggedIn() {
  const cookiePath = path.join(cfg.BROWSER_PROFILE_DIR, 'Default', 'Cookies');
  if (!fs.existsSync(cookiePath)) return false;

  // Check for the Postmates session cookie ('sid') and Uber auth cookie ('csid').
  // An unauthenticated visit only sets analytics cookies, not these auth cookies.
  try {
    const result = execSync(
      `sqlite3 "${cookiePath}" "SELECT COUNT(*) FROM cookies WHERE (host_key LIKE '%postmates%' AND name='sid') OR (host_key LIKE '%uber%' AND name='csid');"`,
      { timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    return parseInt(result) > 0;
  } catch {
    // sqlite3 not available or DB locked — fall back to size heuristic (>50KB = real session)
    try { return fs.statSync(cookiePath).size > 51200; } catch { return false; }
  }
}

// UberEats needs its own login session (the Uber SSO csid doesn't carry to
// ubereats.com). Authenticated ubereats.com sets a 'sid' cookie that the
// logged-out/guest session does not. NOTE: the exact marker is confirmed during
// post-login discovery; adjust the cookie name here if it differs.
function isLoggedInUberEats() {
  const cookiePath = path.join(cfg.BROWSER_PROFILE_DIR, 'Default', 'Cookies');
  if (!fs.existsSync(cookiePath)) return false;
  try {
    const result = execSync(
      `sqlite3 "${cookiePath}" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%ubereats%' AND name='sid';"`,
      { timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

function hasOldCronJob() {
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { timeout: 3000 }).toString();
    return crontab.includes('postmates_monitor.sh');
  } catch {
    return false;
  }
}

function isServiceInstalled() {
  return fs.existsSync(SERVICE_PLIST);
}

function getSetupStatus() {
  const now = Date.now();
  if (setupStatusCache && now - setupStatusCacheAt < SETUP_STATUS_TTL_MS) {
    return setupStatusCache;
  }

  const loggedIn = isLoggedIn();
  const ueLoggedIn = isLoggedInUberEats();
  const oldCronActive = hasOldCronJob();
  const serviceInstalled = isServiceInstalled();

  const steps = [
    {
      id: 'login',
      label: 'Log into Postmates',
      description: 'The app needs an active Postmates session to apply codes. Use Settings → Log in to Postmates.',
      command: 'Settings → Log in to Postmates button',
      hint: 'Click the button in Settings to open Chrome. Log into Postmates, then close the window.',
      done: loggedIn,
      required: true,
    },
    {
      id: 'ubereats-login',
      label: 'Log into UberEats',
      description: 'Codes rejected on Postmates are retried on UberEats, which needs its own login session.',
      command: 'Settings → Log in to UberEats button',
      hint: 'Click the button in Settings to open Chrome. Log into UberEats, then close the window.',
      done: ueLoggedIn,
      required: false,
    },
    {
      id: 'old-cron',
      label: 'Disable old cron job',
      description: 'The old hourly bash script is still running and will conflict with this app.',
      command: "crontab -e  →  delete the postmates_monitor.sh line",
      hint: 'Open crontab with that command, find the line with postmates_monitor.sh, delete it, and save.',
      done: !oldCronActive,
      required: true,
    },
    {
      id: 'service',
      label: 'Install background service',
      description: 'Run the daemon automatically on login so it\'s always active without an open terminal.',
      command: 'npm run install-service',
      hint: 'Installs a launchd agent so the daemon starts automatically when you log into your Mac.',
      done: serviceInstalled,
      required: false,
    },
  ];

  const allRequiredDone = steps.filter(s => s.required).every(s => s.done);
  const allDone = steps.every(s => s.done);

  setupStatusCache = { steps, allRequiredDone, allDone };
  setupStatusCacheAt = now;
  return setupStatusCache;
}

function invalidateSetupStatus() {
  setupStatusCache = null;
  setupStatusCacheAt = 0;
}

// Gate for "apply on arrival": a scan just queued new codes → start an apply
// run now instead of waiting up to 2h for the cron. Deliberately conservative
// about rate limits: never while a run is active, never within minGapMs of the
// last run (scans fire every 30 min, so this caps on-arrival runs at ~2/hour),
// and never within backoffMs after a run that hit the rate limiter — after a
// rate limit, only the scheduled cron applies.
function shouldApplyOnArrival({
  queued, applyRunning, lastApplyAt, lastRateLimitedAt,
  now = Date.now(),
  minGapMs = 30 * 60 * 1000,
  backoffMs = 2 * 60 * 60 * 1000,
}) {
  if (!queued || queued <= 0) return false;
  if (applyRunning) return false;
  if (lastRateLimitedAt && now - new Date(lastRateLimitedAt).getTime() < backoffMs) return false;
  if (lastApplyAt && now - new Date(lastApplyAt).getTime() < minGapMs) return false;
  return true;
}

module.exports = {
  load, save, hoursToCron, nextRunFromInterval,
  normalizeInterval, SCAN_INTERVALS, APPLY_INTERVALS,
  shouldApplyOnArrival,
  isLoggedIn, isLoggedInUberEats, hasOldCronJob, isServiceInstalled, getSetupStatus, invalidateSetupStatus, DEFAULTS,
};
