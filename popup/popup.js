/**
 * Popup logic — recording controls, live status, export actions, auth.
 */
import { generateJmx } from '../shared/jmx-generator.js';
import { generateHar } from '../shared/har-export.js';
import { getAuth, saveAuth, clearAuth, getOptions } from '../shared/storage.js';
import { ASSURE_API, NHS_API } from '../shared/constants.js';

const $ = id => document.getElementById(id);

let statusInterval = null;
let currentAuth = null;  // { token, user, expires_at }

// ── Auth ─────────────────────────────────────────────────────

async function getAssureUrl() {
  const opts = await getOptions();
  return (opts.assureUrl || ASSURE_API.DEFAULT_URL).replace(/\/$/, '');
}

async function nhsFetch(path, options = {}) {
  const opts = await getOptions();
  const baseUrl = (opts.nhsUrl || NHS_API.DEFAULT_URL).replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (currentAuth?.token) {
    headers['Authorization'] = `Bearer ${currentAuth.token}`;
  }
  return fetch(baseUrl + path, { ...options, headers });
}

async function assureFetch(path, options = {}) {
  const baseUrl = await getAssureUrl();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (currentAuth?.token) {
    headers['Authorization'] = `Bearer ${currentAuth.token}`;
  }
  return fetch(baseUrl + path, { ...options, headers });
}

async function initAuth() {
  currentAuth = await getAuth();
  if (!currentAuth?.token) {
    renderAuthState(null);
    return;
  }

  // Validate token with /me
  try {
    const resp = await assureFetch('/api/v1/auth/me');
    if (resp.ok) {
      const data = await resp.json();
      currentAuth.user = data.user;
      await saveAuth(currentAuth);
      renderAuthState(currentAuth.user);
    } else if (resp.status === 401) {
      // Try refresh
      const refreshed = await tryRefreshToken();
      if (!refreshed) {
        await logout();
      }
    }
  } catch {
    // Offline or Assure down — use cached auth, don't log out
    renderAuthState(currentAuth.user);
  }
}

async function tryRefreshToken() {
  try {
    const resp = await assureFetch('/api/v1/auth/refresh', { method: 'POST' });
    if (resp.ok) {
      const data = await resp.json();
      currentAuth.token = data.token;
      currentAuth.expires_at = data.expires_at;
      await saveAuth(currentAuth);
      renderAuthState(currentAuth.user);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function doLogin(email, password) {
  const resp = await assureFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Login failed');
  currentAuth = { token: data.token, user: data.user, expires_at: data.expires_at };
  await saveAuth(currentAuth);
  renderAuthState(currentAuth.user);
  return currentAuth;
}

async function doRegister(email, password, name) {
  const resp = await assureFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Registration failed');
  currentAuth = { token: data.token, user: data.user, expires_at: data.expires_at };
  await saveAuth(currentAuth);
  renderAuthState(currentAuth.user);
  return currentAuth;
}

async function logout() {
  currentAuth = null;
  await clearAuth();
  renderAuthState(null);
}

function hasFeature(feature) {
  return currentAuth?.user?.features?.includes(feature) || false;
}

function renderAuthState(user) {
  const headerAuth = $('cr-header-auth');
  const loginForm = $('cr-auth-login');
  const badge = $('cr-auth-badge');
  const cloudActions = $('cr-cloud-actions');
  const authPrompt = $('cr-auth-prompt');
  const pushAssureBtn = $('cr-push-assure');
  const pushNhsBtn = $('cr-push-nhs');

  // Always show cloud actions — buttons prompt login if not signed in
  cloudActions.style.display = '';
  if (authPrompt) authPrompt.style.display = 'none';

  if (user) {
    // Logged in — show pill in header, badge below header
    headerAuth.innerHTML = `<div class="cr-user-pill"><span class="cr-user-dot"></span>${esc(user.name || user.email)}</div>`;
    loginForm.style.display = 'none';
    badge.style.display = '';
    $('cr-auth-name').textContent = user.name || user.email;
    $('cr-auth-org').textContent = user.org ? `${user.org.name} · ${user.org.plan}` : 'Free account';

    // Feature-gate buttons
    pushAssureBtn.style.display = hasFeature('push_to_assure') ? '' : 'none';
    pushNhsBtn.style.display = hasFeature('push_to_assure') ? '' : 'none';
  } else {
    // Not logged in — show both, they'll prompt login on click
    headerAuth.innerHTML = '<a href="#" id="cr-header-signin">Sign in</a>';
    loginForm.style.display = 'none';
    badge.style.display = 'none';
    pushAssureBtn.style.display = '';
    pushNhsBtn.style.display = '';

    // Re-bind header sign-in link
    const signinLink = $('cr-header-signin');
    if (signinLink) {
      signinLink.addEventListener('click', (e) => {
        e.preventDefault();
        showLoginForm();
      });
    }
  }
}

function showLoginForm() {
  $('cr-auth-login').style.display = '';
  $('cr-auth-error').style.display = 'none';
  $('cr-auth-email').value = '';
  $('cr-auth-password').value = '';
  $('cr-auth-email').focus();
}

function hideLoginForm() {
  $('cr-auth-login').style.display = 'none';
}

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
        <span class="cr-analysis-detail">${esc(d.suggestedCsvColumn)} → ${esc(d.assureColumnType || '')}</span>
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
      <td>${esc(d.assureColumnType || '—')}</td>
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
$('cr-download-json').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  downloadFile(
    JSON.stringify(result.session, null, 2),
    `${result.session.journeyCode}_recording.json`,
    'application/json'
  );
});

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

$('cr-download-csv').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  const dataReqs = result.session.dataRequirements || [];
  if (dataReqs.length === 0) {
    alert('No data fields to export — record a session with form inputs first.');
    return;
  }
  const headers = dataReqs.map(d => d.suggestedCsvColumn);
  const values = dataReqs.map(d => csvEscape(d.sampleValue || ''));
  const csv = headers.join(',') + '\n' + values.join(',') + '\n';
  downloadFile(csv, `${result.session.journeyCode}_test_data.csv`, 'text/csv');
});

