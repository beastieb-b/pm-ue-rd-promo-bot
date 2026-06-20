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

// Scan status — exposed to the server for the dashboard
const scanStatus = {
  active: false,          // set true once crons are scheduled
  lastScanAt: null,
  lastScanError: null,
  nextScanAt: null,
  intervalHours: 2,
  applyRunning: false,
  lastApplyAt: null,
};

function updateNextScanTime() {
  scanStatus.nextScanAt = settings.nextRunFromInterval(scanStatus.intervalHours);
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
    console.log(`[${new Date().toLocaleTimeString()}] Running Reddit check...`);
    const result = await reddit.runRedditCheck({
      onProgress: (p) => server.broadcast({ type: 'reddit_progress', ...p }),
    });
    scanStatus.lastScanAt = new Date();
    updateNextScanTime();
    if (result.error) {
      scanStatus.lastScanError = result.error;
      console.error('  Reddit error:', result.error);
    } else {
      const pm = result.postmates, ue = result.ubereats;
      console.log(`  r/postmates: ${pm?.threadId || '?'} | ${pm?.commentsScanned ?? 0} comments | ${pm?.newCodes ?? 0} new`);
      console.log(`  r/UberEATS:  ${ue?.threadId || '?'} | ${ue?.commentsScanned ?? 0} comments | ${ue?.newCodes ?? 0} new`);
      if (result.queued > 0) console.log(`  Queued: ${result.queued} codes`);
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
  try {
    console.log(`[${new Date().toLocaleTimeString()}] Running code applier...`);
    const result = await postmates.runApplyCodes({
      ...options,
      onProgress: (u) => {
        console.log(`  → ${u.code}: ${u.status}${u.detail ? ' — ' + u.detail : ''}`);
        server.broadcast({ type: 'apply_progress', ...u });
      },
    });
    if (result.error) {
      console.error('  Apply error:', result.error);
    } else {
      const successes = result.results?.filter(r => r.result === 'success').length ?? 0;
      console.log(`  Applied: ${result.applied} | Successes: ${successes}`);
    }
    scanStatus.lastApplyAt = new Date();
    scanStatus.applyRunning = false;
    server.broadcast({ type: 'apply_done', ...result });
    return result;
  } catch (err) {
    console.error('Apply run crashed:', err.message);
    scanStatus.applyRunning = false;
    const result = { error: err.message };
    server.broadcast({ type: 'apply_done', ...result });
    return result;
  } finally {
    applyRunning = false;
    scanStatus.applyRunning = false;
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
  updateNextScanTime();

  console.log(`📅 Reddit scan: every ${s.scanIntervalHours}h (${redditCron})`);
  console.log(`📅 Code applier: every ${s.applyIntervalHours}h (${applyCron})`);

  server.broadcast({ type: 'settings_updated', settings: s, scanStatus });
}

// Expose reschedule + getScanStatus so server can use them
server.registerTriggers(runReddit, runApply, reschedule, getScanStatus);

async function main() {
  console.log('🍔 Postmates Promo Daemon starting...');

  // Trim daemon-error.log to the last 1000 lines whenever it grows past 1200.
  // launchd opens the file with O_APPEND before exec, so writes always go to
  // the real end — trimming the content at startup is safe.
  try {
    const errorLog = path.join(cfg.DATA_DIR, 'daemon-error.log');
    if (fs.existsSync(errorLog)) {
      const lines = fs.readFileSync(errorLog, 'utf8').split('\n');
      if (lines.length > 1200) {
        fs.writeFileSync(errorLog, lines.slice(-1000).join('\n') + '\n');
        console.error(`[startup] Trimmed daemon-error.log (${lines.length} → 1000 lines)`);
      }
    }
  } catch {}

  await server.start();

  const s = settings.load();
  reschedule(s);

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
