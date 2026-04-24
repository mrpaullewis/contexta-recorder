/**
 * Popup logic — recording controls, live status, export actions.
 */
import { generateJmx } from '../shared/jmx-generator.js';
import { generateHar } from '../shared/har-export.js';

const $ = id => document.getElementById(id);

let statusInterval = null;

// ── UI State ─────────────────────────────────────────────────
async function updateUI() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  const state = status.state || 'idle';

  $('cr-setup').style.display = 'none';
  $('cr-active').style.display = 'none';
  $('cr-results').style.display = 'none';

  if (state === 'idle') {
    // Check if there's a completed session to show
    const lastResult = await chrome.runtime.sendMessage({ type: 'get-session' });
    if (lastResult?.session?.endTime) {
      showResults(lastResult.session);
      $('cr-status').textContent = 'Results';
    } else {
      $('cr-setup').style.display = '';
      $('cr-status').textContent = 'Ready';
    }
    clearInterval(statusInterval);
    return;
  }

  // Show the active recording panel
  $('cr-active').style.display = '';

  const s = status.session;
  if (!s) return;

  $('cr-status').textContent = state === 'paused' ? 'Paused' : 'Recording';
  $('cr-pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
  $('cr-stat-tx').textContent = s.transactionCount;
  $('cr-stat-req').textContent = s.requestCount;
  $('cr-current-tx').textContent = s.currentTransaction || '(no active transaction)';

  // Duration
  const elapsed = Math.round((Date.now() - new Date(s.startTime).getTime()) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  $('cr-stat-time').textContent = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

// ── Transaction list ─────────────────────────────────────────
function renderTransactionList(session, containerId) {
  const el = $(containerId);
  if (!session || !session.transactions) { el.innerHTML = ''; return; }
  el.innerHTML = session.transactions.map(tx => {
    const reqCount = tx.requests ? tx.requests.length : 0;
    return `<div class="cr-tx-item">
      <span class="cr-tx-code">S${String(tx.stepNumber).padStart(2, '0')}</span>
      <span class="cr-tx-name" title="${esc(tx.name)}">${esc(tx.name)}</span>
      <span class="cr-tx-count">${reqCount}</span>
    </div>`;
  }).join('');
}

// ── Results ──────────────────────────────────────────────────
function showResults(session) {
  $('cr-setup').style.display = 'none';
  $('cr-active').style.display = 'none';
  $('cr-results').style.display = '';

  const txCount = session.transactions.length;
  const reqCount = session.transactions.reduce((s, t) => s + t.requests.length, 0);
  const corrCount = session.correlations ? session.correlations.length : 0;
  const dataReqCount = session.dataRequirements ? session.dataRequirements.length : 0;
  const assertionCount = session.assertions ? session.assertions.length : 0;
  const fpCount = session.fingerprints ? session.fingerprints.length : 0;

  $('cr-res-tx').textContent = txCount;
  $('cr-res-req').textContent = reqCount;
  $('cr-res-corr').textContent = corrCount;
  $('cr-res-fields').textContent = dataReqCount;

  renderTransactionList(session, 'cr-res-list');
  renderAnalysisSummary(session);
  renderDataSummary(session);
  updateStudioNudge(session, corrCount, dataReqCount);
}

function updateStudioNudge(session, corrCount, dataReqCount) {
  const nudgeDesc = $('cr-studio-nudge-desc');
  if (!nudgeDesc) return;

  // Context-sensitive nudge based on what was recorded
  if (corrCount > 3) {
    nudgeDesc.textContent = corrCount + ' correlations detected. PerfOps Studio lets you inspect and fine-tune these visually.';
  } else if (dataReqCount > 2) {
    nudgeDesc.textContent = dataReqCount + ' data fields found. Studio auto-generates CSV templates with realistic test data types.';
  } else if (session.transactions && session.transactions.length > 1) {
    nudgeDesc.textContent = 'Combine this with other journeys into a load test plan with visual load shaping and live monitoring.';
  } else {
    nudgeDesc.textContent = 'Combine recordings into a visual test plan with live monitoring and NFR compliance.';
  }
}

function renderAnalysisSummary(session) {
  const el = $('cr-analysis');
  if (!el) return;

  const corrs = session.correlations || [];
  const dataReqs = session.dataRequirements || [];
  const assertions = session.assertions || [];
  const fps = session.fingerprints || [];

  let html = '';

  if (corrs.length > 0) {
    html += '<div class="cr-analysis-section"><div class="cr-analysis-title">Correlations</div>';
    for (const c of corrs) {
      html += `<div class="cr-analysis-item">
        <span class="cr-tag cr-tag-${c.type}">${c.type}</span>
        <span class="cr-analysis-name">${esc(c.name)}</span>
        <span class="cr-analysis-detail">${c.usedInRequests.length} use${c.usedInRequests.length !== 1 ? 's' : ''}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (dataReqs.length > 0) {
    html += '<div class="cr-analysis-section"><div class="cr-analysis-title">Data Requirements</div>';
    for (const d of dataReqs) {
      html += `<div class="cr-analysis-item">
        <span class="cr-tag cr-tag-${d.classification}">${d.classification}</span>
        <span class="cr-analysis-name">${esc(d.fieldName)}</span>
        <span class="cr-analysis-detail">${esc(d.suggestedCsvColumn)} → ${esc(d.columnType || '')}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (fps.length > 0) {
    html += '<div class="cr-analysis-section"><div class="cr-analysis-title">Fingerprints</div>';
    for (const fp of fps) {
      html += `<div class="cr-analysis-item">
        <span class="cr-tag cr-tag-fp">${fp.pageType || 'page'}</span>
        <span class="cr-analysis-name">${esc(fp.heading || '(no heading)')}</span>
        <span class="cr-analysis-detail">${fp.fields.length} fields</span>
      </div>`;
    }
    html += '</div>';
  }

  el.innerHTML = html || '<div class="cr-analysis-empty">No analysis data — try recording a session with form interactions.</div>';
}

// ── Data Summary ────────────────────────────────────────────
function renderDataSummary(session) {
  const el = $('cr-data-summary');
  if (!el) return;

  const dataReqs = session.dataRequirements || [];
  if (dataReqs.length === 0) {
    el.innerHTML = '';
    return;
  }

  let html = '<div class="cr-analysis-title">Test Data Requirements</div>';
  html += '<table class="cr-data-table"><thead><tr>';
  html += '<th>Field</th><th>CSV Column</th><th>Type</th><th>Sample Value</th>';
  html += '</tr></thead><tbody>';

  for (const d of dataReqs) {
    html += `<tr>
      <td title="${esc(d.label || d.fieldName)}">
        <span class="cr-tag cr-tag-${d.classification}">${d.classification}</span>
        ${esc(d.fieldName)}
      </td>
      <td class="cr-mono">${esc(d.suggestedCsvColumn)}</td>
      <td>${esc(d.columnType || '—')}</td>
      <td class="cr-mono cr-truncate" title="${esc(d.sampleValue)}">${esc(d.sampleValue)}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// ── Recording controls ───────────────────────────────────────
$('cr-start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const journeyCode = $('cr-journey-code').value.trim() || 'UJ01';
  const mode = $('cr-mode').value;

  const result = await chrome.runtime.sendMessage({
    type: 'start-recording',
    tabId: tab.id,
    journeyCode,
    mode,
  });

  if (result.error) {
    $('cr-status').textContent = result.error;
    return;
  }

  updateUI();
  statusInterval = setInterval(updateUI, 1000);
});

$('cr-stop').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'stop-recording' });
  clearInterval(statusInterval);
  if (result.session) {
    showResults(result.session);
  } else {
    updateUI();
  }
});

$('cr-pause').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'toggle-pause' });
  updateUI();
});

$('cr-new-tx').addEventListener('click', async () => {
  const name = prompt('Transaction name (or leave blank for auto):');
  await chrome.runtime.sendMessage({ type: 'new-transaction', name: name || undefined });
  updateUI();
});

$('cr-new-recording').addEventListener('click', () => {
  $('cr-results').style.display = 'none';
  $('cr-setup').style.display = '';
  $('cr-status').textContent = 'Ready';
});

$('cr-clear-session').addEventListener('click', async () => {
  await chrome.storage.local.remove(['currentSession', 'recorderState']);
  $('cr-results').style.display = 'none';
  $('cr-setup').style.display = '';
  $('cr-status').textContent = 'Ready';
});

// ── Export actions ────────────────────────────────────────────
$('cr-download-har').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  const har = generateHar(result.session);
  downloadFile(
    JSON.stringify(har, null, 2),
    `${result.session.journeyCode}_recording.har`,
    'application/json'
  );
});

$('cr-download-jmx').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  const mode = $('cr-jmx-mode').value;
  const jmx = generateJmx(result.session, { mode });
  const suffix = mode === 'fragment' ? '' : '_standalone';
  downloadFile(
    jmx,
    `${result.session.journeyCode}${suffix}.jmx`,
    'application/octet-stream'
  );
});

// ── Live log (request captured events) ───────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'request-captured') return;
  const log = $('cr-live-log');
  if (!log) return;
  const r = msg.request;
  const entry = document.createElement('div');
  entry.className = 'cr-log-entry';
  entry.innerHTML = `<span class="cr-log-method">${r.method}</span> <span class="cr-log-status">${r.status || ''}</span> <span class="cr-log-path">${esc(r.path)}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;

  // Update stats inline
  updateUI();
});

// ── Helpers ──────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true });
}

// Init
updateUI();
