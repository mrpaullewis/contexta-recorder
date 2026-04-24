/**
 * Background service worker — manages recording lifecycle.
 *
 * Coordinates between:
 * - Popup (user controls: start/stop/pause, new transaction)
 * - Content script (form fields, page info)
 * - Debugger API (network capture)
 * - Storage (persisting sessions)
 */
import { State, MAX_BODY_SNIPPET, PULL_API_VERSION, SUPPORTED_FORMATS } from '../shared/constants.js';
import * as storage from '../shared/storage.js';
import {
  createSession, startTransaction, endTransaction,
  processRequest, processResponse, autoTransactionName,
  findEntryByRequestId, findLastPostInTransaction,
} from './recorder.js';
import { detectCorrelations } from './correlator.js';
import { classifyFields } from '../shared/field-classifier.js';
import { generateAssertions } from '../shared/assertion-generator.js';
import { generateSessionFingerprints } from '../shared/config.js';
import { generateJmx } from '../shared/jmx-generator.js';
import { generateHar } from '../shared/har-export.js';

let currentState = State.IDLE;
let session = null;
let debuggerTabId = null;

/**
 * Start recording on the active tab.
 */
async function startRecording(tabId, journeyCode, mode) {
  if (currentState !== State.IDLE) return { error: 'Already recording' };

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://')) {
    return { error: 'Cannot record on this page' };
  }

  session = createSession(journeyCode, tab.url);
  session.mode = mode || 'transaction';
  debuggerTabId = tabId;

  // Load user options into session for naming convention etc.
  const opts = await storage.getOptions();
  session.options = {
    namingConvention: opts.namingConvention || 'slug',
    stepPadding: opts.stepPadding || 2,
  };

  // Attach debugger to capture network traffic with response bodies
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxPostDataSize: 65536,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', {
      cacheDisabled: true,
    });
  } catch (err) {
    session = null;
    debuggerTabId = null;
    return { error: 'Failed to attach debugger: ' + err.message };
  }

  currentState = State.RECORDING;
  await storage.setState(currentState);
  await storage.saveSession(session);

  // Start first transaction if in transaction mode
  if (session.mode === 'transaction') {
    startTransaction(session);
  }

  updateBadge();
  return { ok: true, sessionId: session.id };
}

/**
 * Stop recording and detach debugger.
 */
async function stopRecording() {
  if (currentState === State.IDLE) return { error: 'Not recording' };

  endTransaction(session);
  session.endTime = new Date().toISOString();

  // Detach debugger
  if (debuggerTabId) {
    try {
      await chrome.debugger.detach({ tabId: debuggerTabId });
    } catch { /* tab may have closed */ }
    debuggerTabId = null;
  }

  // Run Phase 2 analysis engine
  try {
    session.correlations = detectCorrelations(session);
    session.dataRequirements = classifyFields(session);
    session.assertions = generateAssertions(session);
    session.fingerprints = generateSessionFingerprints(session);
  } catch (err) {
    console.error('Analysis engine error:', err);
    // Ensure arrays exist even if analysis fails
    session.correlations = session.correlations || [];
    session.dataRequirements = session.dataRequirements || [];
    session.assertions = session.assertions || [];
    session.fingerprints = session.fingerprints || [];
  }

  // Save completed session with analysis results.
  // Single-recording model: starting a new recording replaces this one.
  await storage.saveSession(session);

  const result = { ok: true, session };
  currentState = State.IDLE;
  await storage.setState(currentState);
  updateBadge();
  return result;
}

/**
 * Pause/resume recording.
 */
async function togglePause() {
  if (currentState === State.RECORDING) {
    currentState = State.PAUSED;
  } else if (currentState === State.PAUSED) {
    currentState = State.RECORDING;
  } else {
    return { error: 'Not recording' };
  }
  await storage.setState(currentState);
  updateBadge();
  return { ok: true, state: currentState };
}

/**
 * Start a new transaction (user clicked "New Transaction").
 */
async function newTransaction(name) {
  if (!session || currentState === State.IDLE) return { error: 'Not recording' };
  endTransaction(session);
  const tx = startTransaction(session, name);
  await storage.saveSession(session);
  return { ok: true, transaction: tx };
}

