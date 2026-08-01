const { execFile } = require('child_process');
const state = require('./state');
const { extractCodes, extractCodesWithContext } = require('./extractor');
const { detectRegionRestriction } = require('./region');

const SOURCE_LABELS = {
  reddit_postmates: 'Reddit · Postmates',
  reddit_ubereats: 'Reddit · UberEATS',
};

function getCheerio() {
  try {
    return require('cheerio');
  } catch (err) {
    throw new Error(`cheerio is required for HTML parsing: ${err.message}`);
  }
}

// Use curl instead of Node.js https — Reddit TLS-fingerprints the Node.js stack
// and returns 403 even with matching headers. curl uses the system TLS and works.
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '--max-time', '25', '-L',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.5',
      '-w', '\n__STATUS__:%{http_code}',
      url,
    ];

    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(`curl failed: ${err.message}`));
      const statusMatch = stdout.match(/\n__STATUS__:(\d+)$/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const body = statusMatch ? stdout.slice(0, stdout.lastIndexOf('\n__STATUS__:')) : stdout;
      resolve({ status, body });
    });
  });
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function describeConfidence(score) {
  if (score >= 85) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

function scoreCandidate({ sourceKey, worked = 0, dead = 0, existingUser = true, targeted = false, hasExpiry = false, singleUse = false }) {
  let score = sourceKey.startsWith('reddit_') ? 78 : 60;
  if (existingUser) score += 10;
  if (worked > 0) score += Math.min(worked * 6, 18);
  if (dead > 0) score -= Math.min(dead * 10, 25);
  if (targeted) score -= 8;
  if (hasExpiry) score += 4;
  if (singleUse) score -= 20;
  return Math.max(5, Math.min(98, score));
}

function buildCodeEntry(code, meta) {
  const confidenceScore = scoreCandidate(meta);
  return {
    code,
    sourceKey: meta.sourceKey,
    sourceLabel: SOURCE_LABELS[meta.sourceKey] || meta.sourceKey,
    sourceUrl: meta.sourceUrl || null,
    commentUrl: meta.commentUrl || null,
    sourceTitle: meta.sourceTitle || null,
    confidenceScore,
    confidenceLabel: describeConfidence(confidenceScore),
    statusHint: meta.statusHint || 'Observed',
    statusNote: meta.statusNote || null,
    expiresAt: meta.expiresAt || null,
    region: meta.region || null,
    regionRestricted: meta.regionRestricted || false,
    regionNote: meta.regionNote || null,
    lastSeenAt: meta.lastSeenAt || new Date().toISOString(),
  };
}

function setSourceStatus(sourceKey, updates) {
  state.setSourceStatus(sourceKey, {
    label: SOURCE_LABELS[sourceKey] || sourceKey,
    ...updates,
    lastCheckedAt: new Date().toISOString(),
  });
}

// ── Thread detection ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A monthly promo thread's slug looks like
// "monthly_existing_user_promo_code_thread_july_2026". When we parse a listing
// page (no search query to constrain results) we require the stronger match so
// we don't pick up unrelated "monthly …" threads; on the search page the query
// already constrains results, so a plain "monthly" match is enough there.
function isMonthlyPromoSlug(slug) {
  return slug.includes('monthly') && (slug.includes('promo') || slug.includes('existing'));
}

// Pull monthly-thread links out of an old.reddit HTML page, in document order
// (the caller arranges the source so that order is newest-first).
function parseThreadEntries(body, subreddit, strict) {
  const hrefRe = new RegExp(`href="(?:https?:\\/\\/[^"]*)?\\/r\\/${subreddit}\\/comments\\/([a-z0-9]+)\\/([^"?#]+)`, 'g');
  const seen = new Set();
  const entries = [];
  let m;
  while ((m = hrefRe.exec(body)) !== null) {
    const [, id, slug] = m;
    const matches = strict ? isMonthlyPromoSlug(slug) : slug.includes('monthly');
    if (seen.has(id) || !matches) continue;
    seen.add(id);
    entries.push({ id, title: 'Monthly Existing User Promo Code Thread', published: Date.now() - entries.length * 1000 });
  }
  return entries;
}

// Fallback when search comes up empty: read the subreddit listing directly. The
// monthly thread is stickied on the front page and shows up in /new/ the moment
// it's posted — neither depends on Reddit's search index, which can lag a
// freshly-posted thread by minutes to hours (most likely right at month rollover).
async function detectFromListing(subreddit) {
  const urls = [
    `https://old.reddit.com/r/${subreddit}/`,      // stickied monthly thread sits at the top
    `https://old.reddit.com/r/${subreddit}/new/`,  // newest posts, caught before search indexes
  ];
  const seen = new Set();
  const entries = [];
  for (const url of urls) {
    let status, body;
    try { ({ status, body } = await fetchUrl(url)); } catch { continue; }
    if (status !== 200) continue;
    for (const e of parseThreadEntries(body, subreddit, true)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
    if (entries.length) break; // the front page already has the stickied thread
  }
  return entries;
}

// Find the current + previous monthly promo thread for a subreddit via the
// old.reddit.com HTML search (the reddit.com search.rss endpoint 429s for busy
// subs). old.reddit occasionally returns a 200 page that's rate-limited/empty
// with no results — a transient blip — so we retry a few times, then fall back
// to the subreddit listing before giving up.
async function detectThread(subreddit) {
  const url = `https://old.reddit.com/r/${subreddit}/search?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year`;
  let lastErr = `no thread found for r/${subreddit}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const { status, body } = await fetchUrl(url);
    if (status !== 200) { lastErr = `r/${subreddit} thread search returned ${status}`; continue; }

    // Results are sorted newest-first by ?sort=new, so preserve that order.
    const entries = parseThreadEntries(body, subreddit, false);
    if (entries.length) return entries.slice(0, 2);
    lastErr = `No r/${subreddit} thread in search results (rate-limited/empty page)`;
  }

  // Search empty/failing — try the listing (doesn't rely on the search index).
  const listing = await detectFromListing(subreddit);
  if (listing.length) return listing.slice(0, 2);

  // Both curl paths blind (Reddit's logged-out gate now covers search and
  // listing pages too, serving 200-status shells with no links) — read the
  // subreddit front page through our own Chrome, where the monthly thread is
  // stickied at the top. Sort by post id (base36, increases over time) so
  // entries[0] is the newest monthly thread regardless of page order.
  try {
    const posts = await require('./postmates').fetchSubredditPosts(subreddit);
    const linkRe = new RegExp(`^/r/${subreddit}/comments/([a-z0-9]+)/([^/]+)`, 'i');
    const seen = new Set();
    const entries = [];
    for (const p of posts) {
      const m = (p.permalink || '').match(linkRe);
      if (!m) continue;
      const [, id, slug] = m;
      if (seen.has(id) || !isMonthlyPromoSlug(slug)) continue;
      seen.add(id);
      entries.push({ id, title: p.title || 'Monthly Existing User Promo Code Thread', published: 0 });
    }
    entries.sort((a, b) => parseInt(b.id, 36) - parseInt(a.id, 36));
    entries.forEach((e, i) => { e.published = Date.now() - i * 1000; });
    if (entries.length) {
      state.appendLog({ type: 'thread_detect_browser', subreddit, found: entries.length, newest: entries[0].id });
      return entries.slice(0, 2);
    }
  } catch (err) {
    state.appendLog({ type: 'thread_detect_browser', subreddit, error: err.message.slice(0, 100) });
  }

  throw new Error(lastErr);
}

async function detectCurrentThread() { return detectThread('postmates'); }
async function detectUberEatsThread() { return detectThread('UberEATS'); }

async function fetchComments(threadId, subreddit = 'postmates', maxPages = 5) {
  const allComments = [];
  let url = `https://old.reddit.com/r/${subreddit}/comments/${threadId}/monthly_existing_user_promo_code_thread/?limit=500`;
  const cheerio = getCheerio();

  for (let page = 0; page < maxPages; page++) {
    const { status, body } = await fetchUrl(url);
    if (status !== 200) break;

    const $ = cheerio.load(body);
    $('.usertext-body .md').each((_, el) => {
      const thing = $(el).closest('[data-type]');
      if (!thing.length) return;
      const author = (thing.attr('data-author') || '').toLowerCase();
      if (author === 'automoderator') return;
      const thingClass = thing.attr('class') || '';
      if (thingClass.includes('moderator') || thingClass.includes('distinguished')) return;
      const text = $(el).text().trim();
      if (text && text.length > 3) {
        const permalink = thing.attr('data-permalink');
        allComments.push({ text, permalink: permalink ? `https://www.reddit.com${permalink}` : null });
      }
    });

    const nextLink = $('span.next-button a').attr('href');
    if (!nextLink) break;
    url = nextLink;
  }

  return allComments;
}

async function scanSubreddit({ sourceKey, detectFn, getThreadId, saveThreadId, getTriedState, saveTriedState, monthlyReset, subreddit, label, onProgress }) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  onProgress?.({ source: label, step: 'detecting' });
  setSourceStatus(sourceKey, { status: 'checking', note: 'Looking for the latest monthly thread' });

  const storedThreadId = getThreadId();
  let entries;
  try {
    entries = await detectFn();
  } catch (err) {
    // Detection can blip transiently (old.reddit returns a rate-limited/empty
    // search page). If we already know this month's thread, fall back to it so
    // one blip doesn't break the scan or flip the source to a 30-min "error" —
    // the next successful detection still catches a genuine new monthly thread.
    if (storedThreadId) {
      state.appendLog({ type: 'reddit_check_fallback', source: label, reason: err.message, used_thread: storedThreadId });
      entries = [{ id: storedThreadId, title: 'Monthly Existing User Promo Code Thread', published: Date.now() }];
    } else {
      onProgress?.({ source: label, step: 'error', message: err.message });
      setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0 });
      return { error: `${label} thread detection failed: ${err.message}` };
    }
  }

  const newestEntry = entries[0];

  if (newestEntry.id !== storedThreadId) {
    state.appendLog({ type: 'new_thread_detected', source: label, old_thread: storedThreadId, new_thread: newestEntry.id, month: currentMonth });
    monthlyReset(storedThreadId, newestEntry.id, currentMonth);
    onProgress?.({ source: label, step: 'new_thread', threadId: newestEntry.id });
  }

  onProgress?.({ source: label, step: 'fetching', threadId: newestEntry.id });

  let comments = [];
  try {
    comments = await fetchComments(newestEntry.id, subreddit);
  } catch (err) {
    onProgress?.({ source: label, step: 'error', message: err.message });
    setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0, sourceUrl: `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/` });
    return { error: `${label} comment fetch failed: ${err.message}` };
  }

  // Reddit gates thread pages for plain HTTP clients (login redirect) while
  // serving search pages normally — so curl reads an empty shell and the scan
  // would "succeed" with 0 comments. Read the thread through our own Chrome
  // instead (a rendered logged-out browser still gets the page).
  if (comments.length === 0) {
    try {
      const viaBrowser = await require('./postmates').fetchRedditComments(newestEntry.id, subreddit);
      if (viaBrowser && viaBrowser.length) {
        state.appendLog({ type: 'reddit_fetch_browser', source: label, comments: viaBrowser.length });
        comments = viaBrowser;
      }
    } catch (err) {
      state.appendLog({ type: 'reddit_fetch_browser', source: label, error: err.message.slice(0, 120) });
    }
  }

  // NOTE: we intentionally do NOT fall back to the previous month's thread when
  // the newest thread is empty. Monthly codes expire when the month flips, so
  // backfilling last month's thread at rollover just re-queues a pile of expired
  // codes into the new month (they all come back "Code expired" and waste apply
  // attempts). A freshly-posted, still-empty thread simply yields no codes yet —
  // we wait for real ones to be posted rather than reintroducing stale ones.

  const codeContext = extractCodesWithContext(comments);
  const allCodes = new Set(codeContext.keys());

  // Backfill the comment deep-link onto every code seen in the thread — even
  // already-tried ones — so existing results gain a link, not just new codes.
  for (const [code, ctx] of codeContext) {
    if (ctx.commentUrl) state.mergeCodeMeta(code, { commentUrl: ctx.commentUrl });
  }
  const triedState = getTriedState();
  const triedSet = new Set(triedState.tried_codes);

  // Silent-failure watchdog: a thread that has already produced codes suddenly
  // reading ZERO comments is Reddit blocking us, not an empty thread — say so
  // loudly (source error + banner) instead of reporting a healthy no-op scan.
  // (This exact mode went unnoticed for 9 days in July 2026.)
  if (comments.length === 0 && triedSet.size > 0) {
    const note = 'Thread returned no comments — Reddit is likely gating the fetch (both curl and browser paths failed)';
    setSourceStatus(sourceKey, { status: 'error', note, usableCodes: 0, sourceUrl: `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/` });
    state.appendLog({ type: 'reddit_empty_thread_anomaly', source: label, thread_id: newestEntry.id });
    const existing = state.getHealthWarning();
    if (!existing || existing.source === 'reddit_blocked') {
      state.setHealthWarning(`r/${subreddit} comments are unreadable (Reddit is blocking both fetch paths) — new codes are being missed.`, 'reddit_blocked');
    }
    onProgress?.({ source: label, step: 'error', message: note });
    return { threadId: newestEntry.id, commentsScanned: 0, codesFound: 0, newCodes: 0, queued: 0 };
  }
  // Comments flowing again — retire our own blocked banner if it's up.
  if (comments.length > 0) {
    const existing = state.getHealthWarning();
    if (existing && existing.source === 'reddit_blocked') state.clearHealthWarning();
  }

  const candidates = [...allCodes].filter(c => !triedSet.has(c)).sort();

  // Skip codes already sitting on the account (applied within the last
  // ~2 weeks — success or region_skip). After the monthly reset wipes
  // tried_codes, last cycle's wins would otherwise be re-queued and burn an
  // apply slot on "Oops, you already applied this promotion". They are NOT
  // added to tried_codes, so once the window passes they become eligible again.
  const recentlyApplied = state.getRecentlyApplied();
  const newCodes = candidates.filter(c => !recentlyApplied.has(c));
  const skippedApplied = candidates.filter(c => recentlyApplied.has(c));
  const alreadyNoted = new Set(triedState.skipped_applied || []);
  const newlySkipped = skippedApplied.filter(c => !alreadyNoted.has(c));
  if (newlySkipped.length) {
    state.appendLog({
      type: 'applied_skip', source: label, codes: newlySkipped,
      note: `already on the account (applied < ${state.REAPPLY_SKIP_DAYS}d ago)`,
    });
  }
  triedState.skipped_applied = [...new Set([...alreadyNoted, ...skippedApplied])];

  const sourceUrl = `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/`;
  const entriesToQueue = newCodes.map(code => {
    const ctx = codeContext.get(code) || {};
    // Read the comment(s) this code appeared in for a region restriction.
    const region = detectRegionRestriction(ctx.context);
    return buildCodeEntry(code, {
      sourceKey,
      sourceUrl,
      // Deep link to the exact comment this code came from (falls back to the
      // thread URL in the UI when not available, e.g. older entries).
      commentUrl: ctx.commentUrl || null,
      sourceTitle: newestEntry.title,
      statusHint: 'Monthly thread',
      statusNote: `${comments.length} comments scanned in the latest monthly thread`,
      lastSeenAt: new Date().toISOString(),
      worked: 1,
      existingUser: true,
      hasExpiry: false,
      region: region ? region.region : null,
      regionRestricted: region ? region.restricted : false,
      regionNote: region ? region.note : null,
    });
  });

  triedState.thread_id = newestEntry.id;
  triedState.tried_codes = [...new Set([...triedSet, ...newCodes])];
  saveTriedState(triedState);

  const added = state.addToQueue(entriesToQueue);
  setSourceStatus(sourceKey, {
    status: 'ok',
    note: `${comments.length} comments scanned`,
    usableCodes: newCodes.length,
    queued: added,
    sourceUrl,
  });

  state.appendLog({ type: 'reddit_check_done', source: label, thread_id: newestEntry.id, comments_scanned: comments.length, codes_found: allCodes.size, new_codes: newCodes.length, queued: added });
  onProgress?.({ source: label, step: 'done', threadId: newestEntry.id, commentsScanned: comments.length, newCodes: newCodes.length, queued: added });

  return { threadId: newestEntry.id, commentsScanned: comments.length, codesFound: allCodes.size, newCodes: newCodes.length, queued: added };
}

