# 🍔 Promo Tracker

Automatically finds **existing-user** promo codes for Postmates, applies them to
your account, and tracks how much you've actually saved — all from a local web
dashboard.

It monitors the monthly promo-code threads, extracts the codes, and applies each one
through a real logged-in Chrome session. Codes that Postmates reports as locked
to another city (e.g. "Las Vegas") are detected and **excluded from your savings
total** so the number stays honest.

---

## How it works

```
                 ┌───────────────────────── daemon (launchd) ─────────────────────────┐
  every 30 min   │  scan  ──▶  extract codes  ──▶  queue (priority-ordered)     │
  every 2 h      │  Apply run    ──▶  open promo modal in Chrome  ──▶  type + apply     │
                 │                     └▶ detect result: success / rejected / region    │
                 └───────────────────────────────────────────────────────────────────┘
                                  ▲                              │
                                  │  SSE + REST                  ▼
                          Dashboard (Express, :8766)     data/*.json / *.txt
```

1. **Scan** — fetches the current monthly thread from `old.reddit.com` (via
   `curl`, because Reddit TLS-fingerprints Node's HTTP stack) and scrapes the
   comments. New threads each month are detected automatically and the queue is
   archived + reset. Detection uses old.reddit search first, then falls back to
   the subreddit's stickied/new listing (which doesn't depend on search
   indexing, so a freshly-posted thread is caught right at month rollover). If a
   source is still on last month's thread a few days into the new month, the
   dashboard raises a banner so a missed rollover never goes unnoticed.
2. **Extract** — pulls promo-code-shaped tokens out of the comments, filtering
   common false positives (English words, city names, time strings, etc.).
3. **Apply** — opens the Postmates promo modal in a real headed Chrome profile
   (Postmates blocks headless), types each code, clicks Apply, and reads the
   result. Max **5 codes per run**, **2 minutes apart**, to avoid rate limiting.
   Codes are tried best-first (digit-containing → confidence → most recent).
   When a scan queues **new** codes, an apply run starts **immediately** instead
   of waiting for the next scheduled run (guarded: never while a run is active,
   ≥30 min since the last run, and a 2 h backoff after any rate-limited run).
   The only codes ever skipped are ones **already on the account** — applied
   (success or region-locked) within the last **14 days** — since re-trying
   those just returns "you already applied this promotion"; past that window
   they become eligible again.
4. **Classify & record** — `success` (with the discount), `rejected` (with the
   reason), `region_skip` (applied but locked to a non-home city), `ratelimited`
   (stops the run, keeps codes queued), or transient `error` (retried next run).
5. **UberEats fallback** — if a code is rejected on Postmates for any reason
   **except "Code expired"**, it's retried on **UberEats** (same Uber promo
   modal, needs its own login). A win there counts toward your savings but is
   clearly labeled "UberEats" in the dashboard.

---

## Requirements

- **macOS** (uses `launchd` for the background service and Chrome for automation)
- **Node.js ≥ 20.18.1**
- **Google Chrome** (Playwright drives the installed Chrome via `channel: 'chrome'`)
- `curl` and `sqlite3` (preinstalled on macOS)

---

## Setup

```sh
# 1. Install dependencies
npm install

# 2. Install the Playwright Chrome driver (uses your installed Chrome)
npx playwright install chrome

# 3. Log into Postmates (opens Chrome — log in, then close the window)
npm run setup

# 4. Install the background service (runs automatically at login)
npm run install-service
```

Also log into **UberEats** from the dashboard (Settings → **Log in to UberEats**)
so the rejection fallback can apply codes there too — it's a separate session.

Then open the dashboard at **http://localhost:8766** and finish any remaining
items in the Setup checklist.

The dashboard binds to `0.0.0.0`, so on a Tailscale tailnet you can also reach it
from your phone/laptop at **http://<machine>:8766** (e.g. `http://plexmini:8766`).
There is no login — access is gated by your network (Tailscale / LAN). Set
`HOST=127.0.0.1` to restrict it to the local machine only.

---

## Dashboard

