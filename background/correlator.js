/**
 * Correlation detection engine.
 *
 * Uses saved page responses (full Document HTML) to find where dynamic
 * values originate, then tracks them forward into POST submissions.
 *
 * Flow:
 * 1. Scan each page response for dynamic values (hidden inputs, radio/select
 *    values, JSON data)
 * 2. For each value found, search forward through subsequent POST requests
 *    to see if it was submitted
 * 3. If submitted, it's a correlation that needs extracting in the test script
 *
 * Also detects session cookies and dynamic redirect targets.
 */
import {
  CSRF_FIELD_NAMES, SESSION_COOKIE_PATTERNS,
} from '../shared/constants.js';

/**
 * Run full correlation analysis on a completed session.
 */
export function detectCorrelations(session) {
  const correlations = [];

  correlations.push(...detectFromPageResponses(session));
  correlations.push(...detectSessionCookies(session));
  correlations.push(...detectDynamicRedirects(session));

  // Merge correlations with the same name — combine usedInRequests
  const merged = new Map();
  for (const c of correlations) {
    if (merged.has(c.name)) {
      const existing = merged.get(c.name);
      for (const use of c.usedInRequests) {
        if (!existing.usedInRequests.some(u => u.seq === use.seq)) {
          existing.usedInRequests.push(use);
        }
      }
      if (!existing.allSources) existing.allSources = [{ transaction: existing.sourceTransaction, seq: existing.sourceRequestSeq }];
      existing.allSources.push({ transaction: c.sourceTransaction, seq: c.sourceRequestSeq });
    } else {
      merged.set(c.name, { ...c });
    }
  }
  return [...merged.values()];
}

/**
 * Core correlation detector — page-response driven.
 *
 * For each saved page response, extract all dynamic values (hidden inputs,
 * radio buttons, select options, CSRF tokens). Then look forward through
 * POST requests to find where those values get submitted.
 */
function detectFromPageResponses(session) {
  const correlations = [];
  const allRequests = flattenRequests(session);
  const pageResponses = session.pageResponses || [];

  // Pre-parse ALL POST bodies once — build lookup indexes
  // byNameValue: "fieldName=value" → [{transaction, seq, field}]
  // byValue: "longValue" → [{transaction, seq, field}]
  const postIndex = buildPostIndex(allRequests);

  for (let p = 0; p < pageResponses.length; p++) {
    const page = pageResponses[p];
    const pageBody = page.body;
    if (!pageBody) continue;

    // Extract all dynamic values from this page
    const extractedValues = extractDynamicValues(pageBody);

    for (const extracted of extractedValues) {
      if (isStaticValue(extracted.value)) continue;

      // Fast lookup instead of scanning all requests
      const consumers = findConsumersIndexed(postIndex, page.seq, extracted.name, extracted.value);
      if (consumers.length === 0) continue;

      const fieldNameLower = extracted.name.toLowerCase();
      const isCsrf = CSRF_FIELD_NAMES.has(fieldNameLower);

      let type = 'dynamic_id';
      if (isCsrf) type = 'csrf';
      else if (fieldNameLower.includes('viewstate')) type = 'viewstate';

      correlations.push({
        name: sanitiseVarName(extracted.name),
        type,
        extractType: 'regex',
        extractRegex: extracted.regex,
        extractJsonPath: null,
        sourceTransaction: page.transaction,
        sourceRequestSeq: page.seq,
        sourceUrl: page.url,
        sourceLocation: extracted.location,
        sampleValue: extracted.value.substring(0, 80),
        usedInRequests: consumers,
      });
    }

    // Also check for JSON embedded in the page (script blocks, data attributes)
    const jsonCorrelations = extractJsonCorrelations(pageBody, page, allRequests);
    correlations.push(...jsonCorrelations);
  }

  return correlations;
}

/**
 * Pre-parse all POST bodies into lookup indexes.
 * Called once, then used for O(1) lookups instead of O(n) scans.
 */