// Monthly threads are usually posted on the 1st, but a 1–2 day delay is normal,
// so we don't warn until a few days in (state.STALE_THREAD_GRACE_DAYS). Past
// that, if we're still pointed at a previous month's thread, the new thread
// likely wasn't detected (e.g. the mods changed the title format) — surface that
// as a dashboard banner instead of silently scanning last month's thread forever.
function checkThreadStaleness() {
  // Use UTC for BOTH the day and the month so they share one clock. The stored
  // thread month is written in UTC (toISOString), so mixing a local getDate()
  // with a UTC month created a ~7h window at each UTC month rollover where the
  // month already read "new" while the local day was still last month's high
  // number — which set a false "not detected" banner (before the new thread
  // could exist) and, worse, an early `return` on getDate() < grace then skipped
  // the clear branch so the false banner got stuck for days.
  const now = new Date();
  const day = now.getUTCDate();
  const currentMonth = now.toISOString().slice(0, 7);

  const stale = [];
  // A 1–2 day late post is normal, so only treat "still on last month" as a
  // problem once we're past the grace window.
  if (day >= state.STALE_THREAD_GRACE_DAYS) {
    const pmMonth = state.getThreadMonth();
    const ueMonth = state.getUEThreadMonth();
    if (pmMonth && pmMonth < currentMonth) stale.push('r/postmates');
    if (ueMonth && ueMonth < currentMonth) stale.push('r/UberEATS');
  }

  const existing = state.getHealthWarning();
  if (stale.length) {
    state.setHealthWarning(
      `Still on last month's ${stale.join(' & ')} thread — the ${currentMonth} monthly thread hasn't been detected. ` +
      `If it's been posted, the title format may have changed; check the subreddit.`,
      'thread_stale'
    );
  } else if (existing && existing.source === 'thread_stale') {
    // Not stale (or still within grace) — always retire a leftover stale banner.
    state.clearHealthWarning();
  }
}

