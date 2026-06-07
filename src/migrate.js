#!/usr/bin/env node
// Imports state from the old ~/.postmates-promo-tracker/ system.
// Run once: node src/migrate.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const cfg = require('./config');
const state = require('./state');

state.ensureDirs();

const OLD_DIR = path.join(os.homedir(), '.postmates-promo-tracker');

function readOld(file) {
  const p = path.join(OLD_DIR, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

console.log('📦 Migrating from', OLD_DIR, '\n');

// 1. Thread config
const threadId = readOld('thread_config.txt')?.trim();
const lastMonth = readOld('last_thread_month.txt')?.trim();
if (threadId) {
  fs.writeFileSync(cfg.THREAD_FILE, threadId);
  if (lastMonth) fs.writeFileSync(cfg.THREAD_MONTH_FILE, lastMonth);
  console.log(`✅ Thread ID: ${threadId} (${lastMonth || 'no month'})`);
} else {
  console.log('⚠️  No thread_config.txt found — will auto-detect on first run');
}

// 2. Processed codes (chrome_processed.txt)
const oldProcessed = readOld('chrome_processed.txt');
if (oldProcessed) {
  const lines = oldProcessed.split('\n').filter(Boolean);
  // Deduplicate: keep last result per code
  const seen = new Map();
  for (const line of lines) {
    const idx = line.lastIndexOf(':');
    if (idx === -1) continue;
    const code = line.slice(0, idx).trim().toUpperCase();
    const result = line.slice(idx + 1).trim();
    if (code && result) seen.set(code, result);
  }
  const content = [...seen.entries()].map(([c, r]) => `${c}:${r}`).join('\n') + '\n';
  fs.writeFileSync(cfg.PROCESSED_FILE, content);
  console.log(`✅ Processed codes: ${seen.size} imported`);
} else {
  console.log('⚠️  No chrome_processed.txt found');
}

// 3. Queue (chrome_queue.txt) — filter out already-processed codes
const oldQueue = readOld('chrome_queue.txt');
if (oldQueue) {
  const processed = new Set(state.getProcessed().map(r => r.code));
  const queueCodes = oldQueue.split('\n').map(l => l.trim()).filter(l => l && !processed.has(l));
  if (queueCodes.length) {
    fs.writeFileSync(cfg.QUEUE_FILE, queueCodes.join('\n') + '\n');
    console.log(`✅ Queue: ${queueCodes.length} codes imported`);
  } else {
    console.log('ℹ️  Queue: all codes already processed, nothing to import');
  }
} else {
  console.log('⚠️  No chrome_queue.txt found');
}

// 4. Tried codes (tried_codes.json)
const oldTried = readOld('tried_codes.json');
if (oldTried) {
  try {
    const data = JSON.parse(oldTried);
    state.saveTriedState(data);
    console.log(`✅ Tried codes: ${data.tried_codes?.length ?? 0} codes, ${data.successful_codes?.length ?? 0} successes`);
  } catch {
    console.log('⚠️  tried_codes.json is malformed, skipping');
  }
} else {
  console.log('⚠️  No tried_codes.json found');
}

console.log('\n✅ Migration complete. Run `node src/index.js` to start the daemon.');
console.log('   Run `node src/index.js --setup` first if you need to log into Postmates.\n');
