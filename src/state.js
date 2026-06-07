const fs = require('fs');
const path = require('path');
const cfg = require('./config');

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
  fs.writeFileSync(cfg.CODE_CATALOG_FILE, JSON.stringify(catalog, null, 2));
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
  fs.writeFileSync(cfg.QUEUE_FILE, queue.join('\n') + (queue.length ? '\n' : ''));
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
    fs.writeFileSync(cfg.PROCESSED_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
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
  fs.writeFileSync(cfg.TRIED_FILE, JSON.stringify(state, null, 2));
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
  fs.writeFileSync(cfg.THREAD_FILE, id);
  fs.writeFileSync(cfg.THREAD_MONTH_FILE, month);
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

  appendLog({ type: 'monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth });
}

// ── Log ─────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(cfg.LOG_FILE, line + '\n');
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
  fs.writeFileSync(cfg.UE_THREAD_FILE, id);
  fs.writeFileSync(cfg.UE_THREAD_MONTH_FILE, month);
}

function getUETriedState() {
  if (!fs.existsSync(cfg.UE_TRIED_FILE)) {
    return { thread_id: '', tried_codes: [] };
  }
  try { return JSON.parse(fs.readFileSync(cfg.UE_TRIED_FILE, 'utf8')); }
  catch { return { thread_id: '', tried_codes: [] }; }
}

function saveUETriedState(state) {
  fs.writeFileSync(cfg.UE_TRIED_FILE, JSON.stringify(state, null, 2));
}

function ueMonthlyReset(oldThreadId, newThreadId, newMonth) {
  saveUETriedState({ thread_id: newThreadId, tried_codes: [] });
  saveUEThreadId(newThreadId, newMonth);
  appendLog({ type: 'ue_monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth });
}

// ── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const processed = getProcessedDetails();
  const queue = getQueueDetails();
  const catalog = getCodeCatalog();

  const successes = processed.filter(r => r.result === 'success');
  const rejected = processed.filter(r => r.result === 'rejected');
  const rateLimited = processed.filter(r => r.result === 'ratelimited');

  return {
    threadId: getThreadId(),
    threadMonth: getThreadMonth(),
    ueThreadId: getUEThreadId(),
    ueThreadMonth: getUEThreadMonth(),
    queueCount: queue.length,
    totalTried: processed.length,
    successCount: successes.length,
    rejectedCount: rejected.length,
    rateLimitedCount: rateLimited.length,
    successRate: processed.length ? Math.round(successes.length / processed.length * 100) : 0,
    successCodes: successes.map(r => r.code),
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
  getProcessed, markResult, deleteResult,
  getProcessedDetails,
  getTriedState, saveTriedState,
  getThreadId, getThreadMonth, saveThreadId,
  monthlyReset,
  getUEThreadId, getUEThreadMonth, saveUEThreadId,
  getUETriedState, saveUETriedState,
  ueMonthlyReset,
  appendLog, getLog,
  getStats,
};
