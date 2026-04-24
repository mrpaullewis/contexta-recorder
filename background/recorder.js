/**
 * Recording engine — intercepts HTTP requests/responses via chrome.debugger.
 *
 * Uses the Debugger API (Chrome DevTools Protocol) rather than webRequest
 * because it gives access to response bodies, which we need for correlation
 * detection. webRequest alone cannot read response content in Manifest V3.
 */
import {
  STATIC_EXTENSIONS, STATIC_PATH_SEGMENTS, STATIC_CONTENT_TYPES,
  DEFAULT_EXCLUDED_DOMAINS, INTERNAL_SCHEMES, MAX_BODY_SNIPPET,
} from '../shared/constants.js';

/**
 * Create a new empty recording session.
 */
export function createSession(journeyCode, baseUrl) {
  const parsed = new URL(baseUrl);
  return {
    id: crypto.randomUUID(),
    journeyCode: journeyCode || 'UJ01',
    startTime: new Date().toISOString(),
    endTime: null,
    baseUrl,
    targetHost: parsed.hostname,
    protocol: parsed.protocol.replace(':', ''),
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    transactions: [],
    currentTransaction: null,
    seq: 0,
    pendingRequests: {},    // requestId -> partial request data
    pageResponses: [],       // full HTML of Document responses, used for correlation
    excludedDomains: [...DEFAULT_EXCLUDED_DOMAINS],
    options: {},
  };
}

/**
 * Format a step number with the session's configured padding.
 */
function formatStep(session, stepNum) {
  const pad = session.options?.stepPadding || 2;
  return `S${String(stepNum).padStart(pad, '0')}`;
}

/**
 * Start a new transaction (UJ step) within the session.
 */
export function startTransaction(session, name) {
  const stepNum = session.transactions.length + 1;
  const code = session.journeyCode;
  const tx = {
    code,
    stepNumber: stepNum,
    name: name || `${code}_${formatStep(session, stepNum)}`,
    startTime: new Date().toISOString(),
    endTime: null,
    requests: [],
  };
  session.transactions.push(tx);
  session.currentTransaction = tx;
  return tx;
}

/**
 * End the current transaction.
 */
export function endTransaction(session) {
  if (session.currentTransaction) {
    session.currentTransaction.endTime = new Date().toISOString();
    session.currentTransaction = null;
  }
}

/**
 * Auto-name a transaction from a page URL, respecting naming convention.
 */
export function autoTransactionName(session, url) {
  const stepNum = session.transactions.length + 1;
  const code = session.journeyCode;
  const convention = session.options?.namingConvention || 'slug';
  const step = formatStep(session, stepNum);
  const path = new URL(url).pathname;
  const slug = path.split('/').filter(Boolean).pop() || 'index';

  if (convention === 'plain') return `${code}_${step}`;
  // 'slug' appends the URL slug to the step name
  return `${code}_${step}_${slug}`;
}

/**
 * Check if a URL should be recorded.
 */
export function shouldRecord(url, session) {
  // Skip internal schemes
  for (const scheme of INTERNAL_SCHEMES) {
    if (url.startsWith(scheme)) return false;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Skip excluded domains
  const hostname = parsed.hostname.toLowerCase();
  for (const domain of session.excludedDomains) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return false;
  }

  // Skip static extensions
  const path = parsed.pathname.toLowerCase();
  const ext = path.substring(path.lastIndexOf('.'));
  if (STATIC_EXTENSIONS.has(ext)) return false;

  // Skip static path segments
  for (const seg of STATIC_PATH_SEGMENTS) {
    if (path.includes(seg)) return false;
  }

  return true;
}

/**
 * Check if a response content-type is static (should be skipped).
 */
export function isStaticContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  for (const pattern of STATIC_CONTENT_TYPES) {
    if (ct.startsWith(pattern)) return true;
  }
  return false;
}

/**
 * Process a captured request (from debugger Network.requestWillBeSent).
 *
 * Handles redirects: when a POST 302-redirects to a GET, Chrome reuses the
 * same requestId. The redirect carries a `redirectResponse` in params.
 * We save the original POST as a completed entry before creating the new GET.
 */