| Section | What it shows |
|---|---|
| **Dashboard** | Total saved this month (region-locked codes excluded), codes applied, queue size, successful-code chips, recent activity, a "Worked, but region-locked" card, a **"Savings by Month"** chart, a **"This Month's Thread"** card (positive confirmation the new monthly thread was detected — shown through the first few days of each month, with a waiting/stale indicator if a source hasn't rolled over yet), and live source health. Session-expired banners have a **one-click "Log in"** button that opens Chrome on the server directly. |
| **Queue** | Codes waiting to be tried, with source + region hints. Add codes manually. |
| **Results** | Every attempt with result, reason, timestamp, and a link to the exact Reddit comment. Per-row actions: **↻ Retry** (failed), **📍 mark region-locked** (success that doesn't count), **✓$ count it** (region-locked that actually works), and delete. |
| **Activity Log** | Raw event log. |
| **Settings** | Login status, detected threads, **System Health** self-test, scan/apply intervals, and **Home Region**. |

Live status bar: `Automation ON · Scan every 30m · Apply every 2h · Next scan in
… · Next apply in …`, an **"Applying codes…"** state while a run is in progress,
and a red **staleness warning** if no successful scan has happened in a while
(e.g. the Mac was asleep).

---

## Configuration (Settings page)

- **Source scan interval** — how often to check Reddit (default every 2 h; can go
  to every 30 min).
- **Code apply interval** — how often to try queued codes (default every 4 h).
- **Home region** — your city + aliases (default *Los Angeles* / `la, socal,
  southern california`). Promos localized to anywhere else are marked
  region-locked and excluded from your savings total; national, statewide
  (California), and home-region promos all count.

Environment variables: `PORT` (default `8766`), `HOST` (default `0.0.0.0`).

---

## Region & savings logic

"Saved this month" sums only results with `result === 'success'`. A code becomes
`region_skip` (excluded) when:

1. **Postmates says so** — the apply confirmation modal shows a `Location:` that
   isn't home/California/nationwide. This is the source of truth.
2. **Reddit says so** — a comment explicitly restricts it ("vegas only"). This
   only *labels* in the queue; it never blocks the attempt (community reports are
   often wrong).

You can always override a verdict from the Results table (mark region-locked, or
count it back).

---

## npm scripts

| Command | Description |
|---|---|
| `npm start` | Run the daemon in the foreground. |
| `npm run setup` | Open Chrome to log into Postmates. |
| `npm run reddit` | Run a one-off source scan. |
| `npm run apply` | Run a one-off apply pass. |
| `npm run install-service` / `uninstall-service` | Install/remove the `launchd` agent. |
| `npm run restart` | Reload the background service. |
| `npm test` | Run the unit test suite (`node --test`). |
| `npm run migrate` | Migrate state from the old system, if present. |

---

## Background service

Installed as a `launchd` user agent **`com.postmates.promo`** with `RunAtLoad`
and `KeepAlive`, so it starts at login and restarts if it crashes. It does **not**
run while the Mac is asleep/off — the dashboard's staleness warning flags that.

Logs: `data/daemon-error.log` (trimmed to the last 1000 lines on startup) and the
structured event log `data/run_log.jsonl`.

---

## Data & state (`data/`)

All state lives in `data/` (gitignored). Full-file writes are **atomic**
(temp-file + rename) to survive crashes/sleep without corruption.

| File | Purpose |
|---|---|
| `queue.txt` | Codes waiting to be applied. |
| `processed.txt` | Results: `CODE⇥result⇥detail⇥timestamp`. |
| `code_catalog.json` | Per-code metadata (source, region, comment link, confidence) + source health. |
| `tried_codes.json` / `ue_tried_codes.json` | Codes already seen per subreddit (so they aren't re-queued). |
| `applied_codes.json` | Codes that landed on the account (success/region-locked) with when — codes applied in the last 14 days aren't re-queued. |
| `thread_config.txt` / `ue_thread_config.txt` | The current monthly thread IDs. |
| `settings.json` | Intervals + home region. |
| `heartbeat.json` | Last successful scan/apply (for the staleness watchdog). |
| `health.json` | Active detection-health warning, if any. |
| `browser-profile/` | The logged-in Chrome profile (**contains your session — keep private**). |
| `archive/` | Monthly archived queue/results when a new thread is detected. |

> **Backup tip:** backing up `data/browser-profile/` saves you from having to log
> in again after a disk loss; the rest of `data/` preserves your history.

---

## Development

```sh
npm test          # unit tests (extractor, region, savings, settings, state)
node --check src/*.js
```

Key modules:

| Module | Responsibility |
|---|---|
| `src/index.js` | Daemon entry: cron scheduling, run orchestration, scan status. |
| `src/server.js` | Express dashboard + SSE + REST API. |
| `src/reddit.js` | Thread detection + comment scraping (via `curl` + cheerio). |
| `src/extractor.js` | Promo-code extraction + per-code comment context. |
| `src/region.js` | Home/region detection and savings eligibility. |
| `src/postmates.js` | Playwright Chrome automation (apply + result detection). |
| `src/state.js` | All state I/O (atomic), stats, savings math. |
| `src/settings.js` | Settings, cron conversion, setup status. |
| `src/atomic.js` | Atomic file-write helper. |

---

## Troubleshooting

- **"Not logged in"** — Settings → *Log in to Postmates*, log in, close Chrome.
- **Results look wrong / nothing applies** — Settings → *System Health* → *Run
  Test*. It applies a fake code and expects a rejection; failure means the
  Postmates UI likely changed. This same self-test also runs **automatically
  every day at 4:45 AM PT** and raises the dashboard health banner on failure,
  so UI breakage is caught within a day. The daily job also **probes the
  UberEats session** (navigation only — nothing is applied), so an expired
  UberEats login is flagged within a day instead of being discovered mid-apply.
- **Login shows "Unverified"** — sessions are verified by a real navigation
  **right after each login**, by the daily 4:45 AM check, and by apply runs;
  the state resolves on its own within moments of logging in.
- **"Scans stalled" banner** — the daemon isn't running or the Mac was asleep.
  `npm run restart`.
- **Dashboard looks unstyled/old** — hard refresh (Cmd+Shift+R). Assets are
  served `no-store`, so one refresh clears any stale copy.
