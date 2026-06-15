/* ── State ─────────────────────────────────────────────────────────────── */

let stats = {};
let processed = [];
let allLogs = [];
let activeFilter = 'all';
let eventSource = null;
let liveLines = [];
let currentSettings = { scanIntervalHours: 2, applyIntervalHours: 4 };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function cssToken(value) {
  return String(value || '').replace(/[^a-z0-9_-]/gi, '');
}

/* ── Init ──────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  connectSSE();
  loadAll();
  setInterval(loadAll, 30000);
});

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(item.dataset.section);
    });
  });
}

function navigateTo(section) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-section="${section}"]`).classList.add('active');
  document.getElementById(`section-${section}`).classList.add('active');

  if (section === 'log') loadLog();
  if (section === 'queue') loadQueue();
  if (section === 'results') renderResults();
  if (section === 'settings') renderSettings();
}

/* ── Data Loading ──────────────────────────────────────────────────────── */

async function loadAll() {
  await Promise.all([loadStats(), loadProcessed()]);
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    stats = await res.json();
    if (stats.settings) currentSettings = stats.settings;
    renderOverview();
    renderScanStatus();
    renderSetupChecklist();
    renderHealthWarning();
    // Always refresh Settings thread rows if that section is visible
    if (document.getElementById('section-settings')?.classList.contains('active')) {
      renderSettings();
    }
  } catch {}
}

async function loadProcessed() {
  try {
    const res = await fetch('/api/processed');
    const data = await res.json();
    processed = data.processed || [];
    renderResults();
  } catch {}
}

async function loadQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    renderQueue(data.queue || []);
  } catch {}
}