export function processRequest(session, params) {
  const { requestId, request, timestamp, type, redirectResponse } = params;
  const url = request.url;

  // If this is a redirect, save the original request (e.g. POST) before it's overwritten
  if (redirectResponse && session.pendingRequests[requestId]) {
    const original = session.pendingRequests[requestId];
    // Capture the redirect Location — needed for branching in the builder
    const redirectHeaders = redirectResponse.headers || {};
    let redirectLocation = '';
    for (const [key, val] of Object.entries(redirectHeaders)) {
      if (key.toLowerCase() === 'location') { redirectLocation = val; break; }
    }

    original.response = {
      status: redirectResponse.status,
      statusText: redirectResponse.statusText || '',
      headers: redirectHeaders,
      redirectLocation,
      contentType: redirectResponse.mimeType || '',
      bodySnippet: '', // redirects have no body
      timing: redirectResponse.timing ? {
        dns: Math.round((redirectResponse.timing.dnsEnd - redirectResponse.timing.dnsStart) || 0),
        connect: Math.round((redirectResponse.timing.connectEnd - redirectResponse.timing.connectStart) || 0),
        ssl: Math.round((redirectResponse.timing.sslEnd - redirectResponse.timing.sslStart) || 0),
        ttfb: Math.round(redirectResponse.timing.receiveHeadersEnd || 0),
        total: 0,
      } : null,
      size: redirectResponse.encodedDataLength || 0,
    };

    // Clear requestId so loadingFinished doesn't write the next page's body here
    original.requestId = `redirect_${original.requestId}`;

    // Add the original request to the current transaction
    if (!session.currentTransaction) {
      startTransaction(session, autoTransactionName(session, original.url));
    }
    session.currentTransaction.requests.push(original);
    delete session.pendingRequests[requestId];
  }

  if (!shouldRecord(url, session)) return null;

  const parsed = new URL(url);
  const entry = {
    seq: session.seq++,
    requestId,
    method: request.method,
    url,
    path: parsed.pathname + (parsed.search || ''),
    headers: request.headers || {},
    queryParams: Object.fromEntries(parsed.searchParams),
    body: request.postData || null,
    bodyType: null,
    timestamp: new Date(timestamp * 1000).toISOString(),
    resourceType: type,
    response: null,
    formFields: [],       // populated by content script
    pageTitle: '',        // populated by content script
    pageHeading: '',      // populated by content script
  };

  // Determine body type
  if (entry.body) {
    const ct = (request.headers['Content-Type'] || request.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/x-www-form-urlencoded')) {
      entry.bodyType = 'form-urlencoded';
    } else if (ct.includes('application/json')) {
      entry.bodyType = 'json';
    } else if (ct.includes('multipart/form-data')) {
      entry.bodyType = 'multipart';
    }
  }

  // Store as pending until response arrives
  session.pendingRequests[requestId] = entry;
  return entry;
}

/**
 * Process a captured response (from debugger Network.responseReceived).
 */
export function processResponse(session, params, responseBody) {
  const { requestId, response, timestamp } = params;
  const entry = session.pendingRequests[requestId];
  if (!entry) return null;

  // Skip static content types
  if (isStaticContentType(response.mimeType)) {
    delete session.pendingRequests[requestId];
    return null;
  }

  entry.response = {
    status: response.status,
    statusText: response.statusText || '',
    headers: response.headers || {},
    contentType: response.mimeType || '',
    bodySnippet: responseBody ? responseBody.substring(0, MAX_BODY_SNIPPET) : '',
    timing: response.timing ? {
      dns: Math.round((response.timing.dnsEnd - response.timing.dnsStart) || 0),
      connect: Math.round((response.timing.connectEnd - response.timing.connectStart) || 0),
      ssl: Math.round((response.timing.sslEnd - response.timing.sslStart) || 0),
      ttfb: Math.round(response.timing.receiveHeadersEnd || 0),
      total: timestamp ? Math.round((timestamp * 1000) - new Date(entry.timestamp).getTime()) : 0,
    } : null,
    size: response.encodedDataLength || 0,
  };

  // Add to current transaction (or create default one)
  if (!session.currentTransaction) {
    startTransaction(session, autoTransactionName(session, entry.url));
  }
  session.currentTransaction.requests.push(entry);

  // Clean up pending
  delete session.pendingRequests[requestId];
  return entry;
}

/**
 * Find a request entry by its debugger requestId across all transactions.
 */
export function findEntryByRequestId(session, requestId) {
  for (const tx of session.transactions) {
    for (const req of tx.requests) {
      if (req.requestId === requestId) return req;
    }
  }
  return null;
}

/**
 * Find the last POST request in the current (or most recent) transaction.
 * Used to get the POST entry saved by the redirect handler.
 */
export function findLastPostInTransaction(session) {
  const tx = session.currentTransaction || session.transactions[session.transactions.length - 1];
  if (!tx) return null;
  for (let i = tx.requests.length - 1; i >= 0; i--) {
    if (tx.requests[i].method === 'POST') return tx.requests[i];
  }
  return null;
}

/**
 * Parse form-urlencoded body into field name/value pairs.
 */
export function parseFormBody(body) {
  if (!body) return [];
  const pairs = [];
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      pairs.push({ name: decodeURIComponent(part), value: '' });
    } else {
      pairs.push({
        name: decodeURIComponent(part.substring(0, eq)),
        value: decodeURIComponent(part.substring(eq + 1)),
      });
    }
  }
  return pairs;
}