function buildPostIndex(allRequests) {
  const byNameValue = new Map();  // "name=decodedValue" → [{transaction, seq, field}]
  const byValue = new Map();      // "decodedValue" → [{transaction, seq, field}] (for long values)

  for (const { entry, txName } of allRequests) {
    if (entry.method !== 'POST' || !entry.body) continue;

    const fields = parsePostBody(entry.body);
    for (const field of fields) {
      let decodedValue;
      try {
        decodedValue = decodeURIComponent(field.value.replace(/\+/g, ' '));
      } catch {
        decodedValue = field.value;
      }

      const nameValueKey = `${field.name}=${decodedValue}`;
      if (!byNameValue.has(nameValueKey)) byNameValue.set(nameValueKey, []);
      byNameValue.get(nameValueKey).push({ transaction: txName, seq: entry.seq, field: field.name });

      if (decodedValue.length >= 20) {
        if (!byValue.has(decodedValue)) byValue.set(decodedValue, []);
        byValue.get(decodedValue).push({ transaction: txName, seq: entry.seq, field: field.name });
      }
    }
  }

  return { byNameValue, byValue };
}

/**
 * Fast consumer lookup using pre-built index.
 */
function findConsumersIndexed(postIndex, pageSeq, fieldName, value) {
  const consumers = [];
  const seen = new Set();

  // Match by field name AND value
  const nameValueKey = `${fieldName}=${value}`;
  const nameMatches = postIndex.byNameValue.get(nameValueKey) || [];
  for (const match of nameMatches) {
    if (match.seq > pageSeq && !seen.has(match.seq)) {
      consumers.push({ transaction: match.transaction, seq: match.seq, field: match.field });
      seen.add(match.seq);
    }
  }

  // For long unique values, also match by value alone
  if (value.length >= 20) {
    const valueMatches = postIndex.byValue.get(value) || [];
    for (const match of valueMatches) {
      if (match.seq > pageSeq && !seen.has(match.seq)) {
        consumers.push({ transaction: match.transaction, seq: match.seq, field: match.field });
        seen.add(match.seq);
      }
    }
  }

  return consumers;
}

/**
 * Extract dynamic values from a page's HTML.
 * Returns array of { name, value, regex, location }.
 */
function extractDynamicValues(html) {
  const values = [];
  const seen = new Set(); // avoid duplicates

  // Hidden inputs: <input type="hidden" name="X" value="Y">
  const hiddenRe = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let match;
  while ((match = hiddenRe.exec(html)) !== null) {
    const tag = match[0];
    const name = attrValue(tag, 'name');
    const value = attrValue(tag, 'value');
    if (name && value && value.length >= 2) {
      const key = `${name}=${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        values.push({
          name,
          value,
          regex: `name="${escapeRegex(name)}"[^>]*value="([^"]+)"`,
          location: 'hidden_input',
        });
      }
    }
  }

  // Radio buttons: <input type="radio" name="X" value="Y">
  const radioRe = /<input[^>]*type=["']radio["'][^>]*>/gi;
  while ((match = radioRe.exec(html)) !== null) {
    const tag = match[0];
    const name = attrValue(tag, 'name');
    const value = attrValue(tag, 'value');
    if (name && value && value.length >= 1) {
      const key = `${name}=${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        values.push({
          name,
          value,
          regex: `name="${escapeRegex(name)}"[^>]*value="([^"]+)"`,
          location: 'form_input',
        });
      }
    }
  }

  // Select options with values (for selects that have a name attribute nearby)
  // This is harder to parse generically, so we look for select+option patterns
  const selectRe = /<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
  while ((match = selectRe.exec(html)) !== null) {
    const selectName = match[1];
    const optionsBlock = match[2];
    const optRe = /<option[^>]*value=["']([^"']+)["'][^>]*>/gi;
    let optMatch;
    while ((optMatch = optRe.exec(optionsBlock)) !== null) {
      const optValue = optMatch[1];
      if (optValue && optValue.length >= 2) {
        const key = `${selectName}=${optValue}`;
        if (!seen.has(key)) {
          seen.add(key);
          values.push({
            name: selectName,
            value: optValue,
            regex: `<option[^>]*value="([^"]+)"[^>]*>`,
            location: 'form_input',
          });
        }
      }
    }
  }

  // Meta tags with CSRF tokens
  const metaCsrfRe = /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  while ((match = metaCsrfRe.exec(html)) !== null) {
    const value = match[1];
    if (value) {
      values.push({
        name: 'csrf-token',
        value,
        regex: `<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"`,
        location: 'meta_tag',
      });
    }
  }

  return values;
}