$('cr-push-assure').addEventListener('click', async () => {
  if (!currentAuth?.token) {
    showLoginForm();
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  const session = result.session;
  const btn = $('cr-push-assure');
  btn.textContent = 'Pushing...';
  btn.disabled = true;
  try {
    const systemCode = currentAuth.user.projects?.[0]?.code || session.journeyCode;
    const projectId = currentAuth.user.projects?.[0]?.id || null;
    const errors = [];

    // 1. Save full recording (session JSON, page responses, correlations, etc.)
    btn.textContent = 'Saving recording...';
    const recResp = await assureFetch('/api/v1/recordings', {
      method: 'POST',
      body: JSON.stringify({ recording: session, project_id: projectId }),
    });
    if (recResp.ok) {
      const recData = await recResp.json();
      console.log('Recording saved:', recData.recording_id || 'ok');
    } else {
      const ct = recResp.headers.get('content-type') || '';
      const msg = ct.includes('json') ? (await recResp.json()).message : `HTTP ${recResp.status}`;
      errors.push('Recording: ' + msg);
    }

    // 2. Push script manifest (structured metadata for Run Builder)
    btn.textContent = 'Pushing manifest...';
    const allRequests = session.transactions.flatMap(tx => tx.requests);
    const correlations = session.correlations || [];
    const dataReqs = session.dataRequirements || [];
    const assertions = session.assertions || [];

    const endpoints = allRequests
      .filter(r => r.resourceType === 'Document' || r.method === 'POST')
      .map(r => ({ method: r.method, path: r.path?.split('?')[0] || r.url }));

    const variablesRequired = dataReqs
      .filter(d => d.classification === 'input' || d.classification === 'radio' || d.classification === 'select')
      .map(d => ({ name: d.suggestedCsvColumn, source: `csv:data/${session.journeyCode.toLowerCase()}_data.csv` }));

    const variablesInternal = correlations
      .map(c => ({ name: c.name, source: 'extractor' }));

    const csvColumns = dataReqs
      .filter(d => d.classification === 'input' || d.classification === 'radio' || d.classification === 'select')
      .map(d => d.suggestedCsvColumn);

    const csvDatasets = csvColumns.length > 0 ? [{
      filename: `data/${session.journeyCode.toLowerCase()}_data.csv`,
      variable_names: csvColumns,
      delimiter: ',',
      has_header: true,
      sharing_mode: 'shareMode.all',
      recycle: true,
      stop_thread: false,
    }] : [];

    const manifest = {
      system_code: systemCode,
      scripts: [{
        code: session.journeyCode,
        name: session.journeyCode,
        file: `scripts/${session.journeyCode}.jmx`,
        description: `Recorded from ${session.baseUrl} — ${session.transactions.length} steps`,
        request_count: allRequests.length,
        has_own_think_time: true,
        endpoints,
        protocol: session.protocol || 'https',
        variables_required: variablesRequired,
        variables_internal: variablesInternal,
        properties: [
          { name: 'TARGET_HOST', default_value: session.targetHost },
          { name: 'TARGET_PORT', default_value: session.port || '443' },
        ],
        csv_datasets: csvDatasets,
        assertions: assertions.map(a => ({
          type: a.type,
          field: a.field || 'response_data',
          expected: a.expected,
        })),
        tags: ['recorder-generated'],
      }],
    };

    const manResp = await assureFetch('/nfr-perftest/api/v1/scripts/manifest', {
      method: 'POST',
      body: JSON.stringify(manifest),
    });
    const manCt = manResp.headers.get('content-type') || '';
    if (manResp.ok) {
      console.log('Manifest pushed');
    } else if (manCt.includes('json')) {
      const manData = await manResp.json();
      errors.push('Manifest: ' + (manData.message || manData.error || manResp.status));
    } else {
      errors.push('Manifest: HTTP ' + manResp.status);
    }

    // Report results
    if (errors.length === 0) {
      btn.textContent = 'Pushed';
    } else {
      btn.textContent = 'Partial';
      alert('Some pushes failed:\n' + errors.join('\n'));
    }
  } catch (err) {
    btn.textContent = 'Push to Assure';
    alert('Push failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

$('cr-push-nhs').addEventListener('click', async () => {
  if (!currentAuth?.token) {
    showLoginForm();
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'get-session' });
  if (!result.session) return;
  const session = result.session;
  const btn = $('cr-push-nhs');
  btn.textContent = 'Pushing...';
  btn.disabled = true;
  try {
    // Push recording to NHS Dashboard
    const resp = await nhsFetch('/api/v1/recordings', {
      method: 'POST',
      body: JSON.stringify({ recording: session }),
    });
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok) {
      btn.textContent = 'Pushed';
    } else if (!ct.includes('json')) {
      btn.textContent = 'Push to NHS Dashboard';
      alert('NHS Dashboard is not available. Check that the dashboard is running.');
    } else {
      const data = await resp.json();
      btn.textContent = 'Push to NHS Dashboard';
      alert('Push failed: ' + (data.message || data.error || resp.status));
    }
  } catch (err) {
    btn.textContent = 'Push to NHS Dashboard';
    alert('NHS Dashboard is not available: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Auth event listeners ─────────────────────────────────────

$('cr-auth-signin').addEventListener('click', async () => {
  const email = $('cr-auth-email').value.trim();
  const password = $('cr-auth-password').value;
  if (!email || !password) {
    $('cr-auth-error').textContent = 'Enter email and password';
    $('cr-auth-error').style.display = '';
    return;
  }
  $('cr-auth-signin').textContent = 'Signing in...';
  $('cr-auth-signin').disabled = true;
  try {
    await doLogin(email, password);
    hideLoginForm();
  } catch (err) {
    $('cr-auth-error').textContent = err.message;
    $('cr-auth-error').style.display = '';
  } finally {
    $('cr-auth-signin').textContent = 'Sign in';
    $('cr-auth-signin').disabled = false;
  }
});

$('cr-auth-register').addEventListener('click', async () => {
  const email = $('cr-auth-email').value.trim();
  const password = $('cr-auth-password').value;
  if (!email || !password) {
    $('cr-auth-error').textContent = 'Enter email and password';
    $('cr-auth-error').style.display = '';
    return;
  }
  if (password.length < 8) {
    $('cr-auth-error').textContent = 'Password must be at least 8 characters';
    $('cr-auth-error').style.display = '';
    return;
  }
  $('cr-auth-register').textContent = 'Creating...';
  $('cr-auth-register').disabled = true;
  try {
    await doRegister(email, password);
    hideLoginForm();
  } catch (err) {
    $('cr-auth-error').textContent = err.message;
    $('cr-auth-error').style.display = '';
  } finally {
    $('cr-auth-register').textContent = 'Create account';
    $('cr-auth-register').disabled = false;
  }
});

// ── OAuth flow (shared by Google + Microsoft) ────────────────

async function doOAuthLogin(providerId) {
  $('cr-auth-error').style.display = 'none';

  // 1. Fetch provider config from Assure
  const resp = await assureFetch('/api/v1/auth/providers');
  if (!resp.ok) throw new Error('Could not fetch auth providers');
  const { providers } = await resp.json();
  const provider = providers.find(p => p.id === providerId);
  if (!provider) throw new Error(`Provider "${providerId}" not available`);

  // 2. Build OAuth authorize URL
  const redirectUrl = chrome.identity.getRedirectURL('callback');
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: provider.client_id,
    response_type: 'code',
    redirect_uri: redirectUrl,
    scope: provider.scopes,
    state,
    nonce,
    prompt: 'select_account',
  });
  const authUrl = `${provider.auth_endpoint}?${params}`;

  // 3. Launch OAuth popup — user signs in with Google/Microsoft
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  // 4. Extract auth code from callback URL
  const callbackUrl = new URL(responseUrl);
  const code = callbackUrl.searchParams.get('code');
  const returnedState = callbackUrl.searchParams.get('state');
  if (!code) throw new Error('No authorization code returned');
  if (returnedState !== state) throw new Error('State mismatch — possible CSRF');

  // 5. Exchange code for Contexta JWT via Assure backend
  const exchangeResp = await assureFetch('/api/v1/auth/oauth', {
    method: 'POST',
    body: JSON.stringify({
      provider: providerId,
      code,
      redirect_uri: redirectUrl,
    }),
  });
  const data = await exchangeResp.json();
  if (!exchangeResp.ok) throw new Error(data.message || 'OAuth exchange failed');

  // 6. Save auth and update UI
  currentAuth = { token: data.token, user: data.user, expires_at: data.expires_at };
  await saveAuth(currentAuth);
  renderAuthState(currentAuth.user);
  hideLoginForm();
}

$('cr-auth-google').addEventListener('click', async () => {
  const btn = $('cr-auth-google');
  btn.textContent = 'Signing in...';
  btn.disabled = true;
  try {
    await doOAuthLogin('google');
  } catch (err) {
    $('cr-auth-error').textContent = err.message;
    $('cr-auth-error').style.display = '';
  } finally {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google`;
    btn.disabled = false;
  }
});

$('cr-auth-sso').addEventListener('click', async () => {
  const btn = $('cr-auth-sso');
  btn.innerHTML = 'Signing in...';
  btn.disabled = true;
  try {
    await doOAuthLogin('microsoft');
  } catch (err) {
    $('cr-auth-error').textContent = err.message;
    $('cr-auth-error').style.display = '';
  } finally {
    btn.innerHTML = `<svg viewBox="0 0 21 21" width="18" height="18"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg> Continue with Microsoft`;
    btn.disabled = false;
  }
});

$('cr-auth-cancel').addEventListener('click', (e) => {
  e.preventDefault();
  hideLoginForm();
});

$('cr-auth-signout').addEventListener('click', async (e) => {
  e.preventDefault();
  await logout();
});

// Auth prompt in results
$('cr-auth-prompt-link').addEventListener('click', (e) => {
  e.preventDefault();
  showLoginForm();
});

// Allow Enter key to submit login
$('cr-auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('cr-auth-signin').click();
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

function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true });
}

// Init
initAuth();
updateUI();