async function loadLog() {
  try {
    const res = await fetch('/api/log?limit=200');
    allLogs = await res.json();
    renderLog();
  } catch {}
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function renderOverview() {
  setText('stat-success', stats.successCount ?? 0);
  setText('stat-queue', stats.queueCount ?? 0);
  setText('stat-tried', stats.totalTried ?? 0);
  setText('stat-rate', stats.totalTried ? `${stats.successRate}%` : '—');

  const badge = document.getElementById('queue-badge');
  if (badge) {
    badge.textContent = stats.queueCount || '';
    badge.style.display = stats.queueCount ? '' : 'none';
  }

  const tb = document.getElementById('thread-badge');
  if (stats.threadId) {
    tb.textContent = `Thread: ${stats.threadId} · ${formatMonth(stats.threadMonth)}`;
  } else {
    tb.textContent = 'No thread loaded — run a source scan';
  }

  const successEl = document.getElementById('success-list');
  const count = document.getElementById('success-count');
  if (stats.successCodes && stats.successCodes.length) {
    count.textContent = stats.successCodes.length;
    successEl.innerHTML = stats.successCodes
      .map(code => `<span class="success-chip">✅ ${escapeHtml(code)}</span>`)
      .join('');
  } else {
    count.textContent = '0';
    successEl.innerHTML = '<div class="empty-state">No successful codes yet this month</div>';
  }

  const feed = document.getElementById('activity-feed');
  const recent = [...processed].reverse().slice(0, 8);
  if (recent.length) {
    feed.innerHTML = recent.map(r => {
      const icon = r.result === 'success' ? '✅' : r.result === 'ratelimited' ? '⏳' : '❌';
      const detail = r.detail ? `<span style="color:var(--label-3)"> · ${escapeHtml(r.detail)}</span>` : '';
      const source = r.sourceLabel ? `<span class="inline-meta-pill">${escapeHtml(r.sourceLabel)}</span>` : '';
      const when = r.ts ? `<span style="color:var(--label-3);font-size:11px;margin-left:auto;white-space:nowrap">${timeAgo(new Date(r.ts))}</span>` : '';
      return `<div class="activity-item">
        <span class="activity-dot dot-${cssToken(r.result)}"></span>
        <span class="activity-text">${icon} <strong>${escapeHtml(r.code)}</strong> — ${escapeHtml(resultLabel(r.result))}${detail} ${source}</span>
        ${when}
      </div>`;
    }).join('');
  } else {
    feed.innerHTML = '<div class="empty-state">No activity yet</div>';
  }

  renderMonitoredSources(stats.monitoredSources || []);
}

function renderScanStatus() {
  const s = stats.scanStatus;
  const dot = document.getElementById('scan-dot');
  const label = document.getElementById('scan-label');
  const meta = document.getElementById('scan-meta');
  if (!dot || !label || !meta) return;

  if (!s || !s.active) {
    dot.className = 'scan-dot inactive';
    label.textContent = 'Auto-scan not started';
    meta.innerHTML = '';
    return;
  }

  if (s.lastScanError) {
    dot.className = 'scan-dot error';
    label.textContent = 'Scan error';
    meta.innerHTML = `<span class="scan-meta-item" style="color:var(--danger)">${escapeHtml(s.lastScanError)}</span>`;
    return;
  }

  dot.className = 'scan-dot active';
  label.textContent = `Auto-scan ON · every ${s.intervalHours}h`;

  const parts = [];
  if (s.lastScanAt) {
    parts.push(`<span class="scan-meta-item">Last: <strong>${timeAgo(new Date(s.lastScanAt))}</strong></span>`);
  }
  if (s.nextScanAt) {
    const next = new Date(s.nextScanAt);
    const diff = next - Date.now();
    if (diff > 0) {
      parts.push(`<span class="scan-meta-item">Next in: <strong>${formatDuration(diff)}</strong></span>`);
    } else {
      parts.push(`<span class="scan-meta-item">Next: <strong>any moment</strong></span>`);
    }
  }
  meta.innerHTML = parts.join('');
}

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h/24)}d ago`;
}

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function renderHealthWarning() {
  const banner = document.getElementById('health-banner');
  const msg = document.getElementById('health-banner-msg');
  if (!banner) return;
  const w = stats.healthWarning;
  if (w && w.message) {
    msg.textContent = `${w.message} (${timeAgo(new Date(w.ts))})`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

async function dismissHealthWarning() {
  document.getElementById('health-banner').style.display = 'none';
  try { await fetch('/api/health-warning', { method: 'DELETE' }); } catch {}
}

function renderSetupChecklist() {
  const setup = stats.setup;
  if (!setup) return;

  // Hide the whole checklist once all required steps are done
  const wrapper = document.getElementById('setup-checklist');
  if (!wrapper) return;
  wrapper.style.display = setup.allRequiredDone ? 'none' : 'block';

  const subtitle = document.getElementById('setup-subtitle');
  const pending = setup.steps.filter(s => s.required && !s.done).length;
  if (subtitle) {
    subtitle.textContent = setup.allRequiredDone
      ? 'All set!'
      : `${pending} step${pending !== 1 ? 's' : ''} remaining`;
  }

  renderStepsList('setup-steps', setup.steps);

  // Also render in settings page if visible
  const settingsWrapper = document.getElementById('settings-setup-checklist');
  if (settingsWrapper) {
    settingsWrapper.style.display = setup.allDone ? 'none' : 'block';
    renderStepsList('settings-setup-steps', setup.steps);
  }
}

function renderStepsList(containerId, steps) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.innerHTML = steps.map(step => {
    const cls = step.done ? 'done' : `pending${step.required ? '' : ' optional'}`;
    const icon = step.done ? '✅' : step.required ? '⚠️' : '○';
    const chevron = step.done ? '' : '<span class="step-chevron">›</span>';
    const optionalTag = !step.required ? '<span class="step-optional-tag">Optional</span>' : '';

    return `
      <div class="setup-step ${escapeHtml(cls)}" id="step-${escapeHtml(step.id)}" onclick="toggleStep('${escapeHtml(step.id)}', ${Boolean(step.done)})">
        <div class="setup-step-header">
          <div class="step-icon">${icon}</div>
          <div class="step-body">
            <div class="step-label">${escapeHtml(step.label)} ${optionalTag}</div>
            <div class="step-desc">${step.done ? 'Complete' : escapeHtml(step.description)}</div>
          </div>
          ${chevron}
        </div>
        ${!step.done ? `
        <div class="setup-step-detail">
          <div class="step-command">${escapeHtml(step.command)}</div>
          <div class="step-hint">${escapeHtml(step.hint)}</div>
        </div>` : ''}
      </div>`;
  }).join('');
}

function toggleStep(id, isDone) {
  if (isDone) return;
  const el = document.getElementById(`step-${id}`);
  if (el) el.classList.toggle('open');
}

function renderSettings() {
  const s = currentSettings;

  const scanEl = document.getElementById('scan-interval');
  const applyEl = document.getElementById('apply-interval');
  if (scanEl) setSelectValue(scanEl, s.scanIntervalHours);
  if (applyEl) setSelectValue(applyEl, s.applyIntervalHours);

  // Login card — three states: true (confirmed), false (confirmed not), null (unverified)
  const loggedIn = stats.loggedIn;
  const badge = document.getElementById('login-status-badge');
  const desc = document.getElementById('login-status-desc');
  const setupBtn = document.getElementById('btn-setup');

  if (badge) {
    if (loggedIn === true) {
      badge.textContent = '✓ Logged In';
      badge.style.background = 'var(--success-bg)';
      badge.style.color = 'var(--success)';
    } else if (loggedIn === null) {
      badge.textContent = '? Unverified';
      badge.style.background = 'var(--info-bg)';
      badge.style.color = 'var(--info)';
    } else {
      badge.textContent = '⚠ Not Logged In';
      badge.style.background = 'var(--warning-bg)';
      badge.style.color = 'var(--warning)';
    }
  }
  if (desc) {
    if (loggedIn === true) {
      desc.textContent = 'Session confirmed working — codes are being applied automatically.';
    } else if (loggedIn === null) {
      desc.textContent = 'A saved session exists but hasn\'t been verified yet. It will be confirmed on the next Apply Codes run.';
    } else {
      desc.textContent = 'Not logged in or session expired. Click the button to open Chrome and log in.';
    }
  }
  if (setupBtn) {
    setupBtn.textContent = loggedIn === true ? '🔄 Re-login' : '🔐 Log in to Postmates';
  }

  // Reddit thread links
  const threadBadge = document.getElementById('thread-month-badge');
  if (threadBadge) threadBadge.textContent = formatMonth(stats.threadMonth || stats.ueThreadMonth);

  function applyThreadRow(labelId, linkId, threadId, subreddit, month) {
    const label = document.getElementById(labelId);
    const link = document.getElementById(linkId);
    if (threadId) {
      if (label) label.textContent = `Thread: ${threadId}  ·  ${formatMonth(month)}`;
      if (link) { link.href = `https://www.reddit.com/r/${subreddit}/comments/${threadId}/`; link.style.display = ''; }
    } else {
      if (label) label.textContent = 'No thread detected — run a source scan';
      if (link) link.style.display = 'none';
    }
  }

  applyThreadRow('thread-id-label', 'thread-link', stats.threadId, 'postmates', stats.threadMonth);
  applyThreadRow('ue-thread-id-label', 'ue-thread-link', stats.ueThreadId, 'UberEATS', stats.ueThreadMonth);

  renderSetupChecklist();
  updateNextRunLabel();
}

