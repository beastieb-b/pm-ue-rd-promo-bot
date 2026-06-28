const express = require('express');
const path = require('path');
const cfg = require('./config');
const state = require('./state');
const settings = require('./settings');

const app = express();
app.use(express.json({ limit: '8kb' }));

// CSRF guard for mutations: allow same-origin requests (the dashboard's own
// buttons) from any host — localhost OR the Tailscale hostname/IP — and block
// cross-origin ones. A browser always sends Origin on same-origin POSTs, and it
// must match the Host. (The old check required a localhost Host, which 403'd
// every button when the dashboard was opened over Tailscale.)
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
});
// Never cache the dashboard's own HTML/CSS/JS so UI updates always load
// (avoids stale layouts after a deploy, incl. home-screen / PWA caching).
app.use(express.static(path.join(cfg.APP_DIR, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));

// SSE clients for real-time updates
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── SSE endpoint ─────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const postmates = require('./postmates');
  const sessionValid = postmates.getSessionValid(); // null=unknown, true=ok, false=invalid
  const setup = settings.getSetupStatus();
  const cookieExists = setup.steps.find(s => s.id === 'login')?.done; // cookie present in profile

  // Determine login status:
  // - If we've actually navigated and it failed → definitely not logged in
  // - If we've actually navigated and succeeded → logged in
  // - If never navigated yet → use cookie as a hint (null = unknown)
  const loggedIn = sessionValid === false ? false
    : sessionValid === true ? true
    : cookieExists ? null   // cookie exists but unverified
    : false;                // no cookie at all

  res.json({
    ...state.getStats(),
    loggedIn,
    settings: settings.load(),
    setup,
    scanStatus: _getScanStatusFn ? _getScanStatusFn() : null,
    healthWarning: state.getHealthWarning(),
  });
});

app.delete('/api/health-warning', (req, res) => {
  state.clearHealthWarning();
  broadcast({ type: 'health_warning_cleared' });
  res.json({ cleared: true });
});

app.get('/api/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(state.getLog(limit));
});

app.get('/api/queue', (req, res) => {
  res.json({ queue: state.getQueueDetails() });
});

app.get('/api/processed', (req, res) => {
  res.json({ processed: state.getProcessedDetails() });
});

app.get('/api/settings', (req, res) => {
  res.json(settings.load());
});

app.post('/api/settings', (req, res) => {
  const { scanIntervalHours, applyIntervalHours } = req.body;
  const updates = {};

  if (scanIntervalHours !== undefined) {
    const h = parseFloat(scanIntervalHours);
    if (settings.SCAN_INTERVALS.includes(h)) updates.scanIntervalHours = h;
  }
  if (applyIntervalHours !== undefined) {
    const h = parseFloat(applyIntervalHours);
    if (settings.APPLY_INTERVALS.includes(h)) updates.applyIntervalHours = h;
  }
  if (req.body.homeRegion !== undefined) updates.homeRegion = req.body.homeRegion;
  if (req.body.homeAliases !== undefined) updates.homeAliases = req.body.homeAliases;

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  const saved = settings.save(updates);
  // Only reschedule when a timing field actually changed.
  if (_rescheduleFn && (updates.scanIntervalHours !== undefined || updates.applyIntervalHours !== undefined)) {
    _rescheduleFn(saved);
  }
  res.json(saved);
});

// ── Manual triggers ──────────────────────────────────────────────────────────

let _runRedditFn = null;
let _runApplyFn = null;
let _rescheduleFn = null;
let _getScanStatusFn = null;

function registerTriggers(redditFn, applyFn, rescheduleFn, getScanStatusFn) {
  _runRedditFn = redditFn;
  _runApplyFn = applyFn;
  _rescheduleFn = rescheduleFn;
  _getScanStatusFn = getScanStatusFn;
}

app.post('/api/quit', async (req, res) => {
  res.json({ bye: true });
  setTimeout(async () => {
    const postmates = require('./postmates');
    await postmates.closeBrowser();
    process.exit(0);
  }, 200);
});

