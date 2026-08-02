const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');

function ensureDirs() {
  [cfg.DATA_DIR, cfg.ARCHIVE_DIR, cfg.BROWSER_PROFILE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── Queue (codes waiting to be applied) ─────────────────────────────────────

function getQueue() {
  if (!fs.existsSync(cfg.QUEUE_FILE)) return [];
  return fs.readFileSync(cfg.QUEUE_FILE, 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);
}

function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(normalized) ? normalized : null;
}

function getCodeCatalog() {
  if (!fs.existsSync(cfg.CODE_CATALOG_FILE)) return { codes: {}, sources: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cfg.CODE_CATALOG_FILE, 'utf8'));
    return {
      codes: parsed.codes || {},
      sources: parsed.sources || {},
    };
  } catch {
    return { codes: {}, sources: {} };
  }
}

function saveCodeCatalog(catalog) {
  writeFileAtomic(cfg.CODE_CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

function mergeCodeMeta(code, meta = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const catalog = getCodeCatalog();
  const current = catalog.codes[normalized] || {};
  catalog.codes[normalized] = {
    ...current,
    ...meta,
    code: normalized,
    updatedAt: new Date().toISOString(),
  };
  saveCodeCatalog(catalog);
  return true;
}

function setSourceStatus(sourceKey, status = {}) {
  const catalog = getCodeCatalog();
  catalog.sources[sourceKey] = {
    ...(catalog.sources[sourceKey] || {}),
    ...status,
    updatedAt: new Date().toISOString(),
  };
  saveCodeCatalog(catalog);
}

function addToQueue(entries) {
  const existing = new Set(getQueue());
  const processed = new Set(getProcessed().map(r => r.code));
  const catalog = getCodeCatalog();
  const normalizedEntries = entries
    .map(entry => typeof entry === 'string' ? { code: entry } : entry)
    .map(entry => {
      const code = normalizeCode(entry.code);
      return code ? { ...entry, code } : null;
    })
    .filter(Boolean);
  const deduped = new Map();
  for (const entry of normalizedEntries) deduped.set(entry.code, entry);
  const uniqueEntries = [...deduped.values()];
  const newEntries = uniqueEntries.filter(entry => !existing.has(entry.code) && !processed.has(entry.code));
  const newCodes = newEntries.map(entry => entry.code);
  if (!newCodes.length) return 0;
  for (const entry of uniqueEntries) {
    catalog.codes[entry.code] = {
      ...(catalog.codes[entry.code] || {}),
      ...entry,
      code: entry.code,
      updatedAt: new Date().toISOString(),
    };
  }
  saveCodeCatalog(catalog);
  fs.appendFileSync(cfg.QUEUE_FILE, newCodes.join('\n') + '\n');
  return newCodes.length;
}

function removeFromQueue(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const queue = getQueue().filter(c => c !== normalized);
  writeFileAtomic(cfg.QUEUE_FILE, queue.join('\n') + (queue.length ? '\n' : ''));
  return true;
}

// ── Processed results ────────────────────────────────────────────────────────

function getProcessed() {
  if (!fs.existsSync(cfg.PROCESSED_FILE)) return [];
  return fs.readFileSync(cfg.PROCESSED_FILE, 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(line => {
      if (line.includes('\t')) {
        // Format: CODE\tresult\tdetail\ttimestamp
        const [code, result, detail, ts] = line.split('\t');
        return { code, result, detail: detail || null, ts: ts || null };
      }
      // Legacy format: CODE:result
      const idx = line.lastIndexOf(':');
      if (idx === -1) return null;
      return { code: line.slice(0, idx), result: line.slice(idx + 1), detail: null, ts: null };
    })
    .filter(Boolean);
}

function getQueueDetails() {
  const catalog = getCodeCatalog();
  return getQueue().map(code => ({
    code,
    ...(catalog.codes[code] || {}),
  }));
}

function getProcessedDetails() {
  const catalog = getCodeCatalog();
  return getProcessed().map(item => ({
    ...item,
    ...(catalog.codes[item.code] || {}),
  }));
}

function deleteResult(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;

  // 1. Remove from processed.txt
  if (fs.existsSync(cfg.PROCESSED_FILE)) {
    const lines = fs.readFileSync(cfg.PROCESSED_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .filter(line => {
        const entryCode = line.includes('\t') ? line.split('\t')[0] : line.slice(0, line.lastIndexOf(':'));
        return entryCode !== normalized;
      });
    writeFileAtomic(cfg.PROCESSED_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
  }

  // 2. Remove from tried_codes.json so the next Reddit scan re-queues it
  const tried = getTriedState();
  tried.tried_codes = tried.tried_codes.filter(c => c !== normalized);
  tried.successful_codes = (tried.successful_codes || []).filter(c => c !== normalized);
  tried.failed_codes = (tried.failed_codes || []).filter(c => c !== normalized);
  saveTriedState(tried);

  const ueTried = getUETriedState();
  ueTried.tried_codes = (ueTried.tried_codes || []).filter(c => c !== normalized);
  saveUETriedState(ueTried);

  return true;
}

function markResult(code, result, detail = null) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  removeFromQueue(normalized);
  const safeDetail = detail ? detail.replace(/[\t\n\r]/g, ' ').slice(0, 120) : '';
  const ts = new Date().toISOString();
  fs.appendFileSync(cfg.PROCESSED_FILE, `${normalized}\t${result}\t${safeDetail}\t${ts}\n`);
  // Success AND region_skip both mean the code landed on the account — record
  // them so a scan won't re-queue the code while it's still sitting there.
  if (result === 'success' || result === 'region_skip') recordApplied(normalized);
  return true;
}

// ── Applied-codes ledger ─────────────────────────────────────────────────────
// Codes that actually landed on the account (success or region_skip), with when.
// Scans skip re-queueing a code applied within REAPPLY_SKIP_DAYS — e.g. after
// the monthly reset wipes tried_codes, last cycle's wins would otherwise be
// re-tried and burn an apply slot on "Oops, you already applied this promotion".
// Past the window the code is eligible again (promos do get refreshed).

const REAPPLY_SKIP_DAYS = 14;

function loadAppliedLedger() {
  try { return JSON.parse(fs.readFileSync(cfg.APPLIED_LEDGER_FILE, 'utf8')); }
  catch { return {}; }
}

function recordApplied(code, ts = new Date().toISOString()) {
  const ledger = loadAppliedLedger();
  ledger[code] = ts;
  // Prune entries old enough that they can never matter again.
  const cutoff = Date.now() - REAPPLY_SKIP_DAYS * 2 * 86400000;
  for (const [c, t] of Object.entries(ledger)) {
    const ms = new Date(t).getTime();
    if (isNaN(ms) || ms < cutoff) delete ledger[c];
  }
  writeFileAtomic(cfg.APPLIED_LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

// Set of codes applied within the last `days`. `ledger` is injectable for tests.
function getRecentlyApplied(days = REAPPLY_SKIP_DAYS, ledger = loadAppliedLedger(), now = Date.now()) {
  const cutoff = now - days * 86400000;
  const out = new Set();
  for (const [code, ts] of Object.entries(ledger)) {
    const ms = new Date(ts).getTime();
    if (!isNaN(ms) && ms >= cutoff) out.add(code);
  }
  return out;
}

// Put a processed code back in the queue to be tried again. Removes it from
// processed + tried state (so it's eligible) and re-adds it to the queue with
// its existing catalog metadata. Used by the "retry" action on failed results.
function requeueResult(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  deleteResult(normalized); // clears it from processed.txt and tried_codes
  const meta = getCodeCatalog().codes[normalized] || {};
  addToQueue([{ code: normalized, ...meta }]);
  return true;
}

// Change an already-processed code's result in place (keeps its timestamp).
// Used by the dashboard to let the user correct a verdict — e.g. flag a
// success as region-locked (so it stops counting) or count one back.
function reclassifyResult(code, newResult, detail = null) {
  const normalized = normalizeCode(code);
  if (!normalized || !fs.existsSync(cfg.PROCESSED_FILE)) return false;
  const safeDetail = detail !== null ? String(detail).replace(/[\t\n\r]/g, ' ').slice(0, 120) : null;
  let found = false;
  const lines = fs.readFileSync(cfg.PROCESSED_FILE, 'utf8').split('\n').filter(Boolean).map(line => {
    const parts = line.includes('\t') ? line.split('\t') : [line.slice(0, line.lastIndexOf(':')), line.slice(line.lastIndexOf(':') + 1)];
    if (parts[0] !== normalized) return line;
    found = true;
    const [c, , oldDetail, ts] = parts;
    return [c, newResult, safeDetail !== null ? safeDetail : (oldDetail || ''), ts || new Date().toISOString()].join('\t');
  });
  if (!found) return false;
  writeFileAtomic(cfg.PROCESSED_FILE, lines.join('\n') + '\n');
  // Keep the catalog's region flag in sync with a manual region-lock toggle.
  mergeCodeMeta(normalized, { regionRestricted: newResult === 'region_skip' });
  return true;
}

// ── Tried codes (codes found in Reddit thread, avoids re-queuing) ────────────

function getTriedState() {
  if (!fs.existsSync(cfg.TRIED_FILE)) {
    return { thread_id: '', tried_codes: [], successful_codes: [], failed_codes: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(cfg.TRIED_FILE, 'utf8'));
  } catch {
    return { thread_id: '', tried_codes: [], successful_codes: [], failed_codes: [] };
  }
}

function saveTriedState(state) {
  writeFileAtomic(cfg.TRIED_FILE, JSON.stringify(state, null, 2));
}

// ── Thread config ────────────────────────────────────────────────────────────

function getThreadId() {
  if (!fs.existsSync(cfg.THREAD_FILE)) return null;
  return fs.readFileSync(cfg.THREAD_FILE, 'utf8').trim() || null;
}

function getThreadMonth() {
  if (!fs.existsSync(cfg.THREAD_MONTH_FILE)) return null;
  return fs.readFileSync(cfg.THREAD_MONTH_FILE, 'utf8').trim() || null;
}

function saveThreadId(id, month) {
  writeFileAtomic(cfg.THREAD_FILE, id);
  writeFileAtomic(cfg.THREAD_MONTH_FILE, month);
}

function getThreadDetectedAt() {
  if (!fs.existsSync(cfg.THREAD_DETECTED_FILE)) return null;
  return fs.readFileSync(cfg.THREAD_DETECTED_FILE, 'utf8').trim() || null;
}

function getUEThreadDetectedAt() {
  if (!fs.existsSync(cfg.UE_THREAD_DETECTED_FILE)) return null;
  return fs.readFileSync(cfg.UE_THREAD_DETECTED_FILE, 'utf8').trim() || null;
}

// Grace before we treat a still-old thread as a problem, and how long into the
// month we surface positive "thread found" confirmation. Single source of truth
// shared with reddit.js's staleness check.
const STALE_THREAD_GRACE_DAYS = 3;
const EARLY_MONTH_DAYS = 5;

// Per-source state of the monthly-thread handoff, for the dashboard to render:
//   'found'   — the current month's thread is loaded (success)
//   'waiting' — still on last month's thread but within the grace window
//   'stale'   — still on last month's thread past the grace window (a problem)
//   'unknown' — no thread/month recorded yet
function computeThreadState(month, currentMonth, day) {
  if (!month) return 'unknown';
  if (month >= currentMonth) return 'found';
  return day >= STALE_THREAD_GRACE_DAYS ? 'stale' : 'waiting';
}

function getThreadFreshness() {
  // UTC day to match the UTC-based month (and the UTC-stamped stored month) —
  // a local getDate() here would disagree with the month for ~7h at each
  // rollover, flipping a source to a bogus "waiting/stale" state.
  const now = new Date();
  const day = now.getUTCDate();
  const currentMonth = now.toISOString().slice(0, 7);
  const sources = [
    { label: 'r/postmates', subreddit: 'postmates', threadId: getThreadId(), month: getThreadMonth(), detectedAt: getThreadDetectedAt() },
    { label: 'r/UberEATS', subreddit: 'UberEATS', threadId: getUEThreadId(), month: getUEThreadMonth(), detectedAt: getUEThreadDetectedAt() },
  ].map(s => ({ ...s, state: computeThreadState(s.month, currentMonth, day) }));
  return { currentMonth, day, earlyMonth: day <= EARLY_MONTH_DAYS, graceDays: STALE_THREAD_GRACE_DAYS, sources };
}

// ── Monthly reset ─────────────────────────────────────────────────────────────
// Called when a new monthly thread is detected.
// Archives current queue/processed files, resets tried state.

function monthlyReset(oldThreadId, newThreadId, newMonth) {
  const stamp = new Date().toISOString().slice(0, 10);

  // Ensure archive dir exists before renaming into it
  if (!fs.existsSync(cfg.ARCHIVE_DIR)) fs.mkdirSync(cfg.ARCHIVE_DIR, { recursive: true });

  // Archive existing files — use copy+delete instead of rename to handle cross-device moves
  for (const [src, suffix] of [[cfg.QUEUE_FILE, 'queue'], [cfg.PROCESSED_FILE, 'processed']]) {
    if (fs.existsSync(src)) {
      const dest = path.join(cfg.ARCHIVE_DIR, `${stamp}-${oldThreadId || 'unknown'}-${suffix}.txt`);
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      } catch (e) {
        appendLog({ type: 'archive_warn', file: src, error: e.message });
      }
    }
  }

  // Fresh tried_codes state for new thread
  saveTriedState({ thread_id: newThreadId, tried_codes: [], successful_codes: [], failed_codes: [] });
  saveThreadId(newThreadId, newMonth);
  writeFileAtomic(cfg.THREAD_DETECTED_FILE, new Date().toISOString()); // when this thread was found

  appendLog({ type: 'monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth });
}

// ── Log ─────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  // Logging must never take down a scan/apply run — a full disk or a
  // permissions hiccup on the log file is not worth crashing for.
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(cfg.LOG_FILE, line + '\n');
  } catch (err) {
    console.error('appendLog failed:', err.message);
  }
}

function getLog(limit = 200) {
  if (!fs.existsSync(cfg.LOG_FILE)) return [];
  const lines = fs.readFileSync(cfg.LOG_FILE, 'utf8')
    .split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

// ── Uber Eats thread state (mirrors Postmates but separate files) ────────────

function getUEThreadId() {
  if (!fs.existsSync(cfg.UE_THREAD_FILE)) return null;
  return fs.readFileSync(cfg.UE_THREAD_FILE, 'utf8').trim() || null;
}

function getUEThreadMonth() {
  if (!fs.existsSync(cfg.UE_THREAD_MONTH_FILE)) return null;
  return fs.readFileSync(cfg.UE_THREAD_MONTH_FILE, 'utf8').trim() || null;
}

function saveUEThreadId(id, month) {
  writeFileAtomic(cfg.UE_THREAD_FILE, id);
  writeFileAtomic(cfg.UE_THREAD_MONTH_FILE, month);
}

function getUETriedState() {
  if (!fs.existsSync(cfg.UE_TRIED_FILE)) {
    return { thread_id: '', tried_codes: [] };
  }
  try { return JSON.parse(fs.readFileSync(cfg.UE_TRIED_FILE, 'utf8')); }
  catch { return { thread_id: '', tried_codes: [] }; }
}

function saveUETriedState(state) {
  writeFileAtomic(cfg.UE_TRIED_FILE, JSON.stringify(state, null, 2));
}

function ueMonthlyReset(oldThreadId, newThreadId, newMonth) {
  saveUETriedState({ thread_id: newThreadId, tried_codes: [] });
  saveUEThreadId(newThreadId, newMonth);
  writeFileAtomic(cfg.UE_THREAD_DETECTED_FILE, new Date().toISOString()); // when this thread was found
  appendLog({ type: 'ue_monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth });
}

// ── Health warning (shown as a banner in the dashboard) ─────────────────────

const HEALTH_FILE = path.join(cfg.DATA_DIR, 'health.json');

function setHealthWarning(message, source = 'general') {
  writeFileAtomic(HEALTH_FILE, JSON.stringify({ message, source, ts: new Date().toISOString() }));
}

function getHealthWarning() {
  if (!fs.existsSync(HEALTH_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return null; }
}

function clearHealthWarning() {
  try { fs.unlinkSync(HEALTH_FILE); } catch {}
}

// ── Heartbeat (persisted last-success times for the staleness watchdog) ──────
// Survives daemon restarts so the dashboard can tell "hasn't run in X hours"
// even right after a restart or a machine wake.

const HEARTBEAT_FILE = path.join(cfg.DATA_DIR, 'heartbeat.json');

function getHeartbeat() {
  if (!fs.existsSync(HEARTBEAT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); } catch { return {}; }
}

// kind: 'scan' (a successful source scan) or 'apply' (a completed apply run)
function recordHeartbeat(kind) {
  const hb = getHeartbeat();
  hb[kind] = new Date().toISOString();
  writeFileAtomic(HEARTBEAT_FILE, JSON.stringify(hb));
}

// ── Savings ──────────────────────────────────────────────────────────────────

// Pull a dollar amount out of a result detail like "$20 off" or "Save $15".
// Percentage promos ("10% off") have no fixed dollar value, so they count as 0.
function parseSavings(detail) {
  if (!detail) return 0;
  const m = String(detail).match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Total fixed-dollar savings across a list of success results.
function sumSavings(successes) {
  return successes.reduce((acc, r) => acc + parseSavings(r.detail), 0);
}

// Savings from the most recently archived processed file (previous month),
// so the dashboard can show a month-over-month delta. Returns null if none.
function getLastMonthSavings() {
  try {
    if (!fs.existsSync(cfg.ARCHIVE_DIR)) return null;
    const files = fs.readdirSync(cfg.ARCHIVE_DIR)
      .filter(f => f.endsWith('-processed.txt'))
      .sort();
    if (!files.length) return null;
    const latest = path.join(cfg.ARCHIVE_DIR, files[files.length - 1]);
    const lines = fs.readFileSync(latest, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    let total = 0;
    for (const line of lines) {
      if (!line.includes('\t')) continue;
      const [, result, detail] = line.split('\t');
      if (result === 'success') total += parseSavings(detail);
    }
    return total;
  } catch {
    return null;
  }
}

// Total fixed-dollar savings across every archived month (all prior cycles).
function sumArchiveSavings() {
  try {
    if (!fs.existsSync(cfg.ARCHIVE_DIR)) return 0;
    const files = fs.readdirSync(cfg.ARCHIVE_DIR).filter(f => f.endsWith('-processed.txt'));
    let total = 0;
    for (const f of files) {
      const lines = fs.readFileSync(path.join(cfg.ARCHIVE_DIR, f), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.includes('\t')) continue;
        const [, result, detail] = line.split('\t');
        if (result === 'success') total += parseSavings(detail);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// Fixed-dollar savings bucketed by calendar month (from row timestamps), across
// every archived cycle plus the current one. Old migrated rows without a
// timestamp carry no dollar detail either, so skipping them loses nothing.
// The current month is always present (even at $0) so the graph shows "so far".
function getMonthlySavings() {
  const buckets = {};
  const addFile = (file) => {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); }
    catch { return; }
    for (const line of lines) {
      if (!line.includes('\t')) continue;
      const [, result, detail, ts] = line.split('\t');
      if (result !== 'success' || !ts) continue;
      const month = ts.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      buckets[month] = (buckets[month] || 0) + parseSavings(detail);
    }
  };
  try {
    if (fs.existsSync(cfg.ARCHIVE_DIR)) {
      for (const f of fs.readdirSync(cfg.ARCHIVE_DIR).filter(f => f.endsWith('-processed.txt'))) {
        addFile(path.join(cfg.ARCHIVE_DIR, f));
      }
    }
  } catch {}
  addFile(cfg.PROCESSED_FILE);
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!(thisMonth in buckets)) buckets[thisMonth] = 0;
  return Object.entries(buckets)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, saved]) => ({ month, saved }));
}

// When the cycle last turned over — derived from the newest archive filename
// (YYYY-MM-DD-...). Returns an ISO date string or null if it's never reset.
function getLastResetDate() {
  try {
    if (!fs.existsSync(cfg.ARCHIVE_DIR)) return null;
    const dates = fs.readdirSync(cfg.ARCHIVE_DIR)
      .map(f => (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1])
      .filter(Boolean)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  } catch {
    return null;
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const processed = getProcessedDetails();
  const queue = getQueueDetails();
  const catalog = getCodeCatalog();

  const successes = processed.filter(r => r.result === 'success');
  // "Already applied" successes are confirmations that a code from an earlier
  // cycle is still on the account — not fresh wins. Their dollars were counted
  // the month they originally applied, so they must not inflate this month's
  // "codes applied" count (a "$0 saved across 1 code" hero makes no sense).
  const isAlready = (r) => /^Already applied/.test(r.detail || '');
  const freshSuccesses = successes.filter(r => !isAlready(r));
  const rejected = processed.filter(r => r.result === 'rejected');
  const rateLimited = processed.filter(r => r.result === 'ratelimited');
  const regionLocked = processed.filter(r => r.result === 'region_skip');

  const savedThisMonth = sumSavings(successes);
  const savedLastMonth = getLastMonthSavings();

  return {
    threadId: getThreadId(),
    threadMonth: getThreadMonth(),
    ueThreadId: getUEThreadId(),
    ueThreadMonth: getUEThreadMonth(),
    threadFreshness: getThreadFreshness(),
    // Codes inside the 14-day re-apply skip window — shown on the Queue page so
    // "why isn't X queued?" has a visible answer instead of one log line.
    recentlyAppliedList: Object.entries(loadAppliedLedger())
      .map(([code, ts]) => ({ code, appliedAt: ts, ms: new Date(ts).getTime() }))
      .filter(e => !isNaN(e.ms) && e.ms >= Date.now() - REAPPLY_SKIP_DAYS * 86400000)
      .sort((a, b) => b.ms - a.ms)
      .map(({ code, appliedAt }) => ({ code, appliedAt })),
    reapplySkipDays: REAPPLY_SKIP_DAYS,
    queueCount: queue.length,
    totalTried: processed.length,
    successCount: freshSuccesses.length,
    alreadyOnAccountCount: successes.length - freshSuccesses.length,
    rejectedCount: rejected.length,
    rateLimitedCount: rateLimited.length,
    successRate: processed.length ? Math.round(successes.length / processed.length * 100) : 0,
    savedThisMonth,
    savedLastMonth,
    savedLifetime: savedThisMonth + sumArchiveSavings(),
    monthlySavings: getMonthlySavings(),
    lastResetDate: getLastResetDate(),
    appVersion: require('../package.json').version,
    heartbeat: getHeartbeat(),
    successCodes: successes.map(r => r.code),
    successList: successes.map(r => ({ code: r.code, detail: r.detail, already: isAlready(r) })),
    regionLockedCount: regionLocked.length,
    regionLockedList: regionLocked.map(r => ({ code: r.code, detail: r.detail })),
    recentResults: processed.slice(-20).reverse(),
    queue: queue.slice(0, 30),
    monitoredSources: Object.entries(catalog.sources)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => (a.label || a.key).localeCompare(b.label || b.key)),
  };
}

module.exports = {
  ensureDirs,
  normalizeCode,
  getCodeCatalog, saveCodeCatalog, mergeCodeMeta, setSourceStatus,
  getQueue, addToQueue, removeFromQueue,
  getQueueDetails,
  getProcessed, markResult, reclassifyResult, requeueResult, deleteResult,
  getProcessedDetails,
  getTriedState, saveTriedState,
  getThreadId, getThreadMonth, saveThreadId,
  getThreadDetectedAt, getUEThreadDetectedAt,
  getThreadFreshness, computeThreadState,
  STALE_THREAD_GRACE_DAYS,
  monthlyReset,
  getUEThreadId, getUEThreadMonth, saveUEThreadId,
  getUETriedState, saveUETriedState,
  ueMonthlyReset,
  appendLog, getLog,
  recordApplied, getRecentlyApplied, REAPPLY_SKIP_DAYS,
  getMonthlySavings,
  setHealthWarning, getHealthWarning, clearHealthWarning,
  getHeartbeat, recordHeartbeat,
  parseSavings, sumSavings,
  getStats,
};