function setSelectValue(el, val) {
  const str = String(val);
  for (const opt of el.options) {
    if (opt.value === str) { opt.selected = true; return; }
  }
}

function updateNextRunLabel() {
  const el = document.getElementById('next-scan-label');
  if (!el) return;
  const h = currentSettings.scanIntervalHours;
  const label = h < 1
    ? `Scanning sources every ${h * 60} minutes`
    : h === 1
    ? 'Scanning sources every hour'
    : `Scanning sources every ${h} hours`;
  el.textContent = label;
}

function renderQueue(queue) {
  const el = document.getElementById('queue-list');
  const count = document.getElementById('pending-count');
  count.textContent = `${queue.length} code${queue.length !== 1 ? 's' : ''}`;

  if (!queue.length) {
    el.innerHTML = '<div class="empty-state">Queue is empty — run a source scan to find codes</div>';
    return;
  }

  el.innerHTML = '';
  queue.forEach(entry => {
    const code = typeof entry === 'string' ? entry : entry.code;
    const meta = typeof entry === 'string' ? {} : entry;
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.id = `q-${cssToken(code)}`;

    const body = document.createElement('div');
    body.className = 'queue-main';

    const codeEl = document.createElement('div');
    codeEl.className = 'queue-code';
    codeEl.textContent = code;

    const metaRow = document.createElement('div');
    metaRow.className = 'queue-meta';
    metaRow.innerHTML = [
      meta.sourceLabel ? `<span class="meta-pill source">${escapeHtml(meta.sourceLabel)}</span>` : '',
      meta.confidenceLabel ? `<span class="meta-pill confidence confidence-${cssToken(meta.confidenceLabel.toLowerCase())}">${escapeHtml(meta.confidenceLabel)} confidence</span>` : '',
      meta.statusHint ? `<span class="meta-pill">${escapeHtml(meta.statusHint)}</span>` : '',
      meta.region ? `<span class="meta-pill">${escapeHtml(meta.region)}</span>` : '',
      meta.expiresAt ? `<span class="meta-pill">Expires ${escapeHtml(meta.expiresAt)}</span>` : '',
      meta.lastSeenAt ? `<span class="meta-pill">Seen ${escapeHtml(timeAgo(new Date(meta.lastSeenAt)))}</span>` : '',
    ].filter(Boolean).join('');

    const noteEl = document.createElement('div');
    noteEl.className = 'queue-note';
    noteEl.textContent = meta.statusNote || meta.sourceTitle || '';

    const btn = document.createElement('button');
    btn.className = 'btn btn-danger btn-sm';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => removeCode(code));

    body.append(codeEl, metaRow);
    if (noteEl.textContent) body.appendChild(noteEl);
    row.append(body, btn);
    el.appendChild(row);
  });
}