app.post('/api/restart', (req, res) => {
  const { spawn } = require('child_process');
  const os = require('os');
  const plist = `${os.homedir()}/Library/LaunchAgents/com.postmates.promo.plist`;
  const isService = require('fs').existsSync(plist);

  res.json({ restarting: true, method: isService ? 'launchd' : 'process' });

  setTimeout(async () => {
    const postmates = require('./postmates');
    await postmates.closeBrowser();
    if (isService) {
      // launchctl unload kills this process immediately, so spawn a detached shell
      // that outlives us to fire the load after a delay.
      const child = spawn('sh', ['-c', `sleep 2 && launchctl load "${plist}"`], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      // Now unload — this process will be killed by launchd
      spawn('launchctl', ['unload', plist], { stdio: 'ignore' });
    } else {
      process.exit(0); // launcher script / npm start will handle restart
    }
  }, 300);
});

app.post('/api/self-test', async (req, res) => {
  const postmates = require('./postmates');
  res.json({ started: true });
  try {
    broadcast({ type: 'self_test_progress', step: 'running' });
    const result = await postmates.testDetection();
    broadcast({ type: 'self_test_done', ...result });
  } catch (err) {
    broadcast({ type: 'self_test_done', ok: false, error: err.message });
  }
});

app.post('/api/setup', async (req, res) => {
  const postmates = require('./postmates');
  res.json({ started: true });
  try {
    await postmates.setupLogin();
    settings.invalidateSetupStatus();
    broadcast({ type: 'setup_done', loggedIn: settings.isLoggedIn() });
  } catch (err) {
    broadcast({ type: 'error', message: `Setup failed: ${err.message}` });
  }
});

app.post('/api/run/reddit', async (req, res) => {
  if (!_runRedditFn) return res.status(503).json({ error: 'Not initialized' });
  res.json({ started: true });
  try {
    await _runRedditFn();
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  }
});

app.post('/api/run/apply', async (req, res) => {
  if (!_runApplyFn) return res.status(503).json({ error: 'Not initialized' });
  res.json({ started: true });
  try {
    await _runApplyFn({
      onProgress: (update) => broadcast({ type: 'apply_progress', ...update }),
    });
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  }
});

app.post('/api/queue/add', (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'code required' });
  const upper = state.normalizeCode(code);
  if (!upper) return res.status(400).json({ error: 'code must be 4-32 letters, numbers, underscores, or hyphens' });
  const added = state.addToQueue([upper]);
  broadcast({ type: 'queue_updated' });
  res.json({ added, code: upper });
});

app.delete('/api/processed/:code', (req, res) => {
  const deleted = state.deleteResult(req.params.code);
  broadcast({ type: 'processed_updated' });
  res.json({ deleted, code: req.params.code });
});

// Put a failed result back in the queue to be retried on the next apply run.
app.post('/api/processed/:code/requeue', (req, res) => {
  const requeued = state.requeueResult(req.params.code);
  broadcast({ type: 'queue_updated' });
  broadcast({ type: 'processed_updated' });
  res.json({ requeued, code: req.params.code });
});

// Manually correct a result's verdict — used to flag a success as region-locked
// (so it stops counting) or to count a region-locked one back as a success.
app.post('/api/processed/:code/reclassify', (req, res) => {
  const { result, detail } = req.body || {};
  if (!['success', 'region_skip'].includes(result)) {
    return res.status(400).json({ error: 'result must be "success" or "region_skip"' });
  }
  const updated = state.reclassifyResult(req.params.code, result, detail ?? null);
  broadcast({ type: 'processed_updated' });
  res.json({ updated, code: req.params.code, result });
});

app.delete('/api/queue/:code', (req, res) => {
  state.removeFromQueue(req.params.code);
  broadcast({ type: 'queue_updated' });
  res.json({ removed: req.params.code });
});

function start() {
  return new Promise((resolve, reject) => {
    const tryListen = (attemptsLeft) => {
      const srv = app.listen(cfg.DASHBOARD_PORT, cfg.DASHBOARD_HOST, () => {
        console.log(`📊 Dashboard: http://${cfg.DASHBOARD_HOST}:${cfg.DASHBOARD_PORT}`);
        resolve();
      });
      srv.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          // Previous instance hasn't released the port yet — wait and retry
          console.log(`Port ${cfg.DASHBOARD_PORT} busy, retrying in 3s... (${attemptsLeft} left)`);
          srv.close();
          setTimeout(() => tryListen(attemptsLeft - 1), 3000);
        } else {
          reject(err);
        }
      });
    };
    tryListen(5); // up to 5 retries = 15s window for old process to exit
  });
}

module.exports = { start, broadcast, registerTriggers };
