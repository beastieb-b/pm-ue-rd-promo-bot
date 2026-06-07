const { execFile } = require('child_process');
const cheerio = require('cheerio');
const state = require('./state');
const { extractCodes } = require('./extractor');

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
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, stdout.lastIndexOf('\n__STATUS__:')) : stdout;
      resolve({ status, body });
    });
  });
}

// ── Thread detection via RSS ────────────────────────────────────────────────

async function detectCurrentThread() {
  // t=year (not t=month) so we never miss a thread at month boundaries
  const url = 'https://www.reddit.com/r/postmates/search.rss?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year';
  const { status, body } = await fetchUrl(url);

  if (status !== 200) throw new Error(`RSS returned ${status}`);

  // Extract thread entries from Atom feed
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const entry = m[1];
    const idMatch = entry.match(/<id>t3_([a-z0-9]+)<\/id>/);
    const titleMatch = entry.match(/<title>(.*?)<\/title>/);
    const updatedMatch = entry.match(/<updated>(.*?)<\/updated>/);
    if (idMatch && titleMatch) {
      const title = titleMatch[1].toLowerCase();
      if (title.includes('monthly') && title.includes('promo')) {
        entries.push({
          id: idMatch[1],
          title: titleMatch[1],
          updated: updatedMatch ? new Date(updatedMatch[1]).getTime() : 0,
        });
      }
    }
  }

  if (!entries.length) throw new Error('No matching thread found in RSS');

  // Sort by newest first, return top 2 (fallback if newest is empty)
  entries.sort((a, b) => b.updated - a.updated);
  return entries.slice(0, 2);
}

// ── Uber Eats thread detection ────────────────────────────────────────────────

async function detectUberEatsThread() {
  // t=year (not t=month) so we never miss a thread at month boundaries
  const url = 'https://www.reddit.com/r/UberEATS/search.rss?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) throw new Error(`UberEATS RSS returned ${status}`);

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const entry = m[1];
    const idMatch = entry.match(/<id>t3_([a-z0-9]+)<\/id>/);
    const titleMatch = entry.match(/<title>(.*?)<\/title>/);
    const updatedMatch = entry.match(/<updated>(.*?)<\/updated>/);
    if (idMatch && titleMatch) {
      const title = titleMatch[1].toLowerCase();
      if (title.includes('monthly') && (title.includes('promo') || title.includes('code'))) {
        entries.push({
          id: idMatch[1],
          title: titleMatch[1],
          updated: updatedMatch ? new Date(updatedMatch[1]).getTime() : 0,
        });
      }
    }
  }

  if (!entries.length) throw new Error('No UberEATS thread found in RSS');
  entries.sort((a, b) => b.updated - a.updated);
  return entries.slice(0, 2);
}

// ── Comment scraping via old.reddit.com HTML ────────────────────────────────

async function fetchComments(threadId, subreddit = 'postmates', maxPages = 5) {
  const allComments = [];
  let url = `https://old.reddit.com/r/${subreddit}/comments/${threadId}/monthly_existing_user_promo_code_thread/?limit=500`;

  for (let page = 0; page < maxPages; page++) {
    const { status, body } = await fetchUrl(url);
    if (status !== 200) break;

    const $ = cheerio.load(body);

    // Only include text inside a known post/comment container (data-type attr)
    // and not authored by AutoModerator or a mod-distinguished user
    $('.usertext-body .md').each((_, el) => {
      const thing = $(el).closest('[data-type]');
      if (!thing.length) return; // outside comment tree (sidebar etc.) — skip
      const author = (thing.attr('data-author') || '').toLowerCase();
      if (author === 'automoderator') return;
      const thingClass = thing.attr('class') || '';
      if (thingClass.includes('moderator') || thingClass.includes('distinguished')) return;
      const text = $(el).text().trim();
      if (text && text.length > 3) allComments.push(text);
    });

    // Check for pagination — old reddit "next" button
    const nextLink = $('span.next-button a').attr('href');
    if (!nextLink) break;
    url = nextLink;
  }

  return allComments;
}

// ── Scan a single subreddit thread ───────────────────────────────────────────

async function scanSubreddit({ detectFn, getThreadId, getThreadMonth, saveThreadId, getTriedState, saveTriedState, monthlyReset, subreddit, label, onProgress }) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  onProgress?.({ source: label, step: 'detecting' });

  let entries;
  try {
    entries = await detectFn();
  } catch (err) {
    onProgress?.({ source: label, step: 'error', message: err.message });
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

  const allCodes = extractCodes(comments);
  const triedState = getTriedState();
  const triedSet = new Set(triedState.tried_codes);
  const newCodes = [...allCodes].filter(c => !triedSet.has(c)).sort();

  triedState.thread_id = newestEntry.id;
  triedState.tried_codes = [...new Set([...triedSet, ...newCodes])];
  saveTriedState(triedState);

  const added = state.addToQueue(newCodes);

  state.appendLog({ type: 'reddit_check_done', source: label, thread_id: newestEntry.id, comments_scanned: comments.length, codes_found: allCodes.size, new_codes: newCodes.length, queued: added });
  onProgress?.({ source: label, step: 'done', threadId: newestEntry.id, commentsScanned: comments.length, newCodes: newCodes.length, queued: added });

  return { threadId: newestEntry.id, commentsScanned: comments.length, codesFound: allCodes.size, newCodes: newCodes.length, queued: added };
}

// ── Main monitor function — scans both subreddits ────────────────────────────

async function runRedditCheck({ onProgress } = {}) {
  state.appendLog({ type: 'reddit_check_start' });

  // Postmates reset archives the shared queue/processed files. Run it before
  // UberEATS so a Postmates monthly rollover cannot erase freshly queued UE codes.
  const pm = await scanSubreddit({
    detectFn: detectCurrentThread,
    getThreadId: state.getThreadId,
    getThreadMonth: state.getThreadMonth,
    saveThreadId: state.saveThreadId,
    getTriedState: state.getTriedState,
    saveTriedState: state.saveTriedState,
    monthlyReset: state.monthlyReset,
    subreddit: 'postmates',
    label: 'Postmates',
    onProgress,
  });

  const ue = await scanSubreddit({
    detectFn: detectUberEatsThread,
    getThreadId: state.getUEThreadId,
    getThreadMonth: state.getUEThreadMonth,
    saveThreadId: state.saveUEThreadId,
    getTriedState: state.getUETriedState,
    saveTriedState: state.saveUETriedState,
    monthlyReset: state.ueMonthlyReset,
    subreddit: 'UberEATS',
    label: 'UberEATS',
    onProgress,
  });

  const totalNew = (pm.newCodes || 0) + (ue.newCodes || 0);
  const totalQueued = (pm.queued || 0) + (ue.queued || 0);
  const errors = [pm.error, ue.error].filter(Boolean);

  return {
    threadId: pm.threadId,
    ueThreadId: ue.threadId,
    commentsScanned: (pm.commentsScanned || 0) + (ue.commentsScanned || 0),
    newCodes: totalNew,
    queued: totalQueued,
    postmates: pm,
    ubereats: ue,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

module.exports = { runRedditCheck, detectCurrentThread, detectUberEatsThread, fetchComments };
