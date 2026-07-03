const path = require('path');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const ARCHIVE_DIR = path.join(APP_DIR, 'archive');
const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

module.exports = {
  APP_DIR,
  DATA_DIR,
  ARCHIVE_DIR,
  BROWSER_PROFILE_DIR,

  // State files — Postmates (r/postmates)
  QUEUE_FILE: path.join(DATA_DIR, 'queue.txt'),
  PROCESSED_FILE: path.join(DATA_DIR, 'processed.txt'),
  THREAD_FILE: path.join(DATA_DIR, 'thread_config.txt'),
  THREAD_MONTH_FILE: path.join(DATA_DIR, 'last_thread_month.txt'),
  THREAD_DETECTED_FILE: path.join(DATA_DIR, 'last_thread_detected.txt'),
  TRIED_FILE: path.join(DATA_DIR, 'tried_codes.json'),
  LOG_FILE: path.join(DATA_DIR, 'run_log.jsonl'),
  SESSION_STATE_FILE: path.join(DATA_DIR, 'session_state.json'),
  CODE_CATALOG_FILE: path.join(DATA_DIR, 'code_catalog.json'),
  APPLIED_LEDGER_FILE: path.join(DATA_DIR, 'applied_codes.json'),

  // State files — Uber Eats (r/UberEATS) — shares queue + processed with Postmates
  UE_THREAD_FILE: path.join(DATA_DIR, 'ue_thread_config.txt'),
  UE_THREAD_MONTH_FILE: path.join(DATA_DIR, 'ue_last_thread_month.txt'),
  UE_THREAD_DETECTED_FILE: path.join(DATA_DIR, 'ue_last_thread_detected.txt'),
  UE_TRIED_FILE: path.join(DATA_DIR, 'ue_tried_codes.json'),

  // Postmates automation
  MAX_CODES_PER_RUN: 5,
  CODE_WAIT_MS: 2 * 60 * 1000,         // 2 minutes between codes
  PROMO_URL: 'https://postmates.com/feed?diningMode=DELIVERY&mod=promos&ps=1',
  // UberEats uses the same Uber feed promo modal as Postmates (separate login).
  // Codes rejected on Postmates (except "Code expired") are retried here.
  UBEREATS_PROMO_URL: 'https://www.ubereats.com/feed?diningMode=DELIVERY&mod=promos&ps=1',

  // Dashboard — use PORT env var if set (for preview panel), else 8766.
  // Bind to 0.0.0.0 so the dashboard is reachable from other devices on the
  // network — in practice over Tailscale at http://plexmini:8766. There's no
  // auth, so this relies on the network (Tailscale tailnet / home LAN) for
  // access control; set HOST=127.0.0.1 to restrict to this machine only.
  DASHBOARD_PORT: parseInt(process.env.PORT) || 8766,
  DASHBOARD_HOST: process.env.HOST || '0.0.0.0',
};
