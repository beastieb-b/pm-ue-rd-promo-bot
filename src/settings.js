const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const cfg = require('./config');

const SETTINGS_FILE = path.join(cfg.DATA_DIR, 'settings.json');
const SERVICE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.postmates.promo.plist');

const DEFAULTS = {
  scanIntervalHours: 2,
  applyIntervalHours: 4,
};

function load() {
  if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(updates) {
  const current = load();
  const next = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
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

function isLoggedIn() {
  const cookiePath = path.join(cfg.BROWSER_PROFILE_DIR, 'Default', 'Cookies');
  if (!fs.existsSync(cookiePath)) return false;

  // Check for the Postmates auth cookie (jwt-session) specifically.
  // An unauthenticated Chrome visit sets analytics cookies but not the JWT.
  try {
    const result = execSync(
      `sqlite3 "${cookiePath}" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%postmates%' AND name='jwt-session';"`,
      { timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    return parseInt(result) > 0;
  } catch {
    // sqlite3 not available or DB locked — fall back to size heuristic (>50KB = real session)
    try { return fs.statSync(cookiePath).size > 51200; } catch { return false; }
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
  const loggedIn = isLoggedIn();
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

  return { steps, allRequiredDone, allDone };
}

module.exports = { load, save, hoursToCron, isLoggedIn, hasOldCronJob, isServiceInstalled, getSetupStatus, DEFAULTS };