/**
 * Handle debugger events (network traffic).
 */
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!session || currentState !== State.RECORDING) return;
  if (source.tabId !== debuggerTabId) return;

  if (method === 'Network.requestWillBeSent') {
    // Check if this is a redirect — processRequest will save the original request
    const hadRedirect = params.redirectResponse && session.pendingRequests[params.requestId];
    processRequest(session, params);

    // Notify popup about the saved redirect (POST) entry
    if (hadRedirect) {
      const savedPost = findLastPostInTransaction(session);
      if (savedPost) {
        chrome.runtime.sendMessage({
          type: 'request-captured',
          request: {
            seq: savedPost.seq,
            method: savedPost.method,
            path: savedPost.path,
            status: savedPost.response?.status,
            transaction: session.currentTransaction?.name,
          },
        }).catch(() => {});
      }
    }
  }

  if (method === 'Network.responseReceived') {
    processResponse(session, params, '');
  }

  if (method === 'Network.loadingFinished') {
    // Fetch response body after loading completes (more reliable than responseReceived)
    const entry = findEntryByRequestId(session, params.requestId);
    if (entry) {
      let body = '';
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: debuggerTabId },
          'Network.getResponseBody',
          { requestId: params.requestId },
        );
        body = result.body || '';
        if (result.base64Encoded) {
          body = ''; // skip binary content
        }
      } catch {
        // Response body may not be available (e.g. redirects)
      }
      if (body) {
        entry.response.bodySnippet = body.substring(0, MAX_BODY_SNIPPET);

        // Save full response body for ALL non-static responses
        // The builder needs complete data for correlation detection and assertions
        session.pageResponses.push({
          seq: entry.seq,
          url: entry.url,
          path: entry.path,
          transaction: session.currentTransaction?.name || '',
          contentType: entry.response?.contentType || '',
          status: entry.response?.status,
          size: body.length,
          body,
        });
      }
      await storage.saveSession(session);
      // Notify popup of new request
      chrome.runtime.sendMessage({
        type: 'request-captured',
        request: {
          seq: entry.seq,
          method: entry.method,
          path: entry.path,
          status: entry.response?.status,
          transaction: session.currentTransaction?.name,
        },
      }).catch(() => {});
    }
  }

  // Auto-transaction on navigation
  // Split when we see a new Document navigation. Two cases:
  // 1. A redirect-GET (POST→302→GET) — the redirect params carry redirectResponse
  //    The POST was already saved by processRequest into the current transaction.
  //    Start a new transaction named after the GET destination.
  // 2. A direct GET Document (e.g. clicking a link, not a form POST)
  if (method === 'Network.requestWillBeSent' && session.mode === 'auto') {
    if (params.type === 'Document') {
      if (params.redirectResponse) {
        // This is the GET after a POST→302. The POST is already in the current tx.
        // Start a new transaction for the page we're landing on.
        endTransaction(session);
        startTransaction(session, autoTransactionName(session, params.request.url));
      } else if (params.request.method === 'GET' && !params.redirectResponse) {
        // Direct GET navigation (link click, initial page load)
        endTransaction(session);
        startTransaction(session, autoTransactionName(session, params.request.url));
      }
      // POST without redirect — don't split, it belongs to the current page's submission
    }
  }
});

/**
 * Handle messages from popup and content script.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'start-recording':
        sendResponse(await startRecording(msg.tabId, msg.journeyCode, msg.mode));
        break;
      case 'stop-recording':
        sendResponse(await stopRecording());
        break;
      case 'toggle-pause':
        sendResponse(await togglePause());
        break;
      case 'new-transaction':
        sendResponse(await newTransaction(msg.name));
        break;
      case 'get-status':
        sendResponse({
          state: currentState,
          session: session ? {
            id: session.id,
            journeyCode: session.journeyCode,
            transactionCount: session.transactions.length,
            requestCount: session.transactions.reduce((s, t) => s + t.requests.length, 0),
            currentTransaction: session.currentTransaction?.name || null,
            startTime: session.startTime,
          } : null,
        });
        break;
      case 'get-session':
        sendResponse({ session });
        break;
      case 'page-info':
        // Content script sending page metadata
        if (session && session.currentTransaction) {
          const reqs = session.currentTransaction.requests;
          if (reqs.length > 0) {
            const last = reqs[reqs.length - 1];
            last.pageTitle = msg.title || last.pageTitle;
            last.pageHeading = msg.heading || last.pageHeading;
            if (msg.formFields && msg.formFields.length) {
              last.formFields = msg.formFields;
            }
          }
          await storage.saveSession(session);
        }
        sendResponse({ ok: true });
        break;
      case 'page-analysis':
        // Page analyser sending deeper page structure
        if (session && session.currentTransaction) {
          const reqs = session.currentTransaction.requests;
          if (reqs.length > 0) {
            const last = reqs[reqs.length - 1];
            last.pageAnalysis = msg.analysis;
            // Use analyser heading if content script didn't capture one
            if (!last.pageHeading && msg.analysis?.heading) {
              last.pageHeading = msg.analysis.heading;
            }
          }
          await storage.saveSession(session);
        }
        sendResponse({ ok: true });
        break;
      case 'form-submitted':
        // Content script intercepted a form submission — update field values
        if (session && session.currentTransaction) {
          const reqs = session.currentTransaction.requests;
          if (reqs.length > 0) {
            const last = reqs[reqs.length - 1];
            if (msg.fields && msg.fields.length) {
              // Merge submitted values into existing form fields
              for (const submitted of msg.fields) {
                const existing = last.formFields?.find(f => f.name === submitted.name);
                if (existing) {
                  existing.value = submitted.value;
                } else {
                  last.formFields = last.formFields || [];
                  last.formFields.push(submitted);
                }
              }
            }
          }
          await storage.saveSession(session);
        }
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();
  return true; // keep channel open for async response
});

/**
 * Handle debugger detach (user closed DevTools or navigated away).
 */
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId === debuggerTabId && currentState !== State.IDLE) {
    await stopRecording();
  }
});