/**
 * Search forward through requests after a page to find POSTs that submit a value.
 */
function findConsumers(allRequests, pageSeq, fieldName, value) {
  const consumers = [];

  // Decode the value for comparison (page HTML has raw values, POST bodies are URL-encoded)
  const decodedValue = value;

  for (const { entry, txName } of allRequests) {
    if (entry.seq <= pageSeq) continue;
    if (entry.method !== 'POST' || !entry.body) continue;

    const fields = parsePostBody(entry.body);
    for (const field of fields) {
      let submittedValue;
      try {
        submittedValue = decodeURIComponent(field.value.replace(/\+/g, ' '));
      } catch {
        submittedValue = field.value;
      }

      // Match by field name AND value, or just value if it's long enough to be unique
      if (field.name === fieldName && submittedValue === decodedValue) {
        consumers.push({ transaction: txName, seq: entry.seq, field: fieldName });
        break;
      }
      // For long unique values (GUIDs, tokens), match by value alone
      if (decodedValue.length >= 20 && submittedValue === decodedValue) {
        consumers.push({ transaction: txName, seq: entry.seq, field: field.name });
        break;
      }
    }
  }

  return consumers;
}

/**
 * Extract correlations from JSON blocks embedded in the page.
 */
function extractJsonCorrelations(html, page, allRequests) {
  const correlations = [];

  // Look for JSON in script tags (e.g. __NEXT_DATA__, inline config)
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const scriptContent = match[1].trim();
    // Try to find JSON objects in the script
    const jsonRe = /\{[^{}]*"[^"]+"\s*:\s*"[^"]*"[^{}]*\}/g;
    let jsonMatch;
    while ((jsonMatch = jsonRe.exec(scriptContent)) !== null) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        for (const [key, val] of Object.entries(obj)) {
          if (typeof val === 'string' && val.length >= 8 && !isStaticValue(val)) {
            const consumers = findConsumers(allRequests, page.seq, key, val);
            if (consumers.length > 0) {
              correlations.push({
                name: sanitiseVarName(key),
                type: 'dynamic_id',
                extractType: 'regex',
                extractRegex: `"${escapeRegex(key)}"\\s*:\\s*"([^"]+)"`,
                extractJsonPath: `$.${key}`,
                sourceTransaction: page.transaction,
                sourceRequestSeq: page.seq,
                sourceUrl: page.url,
                sourceLocation: 'json_body',
                sampleValue: val.substring(0, 80),
                usedInRequests: consumers,
              });
            }
          }
        }
      } catch { /* not valid JSON */ }
    }
  }

  return correlations;
}

/**
 * Detect session cookies set via Set-Cookie headers.
 */
function detectSessionCookies(session) {
  const correlations = [];
  const allRequests = flattenRequests(session);

  for (let i = 0; i < allRequests.length; i++) {
    const { entry, txName } = allRequests[i];
    const responseHeaders = entry.response?.headers || {};

    const setCookies = [];
    for (const [key, val] of Object.entries(responseHeaders)) {
      if (key.toLowerCase() === 'set-cookie') {
        for (const line of val.split('\n')) {
          setCookies.push(line.trim());
        }
      }
    }

    for (const setCookie of setCookies) {
      const eqIdx = setCookie.indexOf('=');
      if (eqIdx === -1) continue;
      const cookieName = setCookie.substring(0, eqIdx).trim();
      const cookieValue = setCookie.substring(eqIdx + 1).split(';')[0].trim();
      if (!cookieValue || cookieValue.length < 4) continue;

      const isSession = SESSION_COOKIE_PATTERNS.some(p => p.test(cookieName));
      if (!isSession) continue;

      const consumers = [];
      for (let j = i + 1; j < allRequests.length; j++) {
        const { entry: laterEntry, txName: laterTx } = allRequests[j];
        const cookieHeader = laterEntry.headers?.Cookie || laterEntry.headers?.cookie || '';
        if (cookieHeader.includes(cookieName + '=')) {
          consumers.push({ transaction: laterTx, seq: laterEntry.seq });
        }
      }

      correlations.push({
        name: sanitiseVarName(cookieName),
        type: 'cookie',
        extractType: 'header',
        extractRegex: null,
        extractJsonPath: null,
        sourceTransaction: txName,
        sourceRequestSeq: entry.seq,
        sourceLocation: 'set-cookie',
        sampleValue: cookieValue.substring(0, 80),
        cookieName,
        usedInRequests: consumers,
      });
    }
  }

  return correlations;
}

