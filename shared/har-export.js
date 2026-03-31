/**
 * HAR 1.2 export — converts a recorded session to standard HAR format.
 * https://w3c.github.io/web-performance/specs/HAR/Overview.html
 */

/**
 * Generate a HAR object from a recorded session.
 */
export function generateHar(session) {
  const entries = [];

  for (const tx of session.transactions) {
    for (const req of tx.requests) {
      entries.push(buildHarEntry(req));
    }
  }

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Contexta Performance Recorder',
        version: '0.1.0',
      },
      pages: session.transactions.map((tx, i) => ({
        startedDateTime: tx.startTime,
        id: `page_${i}`,
        title: tx.name,
        pageTimings: {
          onLoad: -1,
        },
      })),
      entries,
    },
  };
}

function buildHarEntry(req) {
  const response = req.response || {};
  const timing = response.timing || {};

  return {
    startedDateTime: req.timestamp,
    time: timing.total || 0,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: objToNameValue(req.headers),
      queryString: Object.entries(req.queryParams || {}).map(([name, value]) => ({ name, value })),
      postData: req.body ? {
        mimeType: req.bodyType === 'json' ? 'application/json'
          : req.bodyType === 'form-urlencoded' ? 'application/x-www-form-urlencoded'
          : 'text/plain',
        text: req.body,
        params: req.bodyType === 'form-urlencoded' ? parseParams(req.body) : [],
      } : undefined,
      headersSize: -1,
      bodySize: req.body ? req.body.length : 0,
    },
    response: {
      status: response.status || 0,
      statusText: response.statusText || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: objToNameValue(response.headers || {}),
      content: {
        size: response.size || 0,
        mimeType: response.contentType || '',
        text: response.bodySnippet || '',
      },
      redirectURL: getRedirectUrl(response),
      headersSize: -1,
      bodySize: response.size || 0,
    },
    cache: {},
    timings: {
      dns: timing.dns || -1,
      connect: timing.connect || -1,
      ssl: timing.ssl || -1,
      send: 0,
      wait: timing.ttfb || 0,
      receive: Math.max(0, (timing.total || 0) - (timing.ttfb || 0)),
    },
  };
}

function objToNameValue(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function parseParams(body) {
  if (!body) return [];
  return body.split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return { name: decodeURIComponent(pair), value: '' };
    return {
      name: decodeURIComponent(pair.substring(0, eq)),
      value: decodeURIComponent(pair.substring(eq + 1)),
    };
  });
}

function getRedirectUrl(response) {
  if (!response.headers) return '';
  for (const [key, val] of Object.entries(response.headers)) {
    if (key.toLowerCase() === 'location') return val;
  }
  return '';
}