/**
 * Update extension badge to show recording state.
 */
function updateBadge() {
  if (currentState === State.RECORDING) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  } else if (currentState === State.PAUSED) {
    chrome.action.setBadgeText({ text: '||' });
    chrome.action.setBadgeBackgroundColor({ color: '#f9a825' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Open welcome page on first install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
});

// Restore state on service worker startup
(async () => {
  currentState = await storage.getState();
  session = await storage.getSession();
  updateBadge();
})();

// ── External pull API (v0.2.0) ───────────────────────────────
// Responds to messages from origins whitelisted in manifest
// `externally_connectable.matches`. Chrome enforces the origin check
// at the IPC layer — any message reaching this handler is already
// from an approved origin. See docs/PULL-INTEGRATION-SPEC.md.

const MAX_PAYLOAD_BYTES = 60 * 1024 * 1024; // under Chrome's ~64MB IPC cap

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') {
    sendResponse({ error: 'invalid_request', message: 'Message must have an action field.' });
    return false;
  }

  (async () => {
    try {
      switch (message.action) {
        case 'ping':
          sendResponse({
            installed: true,
            version: PULL_API_VERSION,
            supportedFormats: SUPPORTED_FORMATS,
            supportedJmxModes: ['fragment', 'standalone'],
          });
          break;
        case 'listRecordings':
          sendResponse(await handleListRecordings());
          break;
        case 'getRecording':
          sendResponse(await handleGetRecording(message));
          break;
        default:
          sendResponse({ error: 'invalid_request', message: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      console.error('[pull-api] handler error:', err);
      sendResponse({ error: 'generator_error', message: err.message || String(err) });
    }
  })();

  return true; // keep channel open for async response
});

async function handleListRecordings() {
  // Single-recording model: only the current session (if ended) is pullable.
  const current = await storage.getSession();
  if (!current || !current.endTime) return { recordings: [] };

  return {
    recordings: [{
      id: current.id,
      name: current.name || current.journeyCode || 'Untitled',
      journeyCode: current.journeyCode,
      createdAt: current.startTime,
      endedAt: current.endTime,
      transactionCount: current.transactions?.length || 0,
      requestCount: (current.transactions || []).reduce((n, t) => n + (t.requests?.length || 0), 0),
      correlationCount: current.correlations?.length || 0,
      dataFieldCount: current.dataRequirements?.length || 0,
      sizeBytes: estimateSessionSize(current),
    }],
  };
}

async function handleGetRecording(message) {
  const { id, format, options = {} } = message;
  if (!id) return { error: 'invalid_request', message: 'id is required' };
  if (!format) return { error: 'invalid_request', message: 'format is required' };
  if (!SUPPORTED_FORMATS.includes(format)) {
    return { error: 'invalid_format', message: `Format must be one of: ${SUPPORTED_FORMATS.join(', ')}` };
  }

  const recording = await findSessionById(id);
  if (!recording) return { error: 'not_found', message: `No recording with id: ${id}` };

  let content, filename, contentType;
  const code = recording.journeyCode || 'recording';

  switch (format) {
    case 'json':
      content = JSON.stringify(recording, null, 2);
      filename = `${code}_recording.json`;
      contentType = 'application/json';
      break;
    case 'jmx': {
      const mode = options.mode || 'fragment';
      if (!['fragment', 'standalone'].includes(mode)) {
        return { error: 'invalid_options', message: `Invalid JMX mode: ${mode}` };
      }
      content = generateJmx(recording, { mode });
      filename = `${code}${mode === 'fragment' ? '' : '_standalone'}.jmx`;
      contentType = 'application/octet-stream';
      break;
    }
    case 'har':
      content = JSON.stringify(generateHar(recording), null, 2);
      filename = `${code}_recording.har`;
      contentType = 'application/json';
      break;
    case 'csv': {
      const dataReqs = recording.dataRequirements || [];
      if (dataReqs.length === 0) {
        return { error: 'no_data_fields', message: 'No form fields detected; CSV unavailable.' };
      }
      const headers = dataReqs.map(d => d.suggestedCsvColumn);
      const values = dataReqs.map(d => csvEscapeValue(d.sampleValue || ''));
      content = headers.join(',') + '\n' + values.join(',') + '\n';
      filename = `${code}_test_data.csv`;
      contentType = 'text/csv';
      break;
    }
  }

  const payloadBytes = new Blob([content]).size;
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return {
      error: 'too_large',
      message: `Recording is ${Math.round(payloadBytes / 1024 / 1024)}MB, exceeds ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB IPC limit.`,
    };
  }

  return { format, filename, contentType, content };
}

async function findSessionById(id) {
  const current = await storage.getSession();
  if (current && current.id === id) return current;
  return null;
}

function estimateSessionSize(recording) {
  let size = 0;
  for (const pr of recording.pageResponses || []) {
    size += (pr.body?.length || 0);
  }
  for (const tx of recording.transactions || []) {
    for (const r of tx.requests || []) {
      size += (r.requestBody?.length || 0) + (r.responseBody?.length || 0);
    }
  }
  return size;
}

function csvEscapeValue(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