function renderResults() {
  const tbody = document.getElementById('results-tbody');
  if (!tbody) return;

  const data = activeFilter === 'all'
    ? processed
    : processed.filter(r => r.result === activeFilter);

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No ${activeFilter === 'all' ? '' : activeFilter + ' '}results yet</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  [...data].reverse().forEach(r => {
    const row = document.createElement('tr');
    row.className = 'result-row';
    row.id = `result-row-${cssToken(r.code)}`;

    const codeCell = document.createElement('td');
    codeCell.className = 'result-code';
    codeCell.innerHTML = `
      <div class="result-code-stack">
        <div class="result-code-value">${escapeHtml(r.code)}</div>
        ${r.confidenceLabel ? `<div class="result-submeta">${escapeHtml(r.confidenceLabel)} confidence</div>` : ''}
      </div>
    `;

    const sourceCell = document.createElement('td');
    sourceCell.className = 'result-source';
    sourceCell.innerHTML = `
      <div class="result-source-label">${escapeHtml(r.sourceLabel || 'Manual')}</div>
      <div class="result-submeta">${escapeHtml(r.statusHint || r.sourceTitle || '—')}</div>
    `;

    const resultCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `result-badge ${cssToken(r.result)}`;
    badge.textContent = `${resultIcon(r.result)} ${resultLabel(r.result)}`;
    resultCell.appendChild(badge);

    const detailCell = document.createElement('td');
    detailCell.className = 'result-detail';
    detailCell.innerHTML = `
      <div>${escapeHtml(r.detail || '—')}</div>
      ${r.statusNote ? `<div class="result-submeta">${escapeHtml(r.statusNote)}</div>` : ''}
    `;

    const timeCell = document.createElement('td');
    timeCell.style.color = 'var(--label-3)';
    timeCell.style.fontSize = '12px';
    timeCell.style.whiteSpace = 'nowrap';
    timeCell.textContent = r.ts ? timeAgo(new Date(r.ts)) : '—';

    const deleteCell = document.createElement('td');
    deleteCell.className = 'result-delete-cell';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'result-delete-btn';
    deleteBtn.title = 'Remove';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => deleteResult(r.code));
    deleteCell.appendChild(deleteBtn);

    row.append(codeCell, sourceCell, resultCell, detailCell, timeCell, deleteCell);
    tbody.appendChild(row);
  });
}

function renderLog() {
  const el = document.getElementById('log-container');
  if (!allLogs.length) {
    el.innerHTML = '<div class="empty-state">No log entries yet</div>';
    return;
  }

  el.innerHTML = allLogs.map(entry => {
    const ts = new Date(entry.ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const detail = formatLogDetail(entry);
    return `<div class="log-entry">
      <span class="log-ts">${ts}</span>
      <span class="log-type ${cssToken(entry.type)}">${escapeHtml(entry.type)}</span>
      <span class="log-detail">${escapeHtml(detail)}</span>
    </div>`;
  }).join('');
}

/* ── Settings Actions ──────────────────────────────────────────────────── */

async function saveScanInterval() {
  const val = parseFloat(document.getElementById('scan-interval').value);
  await saveSettings({ scanIntervalHours: val });
}

async function saveApplyInterval() {
  const val = parseFloat(document.getElementById('apply-interval').value);
  await saveSettings({ applyIntervalHours: val });
}

async function saveSettings(updates) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const saved = await res.json();
    currentSettings = saved;
    updateNextRunLabel();
    showToast('Settings saved');
  } catch {
    showToast('Failed to save settings', 'error');
  }
}

