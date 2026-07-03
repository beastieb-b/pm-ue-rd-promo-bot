#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cfg = require('./config');
const state = require('./state');
const settings = require('./settings');
const reddit = require('./reddit');
const postmates = require('./postmates');
const server = require('./server');

// Prefix every console line with an ISO timestamp so the daemon logs
// (data/daemon-error.log / daemon-out.log) are dated — old entries can no
// longer be mistaken for recent ones.
(() => {
  const stamp = () => `[${new Date().toISOString()}]`;
  const log = console.log.bind(console);
  const err = console.error.bind(console);
  console.log = (...a) => log(stamp(), ...a);
  console.error = (...a) => err(stamp(), ...a);
})();

state.ensureDirs();

const args = process.argv.slice(2);

// ── Setup mode: open browser for login ──────────────────────────────────────
if (args.includes('--setup')) {
  postmates.setupLogin().then(() => process.exit(0)).catch(err => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
  return;
}

// ── Test mode: single Reddit check ──────────────────────────────────────────
if (args.includes('--reddit')) {
  reddit.runRedditCheck().then(result => {
    console.log('Reddit check result:', JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('Reddit check failed:', err.message);
    process.exit(1);
  });
  return;
}

// ── Test mode: single apply run ──────────────────────────────────────────────
if (args.includes('--apply')) {
  postmates.runApplyCodes({
    onProgress: (u) => console.log('  →', u.code, u.status, u.detail || ''),
  }).then(result => {
    console.log('Apply result:', JSON.stringify(result, null, 2));
    postmates.closeBrowser();
    process.exit(0);
  }).catch(err => {
    console.error('Apply failed:', err.message);
    postmates.closeBrowser();
    process.exit(1);
  });
  return;
}

// ── Daemon mode ──────────────────────────────────────────────────────────────

let redditRunning = false;
let applyRunning = false;
let redditTask = null;
let applyTask = null;
let lastRateLimitedAt = null; // when an apply run last hit the rate limiter

// Scan status — exposed to the server for the dashboard
const scanStatus = {
  active: false,          // set true once crons are scheduled
  lastScanAt: null,
  lastScanError: null,
  nextScanAt: null,
  intervalHours: 2,
  applyIntervalHours: 4,
  applyRunning: false,
  applyStartedAt: null,   // when the current apply run began
  applyCurrentCode: null, // code currently being tried
  lastApplyAt: null,
  nextApplyAt: null,
};

function updateNextScanTime() {
  scanStatus.nextScanAt = settings.nextRunFromInterval(scanStatus.intervalHours);
  scanStatus.nextApplyAt = settings.nextRunFromInterval(scanStatus.applyIntervalHours);
}

// Exposed so server.js can include it in /api/stats
function getScanStatus() { return scanStatus; }

async function runReddit() {
  if (redditRunning) {
    const result = { error: 'Reddit check already running' };
    server.broadcast({ type: 'reddit_done', ...result, scanStatus });
    return result;
  }
  redditRunning = true;
  scanStatus.lastScanError = null;
  try {
    console.log('Running Reddit check...');
    const result = await reddit.runRedditCheck({
      onProgress: (p) => server.broadcast({ type: 'reddit_progress', ...p }),
    });
    scanStatus.lastScanAt = new Date();
    updateNextScanTime();
    if (result.error) {
      scanStatus.lastScanError = result.error;
      console.error('  Reddit error:', result.error);
    } else {
      state.recordHeartbeat('scan'); // for the staleness watchdog
      const pm = result.postmates, ue = result.ubereats;
      console.log(`  r/postmates: ${pm?.threadId || '?'} | ${pm?.commentsScanned ?? 0} comments | ${pm?.newCodes ?? 0} new`);
      console.log(`  r/UberEATS:  ${ue?.threadId || '?'} | ${ue?.commentsScanned ?? 0} comments | ${ue?.newCodes ?? 0} new`);
      if (result.queued > 0) console.log(`  Queued: ${result.queued} codes`);

      // Apply on arrival: fresh codes are time-sensitive (limited redemptions),
      // so start an apply run now instead of waiting up to 2h for the cron.
      // shouldApplyOnArrival is rate-limit conservative: never while a run is
      // active, ≥30 min since the last run, and a 2h backoff after any
      // rate-limited run. lastApplyAt falls back to the persisted heartbeat so
      // a daemon restart can't bypass the gap.
      const lastApply = scanStatus.lastApplyAt || state.getHeartbeat()?.apply || null;
      if (settings.shouldApplyOnArrival({ queued: result.queued, applyRunning, lastApplyAt: lastApply, lastRateLimitedAt })) {
        state.appendLog({ type: 'apply_on_arrival', queued: result.queued });
        console.log(`  ⚡ ${result.queued} new code(s) — starting apply run now`);
        runApply(); // deliberately not awaited — the scan result returns immediately
      }
    }
    server.broadcast({ type: 'reddit_done', ...result, scanStatus });
    return result;
  } catch (err) {
    scanStatus.lastScanError = err.message;
    console.error('Reddit check crashed:', err.message);
    const result = { error: err.message };
    server.broadcast({ type: 'reddit_done', ...result, scanStatus });
    return result;
  } finally {
    redditRunning = false;
  }
}

async function runApply(options = {}) {
  if (applyRunning) {
    const result = { error: 'Apply run already running' };
    server.broadcast({ type: 'apply_done', ...result });
    return result;
  }
  applyRunning = true;
  scanStatus.applyRunning = true;
  scanStatus.applyStartedAt = new Date();
  scanStatus.applyCurrentCode = null;
  // Let any open dashboard know a run just started (covers cron-triggered runs).
  server.broadcast({ type: 'apply_started', scanStatus });
  try {
    console.log('Running code applier...');
    const result = await postmates.runApplyCodes({
      ...options,
      onProgress: (u) => {
        console.log(`  → ${u.code}: ${u.status}${u.detail ? ' — ' + u.detail : ''}`);
        if (u.status === 'trying') scanStatus.applyCurrentCode = u.code;
        server.broadcast({ type: 'apply_progress', ...u, scanStatus });
      },
    });
    if (result.error) {
      console.error('  Apply error:', result.error);
    } else {
      const successes = result.results?.filter(r => r.result === 'success').length ?? 0;
      console.log(`  Applied: ${result.applied} | Successes: ${successes}`);
    }
    scanStatus.lastApplyAt = new Date();
    updateNextScanTime(); // refresh next-apply (and next-scan) projections
    scanStatus.applyRunning = false;
    scanStatus.applyCurrentCode = null;
    if (result.rateLimited) lastRateLimitedAt = new Date(); // suppresses apply-on-arrival for 2h
    if (!result.error) state.recordHeartbeat('apply'); // for the staleness watchdog
    server.broadcast({ type: 'apply_done', ...result, scanStatus });
    return result;
  } catch (err) {
    console.error('Apply run crashed:', err.message);
    scanStatus.applyRunning = false;
    scanStatus.applyCurrentCode = null;
    const result = { error: err.message };
    server.broadcast({ type: 'apply_done', ...result, scanStatus });
    return result;
  } finally {
    applyRunning = false;
    scanStatus.applyRunning = false;
    scanStatus.applyCurrentCode = null;
  }
}

function reschedule(newSettings) {
  const s = newSettings || settings.load();

  if (redditTask) { redditTask.stop(); redditTask = null; }
  if (applyTask) { applyTask.stop(); applyTask = null; }

  const redditCron = settings.hoursToCron(s.scanIntervalHours);
  const applyCron = settings.hoursToCron(s.applyIntervalHours);

  redditTask = cron.schedule(redditCron, runReddit, { timezone: 'America/Los_Angeles' });
  applyTask = cron.schedule(applyCron, runApply, { timezone: 'America/Los_Angeles' });

  scanStatus.active = true;
  scanStatus.intervalHours = s.scanIntervalHours;
  scanStatus.applyIntervalHours = s.applyIntervalHours;
  updateNextScanTime();

  console.log(`📅 Reddit scan: every ${s.scanIntervalHours}h (${redditCron})`);
  console.log(`📅 Code applier: every ${s.applyIntervalHours}h (${applyCron})`);

  server.broadcast({ type: 'settings_updated', settings: s, scanStatus });
}

// Expose reschedule + getScanStatus so server can use them
server.registerTriggers(runReddit, runApply, reschedule, getScanStatus);

async function main() {
  console.log('🍔 Postmates Promo Daemon starting...');

  // Trim the daemon logs to the last 1000 lines whenever they grow past 1200.
  // launchd opens the files with O_APPEND before exec, so writes always go to
  // the real end — trimming the content at startup is safe. Covers both the
  // stdout log (daemon.log) and the stderr log (daemon-error.log).
  for (const name of ['daemon.log', 'daemon-error.log']) {
    try {
      const file = path.join(cfg.DATA_DIR, name);
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      if (lines.length > 1200) {
        fs.writeFileSync(file, lines.slice(-1000).join('\n') + '\n');
        console.log(`[startup] Trimmed ${name} (${lines.length} → 1000 lines)`);
      }
    } catch {}
  }

  await server.start();

  const s = settings.load();
  reschedule(s);

  // Daily self-test at 4:45am PT (clear of the :00/:30 scans and even-hour
  // applies): applies a fake code and expects a rejection, so a Postmates UI
  // change is caught within a day — with the health banner raised — instead of
  // whenever real codes start silently misbehaving.
  cron.schedule('45 4 * * *', async () => {
    if (applyRunning || redditRunning) {
      console.log('Daily self-test skipped — a run is in progress (will retry tomorrow)');
      return;
    }
    console.log('Running daily self-test...');
    try {
      const result = await postmates.testDetection();
      server.broadcast({ type: 'self_test_done', ...result });
      console.log(result.ok ? '  ✅ Self-test passed' : `  ⚠️ Self-test failed: ${result.error || result.message}`);
    } catch (err) {
      console.error('  Self-test crashed:', err.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  // Run Reddit check immediately on startup
  await runReddit();

  console.log('\n✅ Daemon running. Dashboard: http://localhost:' + cfg.DASHBOARD_PORT + '\n');

  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})...`);
    await postmates.closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM')); // launchd unload sends SIGTERM
}

main().catch(err => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