async function runRedditCheck({ onProgress } = {}) {
  state.appendLog({ type: 'reddit_check_start' });

  const pm = await scanSubreddit({
    sourceKey: 'reddit_postmates',
    detectFn: detectCurrentThread,
    getThreadId: state.getThreadId,
    saveThreadId: state.saveThreadId,
    getTriedState: state.getTriedState,
    saveTriedState: state.saveTriedState,
    monthlyReset: state.monthlyReset,
    subreddit: 'postmates',
    label: 'Postmates',
    onProgress,
  });

  const ue = await scanSubreddit({
    sourceKey: 'reddit_ubereats',
    detectFn: detectUberEatsThread,
    getThreadId: state.getUEThreadId,
    saveThreadId: state.saveUEThreadId,
    getTriedState: state.getUETriedState,
    saveTriedState: state.saveUETriedState,
    monthlyReset: state.ueMonthlyReset,
    subreddit: 'UberEATS',
    label: 'UberEATS',
    onProgress,
  });

  checkThreadStaleness();

  const scans = [pm, ue];
  const totalNew = scans.reduce((sum, entry) => sum + (entry.newCodes || 0), 0);
  const totalQueued = scans.reduce((sum, entry) => sum + (entry.queued || 0), 0);
  const coreErrors = [pm.error, ue.error].filter(Boolean);

  return {
    threadId: pm.threadId,
    ueThreadId: ue.threadId,
    commentsScanned: (pm.commentsScanned || 0) + (ue.commentsScanned || 0),
    newCodes: totalNew,
    queued: totalQueued,
    postmates: pm,
    ubereats: ue,
    error: coreErrors.length > 0 ? coreErrors.join('; ') : null,
  };
}

module.exports = {
  runRedditCheck,
  detectCurrentThread,
  detectUberEatsThread,
  detectFromListing,
  checkThreadStaleness,
  isMonthlyPromoSlug,
  fetchComments,
};