/* ── SSE ───────────────────────────────────────────────────────────────── */

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    setStatus('connected', 'Connected');
    // Daemon may have restarted — no run is in progress on the fresh process
    setRunning('apply', false);
    setRunning('reddit', false);
  };

  eventSource.onmessage = (e) => handleSSE(JSON.parse(e.data));

  eventSource.onerror = () => {
    setStatus('error', 'Reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function handleSSE(data) {
  switch (data.type) {
    case 'connected':
      setStatus('connected', 'Connected');
      break;

    case 'reddit_progress':
      appendRedditProgress(data);
      break;

    case 'reddit_done':
      loadAll();
      if (data.scanStatus) { stats.scanStatus = data.scanStatus; renderScanStatus(); }
      if (data.error) {
        showToast(`Source scan failed: ${data.error}`, 'error');
        setLastRun('reddit', `Error`, true);
      } else {
        const total = data.newCodes || 0;
        showToast(`Source scan done — ${total} new code${total !== 1 ? 's' : ''} found`);
        setLastRun('reddit', total > 0 ? `✅ ${total} new code${total !== 1 ? 's' : ''}` : '✅ Done, 0 new');
      }
      setRunning('reddit', false);
      finishLiveCard('reddit');
      break;

    case 'apply_progress':
      appendLiveLog(data);
      break;

    case 'apply_done':
      loadAll();
      if (data.error) {
        showToast(`Apply failed: ${data.error}`, 'error');
        setLastRun('apply', 'Error', true);
        setRunning('apply', false);
        finishLiveCard('apply', 0, 0, false);
        break;
      }
      const successes = (data.results || []).filter(r => r.result === 'success').length;
      let toastMsg = successes ? `${successes} code${successes > 1 ? 's' : ''} worked! 🎉` : `Applied ${data.applied} codes — none worked this run`;
      if (data.rateLimited) toastMsg += ' · Rate limited, remaining codes saved for next run';
      showToast(toastMsg);
      setLastRun('apply', successes > 0 ? `✅ ${successes} worked` : data.rateLimited ? '⏳ Rate limited' : `✅ ${data.applied} tried`);
      setRunning('apply', false);
      finishLiveCard('apply', data.applied, successes, data.rateLimited);
      break;

    case 'queue_updated':
      loadAll();
      loadQueue();
      break;

    case 'processed_updated':
      loadProcessed();
      loadStats();
      break;

    case 'self_test_done':
      handleSelfTestDone(data);
      loadStats(); // refresh banner state (set on fail, cleared on pass)
      break;

    case 'health_warning_cleared':
      stats.healthWarning = null;
      renderHealthWarning();
      break;

    case 'setup_done':
      stats.loggedIn = data.loggedIn;
      renderSettings();
      renderSetupChecklist();
      showToast(data.loggedIn ? 'Logged in successfully ✅' : 'Chrome closed — session not detected', data.loggedIn ? 'success' : 'error');
      const setupBtn = document.getElementById('btn-setup');
      if (setupBtn) { setupBtn.disabled = false; setupBtn.textContent = data.loggedIn ? '🔄 Re-login to Postmates' : '🔐 Log in to Postmates'; }
      break;

    case 'settings_updated':
      if (data.settings) {
        currentSettings = data.settings;
        renderSettings();
      }
      if (data.scanStatus) {
        stats.scanStatus = data.scanStatus;
        renderScanStatus();
      }
      break;

    case 'error':
      showToast(`Error: ${data.message}`, 'error');
      setRunning('reddit', false);
      setRunning('apply', false);
      {
        const setupBtn = document.getElementById('btn-setup');
        if (setupBtn) {
          setupBtn.disabled = false;
          setupBtn.textContent = stats.loggedIn === true ? '🔄 Re-login' : '🔐 Log in to Postmates';
        }
      }
      break;
  }
}

/* ── Live Progress ─────────────────────────────────────────────────────── */

function showLiveCard() {
  const card = document.getElementById('live-status-card');
  card.style.display = '';
}

function resetLiveCard() {
  const card = document.getElementById('live-status-card');
  const header = card.querySelector('.card-header');
  const log = document.getElementById('live-log');
  card.style.display = '';
  if (header) header.innerHTML = '<h3>Live Progress</h3><span class="spinner"></span>';
  log.innerHTML = '';
  liveLines = [];
}

function hideLiveCard() {
  document.getElementById('live-status-card').style.display = 'none';
}

function finishLiveCard(type, applied, successes, rateLimited) {
  const card = document.getElementById('live-status-card');
  if (!card) return;
  const header = card.querySelector('.card-header');
  if (!header) return;

  let summary;
  if (type === 'reddit') {
    summary = `<span style="color:var(--green);font-size:13px;font-weight:600">✅ Source scan complete</span>`;
  } else if (rateLimited) {
    summary = `<span style="color:var(--orange);font-size:13px;font-weight:600">⏳ Rate limited — remaining codes saved for next run</span>`;
  } else if (successes > 0) {
    summary = `<span style="color:var(--green);font-size:13px;font-weight:600">✅ ${successes} code${successes > 1 ? 's' : ''} worked!</span>`;
  } else {
    summary = `<span style="color:var(--label-3);font-size:13px">Run complete — ${applied} tried</span>`;
  }
  const dismiss = `<button onclick="hideLiveCard()" style="background:none;border:none;color:var(--label-3);cursor:pointer;font-size:18px;line-height:1;padding:0 2px" title="Dismiss">×</button>`;
  header.innerHTML = `<h3>Live Progress</h3><div style="display:flex;align-items:center;gap:10px">${summary}${dismiss}</div>`;
}

function appendLiveLog(data) {
  showLiveCard();
  const log = document.getElementById('live-log');
  let cls = '', msg = '';

  if (data.status === 'trying') {
    msg = `→ Trying ${data.code}...`;
  } else if (data.status === 'success') {
    msg = `✅ ${data.code} — SUCCESS${data.detail ? ': ' + data.detail : ''}`;
    cls = 'success';
  } else if (data.status === 'rejected') {
    msg = `❌ ${data.code} — rejected`;
    cls = 'error';
  } else if (data.status === 'ratelimited') {
    msg = `⏳ Rate limited — stopping run`;
    cls = 'waiting';
  } else if (data.status === 'rate_limited_stop') {
    msg = `⏳ Rate limited — ${data.preserved} code${data.preserved !== 1 ? 's' : ''} saved in queue for next run`;
    cls = 'waiting';
  } else if (data.status === 'waiting') {
    const secs = Math.round((data.waitMs || 120000) / 1000);
    msg = `   Waiting ${secs}s before next code...`;
    cls = 'waiting';
  } else {
    msg = `${data.code}: ${data.status}`;
  }

  const div = document.createElement('div');
  div.className = `live-log-line ${cls}`;
  const ts = document.createElement('span');
  ts.className = 'live-log-ts';
  ts.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const text = document.createElement('span');
  text.textContent = msg;
  div.append(ts, text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

/* ── User Actions ──────────────────────────────────────────────────────── */

async function restartServer() {
  if (!confirm('Restart the Postmates Promo Tracker server?\n\nIt will be back online in ~5 seconds.')) return;
  try {
    await fetch('/api/restart', { method: 'POST' });
    setStatus('error', 'Restarting...');
    showToast('Restarting server — reconnecting in a moment...');
    // Reconnect SSE after a pause
    setTimeout(() => {
      connectSSE();
      loadAll();
    }, 6000);
  } catch {
    showToast('Already restarting or unreachable');
  }
}

async function quitApp() {
  if (!confirm('Stop the Postmates Promo Tracker daemon?')) return;
  try {
    await fetch('/api/quit', { method: 'POST' });
    setStatus('inactive', 'Stopped');
    document.getElementById('scan-dot').className = 'scan-dot inactive';
    document.getElementById('scan-label').textContent = 'Auto-scan OFF';
    document.getElementById('scan-meta').innerHTML = '';
    showToast('App stopped. Close this tab or relaunch to restart.');
  } catch {
    showToast('Already stopped or unreachable');
  }
}

async function runSelfTest() {
  const btn = document.getElementById('btn-selftest');
  const badge = document.getElementById('selftest-badge');
  const desc = document.getElementById('selftest-desc');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Testing...'; }
  if (badge) { badge.style.display = ''; badge.textContent = 'Running...'; badge.style.background = 'var(--blue-fill)'; badge.style.color = 'var(--blue)'; }
  if (desc) desc.textContent = 'Opening Chrome and applying a fake code — takes about 30 seconds...';
  try {
    await fetch('/api/self-test', { method: 'POST' });
  } catch {
    showToast('Failed to start self-test', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🧪 Run Test'; }
  }
}

function handleSelfTestDone(data) {
  const btn = document.getElementById('btn-selftest');
  const badge = document.getElementById('selftest-badge');
  const desc = document.getElementById('selftest-desc');
  if (btn) { btn.disabled = false; btn.textContent = '🧪 Run Test'; }
  if (badge) {
    badge.style.display = '';
    if (data.ok) {
      badge.textContent = '✓ Healthy';
      badge.style.background = 'var(--green-fill)';
      badge.style.color = 'var(--green)';
    } else {
      badge.textContent = '⚠ Problem';
      badge.style.background = 'var(--red-fill)';
      badge.style.color = 'var(--red)';
    }
  }
  if (desc) desc.textContent = data.message || data.error || 'Test finished.';
  showToast(data.ok ? 'Self-test passed — detection pipeline healthy ✅' : `Self-test failed: ${data.message || data.error}`, data.ok ? 'success' : 'error');
}

async function triggerSetup() {
  const btn = document.getElementById('btn-setup');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Opening Chrome...'; }
  showToast('Opening Chrome for Postmates login — log in then close the window');
  try {
    await fetch('/api/setup', { method: 'POST' });
  } catch {
    showToast('Failed to open setup', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔐 Log in to Postmates'; }
  }
}

function setLastRun(which, msg, isError = false) {
  const el = document.getElementById(`last-${which}-run`);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--label-3)';
}

function appendRedditProgress(data) {
  showLiveCard();
  const log = document.getElementById('live-log');
  const msgs = {
    detecting: `🔍 ${data.source}: detecting thread...`,
    new_thread: `🆕 ${data.source}: new thread ${data.threadId}`,
    fetching: `💬 ${data.source}: fetching comments (${data.threadId})...`,
    fallback: `↩ ${data.source}: new thread empty, checking previous (${data.threadId})...`,
    source_item: `• ${data.source}: ${data.message}`,
    done: `✅ ${data.source}: ${data.commentsScanned ? `${data.commentsScanned} comments · ` : ''}${data.newCodes} candidate${data.newCodes === 1 ? '' : 's'}${data.queued !== undefined ? ` · ${data.queued} queued` : ''}`,
    error: `❌ ${data.source}: ${data.message}`,
  };
  const msg = msgs[data.step] || `${data.source}: ${data.step}`;
  const cls = data.step === 'done' ? 'success' : data.step === 'error' ? 'error' : data.step === 'source_item' ? 'waiting' : '';
  const div = document.createElement('div');
  div.className = `live-log-line ${cls}`;
  const ts = document.createElement('span');
  ts.className = 'live-log-ts';
  ts.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const text = document.createElement('span');
  text.textContent = msg;
  div.append(ts, text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function triggerReddit() {
  setRunning('reddit', true);
  resetLiveCard();
  appendLiveLog({ status: 'trying', code: 'Starting source scan...' });
  try {
    await fetch('/api/run/reddit', { method: 'POST' });
  } catch {
    showToast('Failed to start source scan', 'error');
    setRunning('reddit', false);
  }
}

async function triggerApply() {
  setRunning('apply', true);
  resetLiveCard();
  appendLiveLog({ status: 'trying', code: 'Starting code applier...' });
  try {
    await fetch('/api/run/apply', { method: 'POST' });
  } catch {
    showToast('Failed to start code applier', 'error');
    setRunning('apply', false);
  }
}

async function addCode() {
  const input = document.getElementById('add-code-input');
  const code = (input.value || '').trim().toUpperCase();
  if (!code) return;
  try {
    const res = await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.added) {
      showToast(`Added ${code} to queue`);
      input.value = '';
      loadQueue();
      loadAll();
    } else {
      showToast(`${code} is already in queue or processed`);
    }
  } catch {
    showToast('Failed to add code', 'error');
  }
}

async function deleteResult(code) {
  // Optimistically remove the row immediately
  const row = document.getElementById(`result-row-${cssToken(code)}`);
  if (row) {
    row.style.opacity = '0.3';
    row.style.transition = 'opacity 0.15s';
  }
  try {
    await fetch(`/api/processed/${encodeURIComponent(code)}`, { method: 'DELETE' });
    processed = processed.filter(r => r.code !== code);
    renderResults();
    loadStats();
  } catch {
    if (row) row.style.opacity = '';
    showToast('Failed to delete result', 'error');
  }
}

async function removeCode(code) {
  try {
    await fetch(`/api/queue/${encodeURIComponent(code)}`, { method: 'DELETE' });
    loadQueue();
    loadAll();
  } catch {}
}

function filterResults(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active',
      btn.textContent.trim().toLowerCase() === filter ||
      (filter === 'all' && btn.textContent.trim() === 'All'));
  });
  renderResults();
}

document.getElementById('add-code-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') addCode();
});

