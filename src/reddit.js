const { execFile } = require('child_process');
const state = require('./state');
const { extractCodes, extractCodesWithContext } = require('./extractor');
const { detectRegionRestriction } = require('./region');

const SOURCE_LABELS = {
  reddit_postmates: 'Reddit · Postmates',
  reddit_ubereats: 'Reddit · UberEATS',
  slickdeals_postmates: 'Slickdeals · Postmates',
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

function parseCommentSignals(text) {
  const normalized = normalizeText(text).toLowerCase();
  return {
    worked: /\b(worked|working|verified|success)\b/.test(normalized),
    dead: /\b(dead|expired|doesn['’]?t work|not working|invalid)\b/.test(normalized),
  };
}

// ── Thread detection via RSS ────────────────────────────────────────────────

async function detectCurrentThread() {
  // Use old.reddit.com HTML search — the reddit.com search.rss endpoint can
  // 429 for active subreddits, and old.reddit.com consistently returns 200.
  const url = 'https://old.reddit.com/r/postmates/search?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) throw new Error(`Postmates thread search returned ${status}`);

  const seen = new Set();
  const entries = [];
  const hrefRe = /href="(?:https?:\/\/[^"]*)?\/r\/postmates\/comments\/([a-z0-9]+)\/([^"?#]+)/g;
  let m;
  while ((m = hrefRe.exec(body)) !== null) {
    const [, id, slug] = m;
    if (seen.has(id)) continue;
    if (!slug.includes('monthly')) continue;
    seen.add(id);
    entries.push({ id, title: 'Monthly Existing User Promo Code Thread', published: Date.now() - entries.length * 1000 });
  }

  if (!entries.length) throw new Error('No matching thread found in search results');
  return entries.slice(0, 2);
}

async function detectUberEatsThread() {
  // RSS search returns 429 for r/UberEATS (large subreddit, rate-limited).
  // old.reddit.com HTML search returns 200 reliably with the same results.
  const url = 'https://old.reddit.com/r/UberEATS/search?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) throw new Error(`UberEATS thread search returned ${status}`);

  // Extract thread IDs from hrefs like /r/UberEATS/comments/{id}/monthly_..._thread/
  // Results are sorted newest-first by ?sort=new, so preserve that order.
  const seen = new Set();
  const entries = [];
  const hrefRe = /href="(?:https?:\/\/[^"]*)?\/r\/UberEATS\/comments\/([a-z0-9]+)\/([^"?#]+)/g;
  let m;
  while ((m = hrefRe.exec(body)) !== null) {
    const [, id, slug] = m;
    if (seen.has(id)) continue;
    if (!slug.includes('monthly')) continue;
    seen.add(id);
    // Assign synthetic published times that preserve newest-first order
    entries.push({ id, title: 'Monthly Existing User Promo Code Thread', published: Date.now() - entries.length * 1000 });
  }

  if (!entries.length) throw new Error('No UberEATS thread found in search results');
  return entries.slice(0, 2);
}

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

  let entries;
  try {
    entries = await detectFn();
  } catch (err) {
    onProgress?.({ source: label, step: 'error', message: err.message });
    setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0 });
    return { error: `${label} thread detection failed: ${err.message}` };
  }

  const newestEntry = entries[0];
  const storedThreadId = getThreadId();

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

  const prevEntry = entries[1];
  if (comments.length === 0 && prevEntry && prevEntry.id !== newestEntry.id) {
    onProgress?.({ source: label, step: 'fallback', threadId: prevEntry.id });
    try {
      const prevComments = await fetchComments(prevEntry.id, subreddit);
      if (prevComments.length > 0) {
        state.appendLog({ type: 'reddit_check_fallback', source: label, new_thread: newestEntry.id, prev_thread: prevEntry.id, comments: prevComments.length });
        comments = prevComments;
      }
    } catch {}
  }

  const codeContext = extractCodesWithContext(comments);
  const allCodes = new Set(codeContext.keys());

  // Backfill the comment deep-link onto every code seen in the thread — even
  // already-tried ones — so existing results gain a link, not just new codes.
  for (const [code, ctx] of codeContext) {
    if (ctx.commentUrl) state.mergeCodeMeta(code, { commentUrl: ctx.commentUrl });
  }
  const triedState = getTriedState();
  const triedSet = new Set(triedState.tried_codes);
  const newCodes = [...allCodes].filter(c => !triedSet.has(c)).sort();
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

function parseExpiry(text) {
  const match = text.match(/Expires?\s+(\d{2})-(\d{2})-(\d{4})/i);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function parseSlickdealsThread(body, url) {
  const cheerio = getCheerio();
  const $ = cheerio.load(body);

  // Skip expired deals — Slickdeals marks them with a visible alert bar + badge
  if ($('.expiredDealAlertBar, [class*="dealCardBadge--expired"]').length) return null;

  // Extract code from the meta description attribute — avoids text-node concatenation
  // bugs (e.g. "BEACHRUNCommunity") that happen when using $('body').text()
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const codeMatch = metaDesc.match(/Use promo code:\s*([A-Z0-9_-]{4,32})\b/i)
    || metaDesc.match(/promo code[:\s]+([A-Z0-9_-]{4,32})\b/i);
  const code = state.normalizeCode(codeMatch?.[1] || '');

  const pageText = normalizeText($('body').text());
  const title = normalizeText($('h1').first().text()) || normalizeText($('title').text());
  const existingUser = !/\b(new customer|new users?|first order|initial purchase)\b/i.test(pageText);
  const regionMatch = pageText.match(/\b(Los Angeles|California|NYC|New York|Chicago|Seattle|Dallas|Houston|Miami)\b/i);
  const region = regionMatch ? regionMatch[1] : null;
  const expiresAt = parseExpiry(pageText);

  // Collect Slickdeals user comments for worked/dead signals
  const comments = [];
  $('[class*="comment"], [class*="Comment"]').each((_, el) => {
    const text = normalizeText($(el).text());
    if (text.length > 10) comments.push(text);
  });

  let worked = 0;
  let dead = 0;
  for (const comment of comments.slice(0, 50)) {
    const signal = parseCommentSignals(comment);
    if (signal.worked) worked += 1;
    if (signal.dead) dead += 1;
  }

  if (!code || !existingUser) return null;
  const statusHint = dead > worked ? 'Possibly dead' : worked > 0 ? 'Community verified' : 'Public code';
  const statusNote = dead > worked
    ? `${dead} negative comments detected`
    : worked > 0
      ? `${worked} positive community signal${worked === 1 ? '' : 's'}`
      : 'No strong comment signal yet';

  return buildCodeEntry(code, {
    sourceKey: 'slickdeals_postmates',
    sourceUrl: url,
    sourceTitle: title,
    statusHint,
    statusNote,
    expiresAt,
    region,
    lastSeenAt: new Date().toISOString(),
    worked,
    dead,
    existingUser,
    targeted: Boolean(region),
    hasExpiry: Boolean(expiresAt),
  });
}

async function scanSlickdeals(onProgress) {
  const sourceKey = 'slickdeals_postmates';
  const label = SOURCE_LABELS[sourceKey];
  // Search for active (non-expired) deal threads that mention Postmates promo codes.
  // The /promo-codes/postmates/ page only has generic %-off cards with no code strings.
  const searchUrl = 'https://slickdeals.net/newsearch.php?q=postmates+promo+code&searcharea=deals&searchin=first_word&sort=newest&hideExpired=1';
  onProgress?.({ source: label, step: 'fetching' });
  setSourceStatus(sourceKey, { status: 'checking', note: 'Searching for active Postmates deals', sourceUrl: searchUrl });

  try {
    const { status, body } = await fetchUrl(searchUrl);
    if (status !== 200) throw new Error(`Slickdeals returned ${status}`);
    const cheerio = getCheerio();
    const $ = cheerio.load(body);
    const links = new Map();
    $('a[href*="/f/"]').each((_, el) => {
      const href = $(el).attr('href');
      const text = normalizeText($(el).text());
      if (!href || !text) return;
      const absolute = href.startsWith('http') ? href : `https://slickdeals.net${href}`;
      // Deduplicate by path (strip query params)
      const key = absolute.split('?')[0];
      if (!links.has(key) && text.length > 10) links.set(key, text);
    });

    const candidates = [];
    for (const [url, text] of [...links.entries()].slice(0, 4)) {
      const thread = await fetchUrl(url);
      if (thread.status !== 200) continue;
      const entry = parseSlickdealsThread(thread.body, url);
      if (entry) candidates.push(entry);
      onProgress?.({ source: label, step: 'source_item', message: text });
    }

    const added = state.addToQueue(candidates);
    setSourceStatus(sourceKey, {
      status: 'ok',  // scan completed successfully regardless of whether codes were found
      note: candidates.length
        ? `Found ${candidates.length} code candidate${candidates.length === 1 ? '' : 's'}`
        : links.size > 0 ? `${links.size} deal${links.size === 1 ? '' : 's'} checked — all expired or new-user only` : 'No active Postmates deals posted yet',
      usableCodes: candidates.length,
      queued: added,
      sourceUrl: searchUrl,
    });
    onProgress?.({ source: label, step: 'done', commentsScanned: 0, newCodes: candidates.length, queued: added });
    return { codesFound: candidates.length, newCodes: candidates.length, queued: added };
  } catch (err) {
    setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0, sourceUrl: searchUrl });
    // Don't broadcast an error progress event — supplemental source blocks are expected.
    // The source status panel already reflects it.
    return { error: `${label} scan failed: ${err.message}` };
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

  const slickdeals = await scanSlickdeals(onProgress);

  const scans = [pm, ue, slickdeals];
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
    slickdeals,
    error: coreErrors.length > 0 ? coreErrors.join('; ') : null,
  };
}

module.exports = {
  runRedditCheck,
  detectCurrentThread,
  detectUberEatsThread,
  fetchComments,
  parseSlickdealsThread,
};