/**
 * Detect redirect targets with dynamic values (GUIDs, tokens, IDs in URLs).
 */
function detectDynamicRedirects(session) {
  const correlations = [];
  const allRequests = flattenRequests(session);

  for (let i = 0; i < allRequests.length; i++) {
    const { entry, txName } = allRequests[i];
    const status = entry.response?.status;
    if (!status || status < 300 || status >= 400) continue;

    const headers = entry.response?.headers || {};
    let location = null;
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === 'location') { location = val; break; }
    }
    if (!location) continue;

    // Store redirect location on EVERY 302 — the builder needs this for branching
    // Extract the path portion for use as redirectionLocation
    let locationPath = location;
    try {
      const parsed = new URL(location, 'https://placeholder');
      locationPath = parsed.pathname;
    } catch { /* use as-is */ }

    // Store as a redirect correlation — always, not just dynamic URLs
    correlations.push({
      name: 'redirectionLocation',
      type: 'redirect',
      extractType: 'url',
      extractRegex: '/book-a-coronavirus-vaccination/(.*)',
      extractJsonPath: null,
      sourceTransaction: txName,
      sourceRequestSeq: entry.seq,
      sourceUrl: entry.url,
      sourceLocation: 'redirect_url',
      sampleValue: locationPath.substring(0, 200),
      usedInRequests: [],
    });

    // Also create specific correlations for dynamic redirect URLs (GUIDs, params)
    if (isDynamicUrl(location) && i + 1 < allRequests.length) {
      const next = allRequests[i + 1];
      const resolved = resolveUrl(entry.url, location);
      if (next.entry.url === resolved || next.entry.url === location) {
        correlations.push({
          name: extractUrlParamName(location) || `redirect_${entry.seq}`,
          type: 'redirect',
          extractType: 'header',
          extractRegex: null,
          extractJsonPath: null,
          sourceTransaction: txName,
          sourceRequestSeq: entry.seq,
          sourceLocation: 'location_header',
          sampleValue: location.substring(0, 200),
          usedInRequests: [{ transaction: next.txName, seq: next.entry.seq }],
        });
      }
    }
  }

  return correlations;
}


// ── Helpers ──────────────────────────────────────────────────

function flattenRequests(session) {
  const result = [];
  for (const tx of session.transactions) {
    for (const req of tx.requests) {
      result.push({ entry: req, txName: tx.name });
    }
  }
  return result;
}

/**
 * Extract an HTML attribute value from a tag string.
 */
function attrValue(tag, attrName) {
  const re = new RegExp(`${attrName}=["']([^"']*)["']`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
}

/**
 * Parse a URL-encoded POST body into name/value pairs.
 */
function parsePostBody(body) {
  if (!body) return [];
  return body.split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return { name: pair, value: '' };
    return { name: pair.substring(0, eq), value: pair.substring(eq + 1) };
  });
}

/**
 * Check if a submitted value is static (not worth correlating).
 */
function isStaticValue(value) {
  if (!value) return true;
  const statics = new Set([
    'true', 'false', 'on', 'off', 'yes', 'no',
    '0', '1', 'submit', 'continue', 'back',
    'myself', 'someoneelse',
  ]);
  if (statics.has(value.toLowerCase())) return true;
  return false;
}

function sanitiseVarName(name) {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    || 'var';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; }
  catch { return relative; }
}

function isDynamicUrl(location) {
  if (!location) return false;
  if (location.includes('?') && location.includes('=')) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(location)) return true;
  if (/\/\d{6,}(\/|$)/.test(location)) return true;
  if (/\/[a-zA-Z0-9]{20,}(\/|$)/.test(location)) return true;
  return false;
}

function extractUrlParamName(location) {
  try {
    const parsed = new URL(location, 'https://placeholder');
    for (const [key] of parsed.searchParams) return sanitiseVarName('redirect_' + key);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) return sanitiseVarName('redirect_' + segments[segments.length - 1]);
  } catch { /* ignore */ }
  return null;
}