/* ── Helpers ───────────────────────────────────────────────────────────── */

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setStatus(cls, text) {
  document.getElementById('status-dot').className = `status-dot ${cls}`;
  document.getElementById('status-text').textContent = text;
}

function setRunning(which, running) {
  const btn = document.getElementById(`btn-${which}`);
  if (btn) btn.disabled = running;
}

let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderLeft = `3px solid ${type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--accent)'}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function resultLabel(r) {
  return { success: 'Success', rejected: 'Rejected', ratelimited: 'Rate Limited', error: 'Error', unknown: 'Unknown' }[r] || r;
}

function resultIcon(r) {
  return { success: '✅', rejected: '❌', ratelimited: '⏳', error: '⚠️', unknown: '❓' }[r] || '•';
}

function formatMonth(m) {
  if (!m) return '';
  const [year, month] = m.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function formatLogDetail(entry) {
  const parts = [];
  if (entry.source) parts.push(`source: ${entry.source}`);
  if (entry.thread_id) parts.push(`thread: ${entry.thread_id}`);
  if (entry.comments_scanned) parts.push(`${entry.comments_scanned} comments`);
  if (entry.new_codes !== undefined) parts.push(`${entry.new_codes} new codes`);
  if (entry.queued !== undefined) parts.push(`${entry.queued} queued`);
  if (entry.applied !== undefined) parts.push(`${entry.applied} applied`);
  if (entry.code) parts.push(`code: ${entry.code}`);
  if (entry.result) parts.push(entry.result);
  if (entry.error) parts.push(`ERROR: ${entry.error}`);
  if (entry.detail) parts.push(entry.detail);
  if (entry.old_thread) parts.push(`${entry.old_thread} → ${entry.new_thread}`);
  return parts.join(' · ') || '—';
}

function renderMonitoredSources(sources) {
  const el = document.getElementById('sources-list');
  const badge = document.getElementById('sources-count');
  if (!el || !badge) return;

  const activeCount = sources.filter(source => source.status && source.status !== 'idle').length;
  badge.textContent = `${activeCount} active`;

  if (!sources.length) {
    el.innerHTML = '<div class="empty-state">Source status will appear after the first scan</div>';
    return;
  }

  el.innerHTML = sources.map(source => `
    <div class="source-row">
      <div class="source-main">
        <div class="source-title-row">
          <div class="source-name">${escapeHtml(source.label || source.key)}</div>
          <span class="source-status-chip ${sourceStatusClass(source.status)}">${escapeHtml(sourceStatusLabel(source.status))}</span>
        </div>
        <div class="source-meta-row">
          ${source.note ? `<span class="meta-pill">${escapeHtml(source.note)}</span>` : ''}
          ${source.usableCodes !== undefined ? `<span class="meta-pill">${escapeHtml(String(source.usableCodes))} candidates</span>` : ''}
          ${source.queued !== undefined ? `<span class="meta-pill">${escapeHtml(String(source.queued))} queued</span>` : ''}
          ${source.lastCheckedAt ? `<span class="meta-pill">Checked ${escapeHtml(timeAgo(new Date(source.lastCheckedAt)))}</span>` : ''}
        </div>
      </div>
      ${source.sourceUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noreferrer">Open ↗</a>` : ''}
    </div>
  `).join('');
}

function sourceStatusClass(status) {
  return `status-${cssToken(status || 'idle')}`;
}

function sourceStatusLabel(status) {
  return {
    ok: 'Healthy',
    checking: 'Checking',
    error: 'Error',
    idle: 'Idle',
  }[status] || 'Idle';
}
