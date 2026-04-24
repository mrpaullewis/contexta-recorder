# Contexta Recorder → PerfOps Studio — Pull Integration Spec

| | |
|---|---|
| **Spec version** | 1.3 |
| **Spec date** | 2026-04-24 |
| **Spec status** | Ready to implement (Stage 2 of the Contexta Recorder roadmap) |
| **Consumer scope** | **PerfOps Studio only**. Multi-consumer support is Day 2 work, not in this spec. |
| **Storage model** | Single recording — latest only. New recording replaces the previous. |
| **Target recorder version** | v0.2.0 |
| **Target Studio version** | Coordinated with recorder v0.2.0 release |
| **Extension ID strategy** | No `key` field in `manifest.json`. Dev uses the install-path-derived ID; CWS assigns its own ID on publication. Studio's `CONTEXTA_RECORDER_EXT_ID` env var is updated manually when the ID changes (e.g. after CWS publishes). One-line config change, no dev/prod parity automation needed. |
| **Owner** | Paul (Contexta) |
| **Author of spec** | Contexta |

## Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-04-24 | Contexta | Initial consolidated spec. Combined three earlier working specs into a single handoff document. |
| 1.1 | 2026-04-24 | Contexta | Narrowed scope to Studio-only consumer. Multi-consumer language removed. Any additional consumers are Day 2 / separate spec. |
| 1.2 | 2026-04-24 | Contexta | Single-recording storage model (was 20-recording FIFO). Starting a new recording replaces the previous one. `listRecordings` returns 0 or 1 entries. |
| 1.3 | 2026-04-24 | Contexta | Reverted the manifest `key` field. Extension ID strategy simplified — no attempt at dev/prod ID parity. Studio's `CONTEXTA_RECORDER_EXT_ID` env var is updated manually whenever the ID changes. |

## How to cite this spec

> Contexta Recorder → PerfOps Studio Pull Integration Spec, v1.1, dated 2026-04-24. Located at `docs/PULL-INTEGRATION-SPEC.md` in the Contexta Recorder repository.

This is the single source-of-truth specification covering:
- **Part A** — API contract between the Contexta Recorder Chrome extension and PerfOps Studio.
- **Part B** — Extension-side implementation (what the recorder codebase must build).
- **Part C** — Studio-side implementation (what PerfOps Studio's codebase must build).

All three parts ship together. Deploying one without the other does nothing (Studio side will silently fail to reach the extension; extension side will have no callers).

**Out of scope for this spec:**
- Supporting consumers other than PerfOps Studio. Adding a second consumer (e.g. a CLI tool, a third-party service) is a Day 2 concern and requires its own scope decision — at minimum a new origin in `externally_connectable.matches`, at most a re-design of the API contract for different trust/auth needs. Do not build for hypothetical future consumers in this release.

---

# Part A — API Contract

## A.1 What this API does

The Contexta Recorder is a Chrome extension that records browser sessions (HTTP requests, full response bodies, page HTML, form fields) and stores them locally in `chrome.storage.local`. This API lets PerfOps Studio pull those recordings directly from the extension's storage — no file upload, no clipboard hand-off, no server middleman.

**Transport:** Chrome's `chrome.runtime.sendMessage` IPC (in-browser messaging).

**Trust model:** Origin-based. The extension only responds to messages from Studio origins whitelisted in its `manifest.json` `externally_connectable.matches` list. Chrome enforces this at the IPC layer — non-Studio origins cannot message the extension at all.

**No secrets:** The API has no tokens, no bearer auth, no credentials. Studio's own session cookie handles user identity on its side.

## A.2 Prerequisites (Studio)

1. **Studio must be served from an HTTPS origin** (e.g. `https://studio.perfops.studio`). Local dev origins (`http://localhost:*`) supported during development.
2. **Studio's origin whitelisted in the recorder's manifest.** The recorder's `manifest.json` `externally_connectable.matches` must list the Studio origin(s). See Part B.2.
3. **Studio knows the recorder's extension ID.** Published Chrome extensions have a stable 32-character ID. Stored as `CONTEXTA_RECORDER_EXT_ID` in Studio config (see Part C.2.3). Dev override via env var.

## A.3 Message API

### A.3.1 Ping — detect presence and capabilities

**Request:**
```json
{ "action": "ping" }
```

**Response:**
```json
{
  "installed": true,
  "version": "0.2.0",
  "supportedFormats": ["jmx", "har", "json", "csv"],
  "supportedJmxModes": ["fragment", "standalone"]
}
```

If the extension isn't installed/disabled/old, `chrome.runtime.sendMessage` sets `chrome.runtime.lastError` and the response is `undefined`.

### A.3.2 List recordings — metadata only

**Request:**
```json
{ "action": "listRecordings" }
```

**Response:**
```json
{
  "recordings": [
    {
      "id": "rec_20260424_143022",
      "name": "UJ01 - Covid Booking",
      "journeyCode": "UJ01",
      "createdAt": "2026-04-24T14:30:22Z",
      "endedAt": "2026-04-24T14:33:11Z",
      "transactionCount": 5,
      "requestCount": 42,
      "correlationCount": 8,
      "dataFieldCount": 3,
      "sizeBytes": 1048576
    }
  ]
}
```

Notes:
- Extension stores only the most recent completed recording. Starting a new recording clears the previous one — it will never appear in `listRecordings` again. So the `recordings` array in the response is always either empty or a single-item list.
- `sizeBytes` is the serialised JSON size. Used to anticipate Chrome's ~64MB IPC limit.
- IDs are opaque to Studio.

### A.3.3 Get a recording in a specific format

**Request:**
```json
{
  "action": "getRecording",
  "id": "rec_20260424_143022",
  "format": "jmx",
  "options": { "mode": "standalone" }
}
```

Parameters:
- `id` (string, required) — from `listRecordings`.
- `format` (string, required) — `"jmx"`, `"har"`, `"json"`, `"csv"`.
- `options` (object, optional) — format-specific. For `"jmx"`: `{"mode": "fragment" | "standalone"}` (default `"fragment"`).

**Response:**
```json
{
  "format": "jmx",
  "filename": "UJ01_standalone.jmx",
  "contentType": "application/octet-stream",
  "content": "<?xml version=\"1.0\"..."
}
```

Format reference:

| Format | Content-type | Notes |
|---|---|---|
| `json` | `application/json` | Full rich session: transactions, requests, responses, `pageResponses` (full HTML bodies), correlations, assertions, data requirements, fingerprints. Up to tens of MB. |
| `jmx` | `application/octet-stream` | JMeter 5.x script with correlation extractors, assertions, think times. Fragment mode = `TestFragmentController`. Standalone mode = full TestPlan. |
| `har` | `application/json` | HTTP Archive 1.2. Standard, broadly compatible. |
| `csv` | `text/csv` | One column per detected form field. Returns `no_data_fields` error if none. |

### A.3.4 Error responses

All errors: `{"error": "<code>", "message": "<string>"}`.

| Code | Meaning |
|---|---|
| `not_found` | No recording with given ID |
| `invalid_format` | Unknown format value |
| `invalid_options` | Bad options value |
| `invalid_request` | Missing/malformed action or id |
| `no_data_fields` | CSV requested but no fields detected |
| `too_large` | Payload exceeds ~60MB (Chrome IPC cap) |
| `corrupted` | Session JSON failed to parse |
| `generator_error` | Format generator threw |

## A.4 Versioning

- `version` in `ping` is the extension's version.
- New actions are backward-compatible additions.
- Removed actions first get deprecated one minor version, then removed.
- Studio should feature-detect via `ping.supportedFormats` rather than assuming.

## A.5 Limitations

- **64MB IPC cap** — structured-clone limit. JSON format most likely to hit it on large recordings.
- **Service worker cold start** — ~500ms lag on first message after ~30s idle (MV3 behaviour).
- **Single-recording storage** — only the most recent recording is pullable. Starting a new recording replaces it. If Studio wants to keep a historical list, it does so server-side after import (Studio's `recorder.Recordings` table already supports that).
- **No streaming** — single-response per call.
- **No push** — extension never initiates; Studio polls `listRecordings` if it wants to detect new recordings.

---

# Part B — Extension-Side Implementation

## B.1 Files to add or modify

| File | Change |
|---|---|
| `manifest.json` | Add `externally_connectable` key, bump version to `0.2.0`. |
| `background/service-worker.js` | Add `chrome.runtime.onMessageExternal` listener (~80 lines). |
| `shared/constants.js` | Add `PULL_API_VERSION` and `SUPPORTED_FORMATS` constants. |
| `tests/pull-api.spec.js` | New Playwright test file (~150 lines). |

No changes needed to `shared/jmx-generator.js`, `shared/har-export.js`, `popup/*`, `background/recorder.js`, `content/*`.

## B.2 Manifest changes

```jsonc
// manifest.json — add this top-level key
"externally_connectable": {
  "matches": [
    "https://*.perfops.studio/*",
    "https://studio.perfops.studio/*"
    // For dev only: "http://localhost:*/*", "http://127.0.0.1:*/*"
    // Strip these before CWS submission — they raise reviewer flags.
  ]
}
```

Bump `"version"` from `"0.1.1"` to `"0.2.0"`.

## B.3 Constants

Add to `shared/constants.js`:

```javascript
// Pull API (v0.2.0)
export const PULL_API_VERSION = '0.2.0';
export const SUPPORTED_FORMATS = ['jmx', 'har', 'json', 'csv'];
```

## B.4 Service worker message handler

Add to `background/service-worker.js` after the existing `chrome.runtime.onMessage` listener:

```javascript
// ── External pull API (v0.2.0) ──────────────────────────────
// Responds to messages from origins whitelisted in manifest
// `externally_connectable.matches`. Chrome enforces the origin check
// at the IPC layer — any message reaching this handler is already
// from an approved origin.

import { generateJmx } from '../shared/jmx-generator.js';
import { generateHar } from '../shared/har-export.js';
import { PULL_API_VERSION, SUPPORTED_FORMATS } from '../shared/constants.js';
// Note: `storage`, `State` etc. already imported at top of file.

const MAX_PAYLOAD_BYTES = 60 * 1024 * 1024; // 60MB — under Chrome's ~64MB IPC cap

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
  const saved = await storage.getSavedSessions();
  const current = await storage.getSession();
  const all = [];
  if (current && current.endTime) all.push(current);
  all.push(...saved.map(s => s.session || s));

  return {
    recordings: all.map(s => ({
      id: s.id,
      name: s.name || s.journeyCode || 'Untitled',
      journeyCode: s.journeyCode,
      createdAt: s.startTime,
      endedAt: s.endTime,
      transactionCount: s.transactions?.length || 0,
      requestCount: (s.transactions || []).reduce((n, t) => n + (t.requests?.length || 0), 0),
      correlationCount: s.correlations?.length || 0,
      dataFieldCount: s.dataRequirements?.length || 0,
      sizeBytes: estimateSessionSize(s),
    })),
  };
}

async function handleGetRecording(message) {
  const { id, format, options = {} } = message;
  if (!id) return { error: 'invalid_request', message: 'id is required' };
  if (!format) return { error: 'invalid_request', message: 'format is required' };
  if (!SUPPORTED_FORMATS.includes(format)) {
    return { error: 'invalid_format', message: `Format must be one of: ${SUPPORTED_FORMATS.join(', ')}` };
  }

  const session = await findSessionById(id);
  if (!session) return { error: 'not_found', message: `No recording with id: ${id}` };

  let content, filename, contentType;
  const code = session.journeyCode || 'recording';

  switch (format) {
    case 'json':
      content = JSON.stringify(session, null, 2);
      filename = `${code}_recording.json`;
      contentType = 'application/json';
      break;
    case 'jmx': {
      const mode = options.mode || 'fragment';
      if (!['fragment', 'standalone'].includes(mode)) {
        return { error: 'invalid_options', message: `Invalid JMX mode: ${mode}` };
      }
      content = generateJmx(session, { mode });
      filename = `${code}${mode === 'fragment' ? '' : '_standalone'}.jmx`;
      contentType = 'application/octet-stream';
      break;
    }
    case 'har':
      content = JSON.stringify(generateHar(session), null, 2);
      filename = `${code}_recording.har`;
      contentType = 'application/json';
      break;
    case 'csv': {
      const dataReqs = session.dataRequirements || [];
      if (dataReqs.length === 0) {
        return { error: 'no_data_fields', message: 'No form fields detected; CSV unavailable.' };
      }
      const headers = dataReqs.map(d => d.suggestedCsvColumn);
      const values = dataReqs.map(d => csvEscape(d.sampleValue || ''));
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
  const sessions = await storage.getSavedSessions();
  const wrapped = sessions.find(s => (s.session || s).id === id);
  return wrapped ? (wrapped.session || wrapped) : null;
}

function estimateSessionSize(session) {
  let size = 0;
  for (const pr of session.pageResponses || []) {
    size += (pr.body?.length || 0);
  }
  for (const tx of session.transactions || []) {
    for (const r of tx.requests || []) {
      size += (r.requestBody?.length || 0) + (r.responseBody?.length || 0);
    }
  }
  return size;
}

function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
```

## B.5 Error handling principles

- **Never throw unhandled.** Every path must call `sendResponse(...)` exactly once.
- **Always include `error` code and `message`.** Studio parses the code; message is for human debugging.
- **Don't leak stack traces in production.** The catch-all logs to `console.error` but sends only `err.message`.
- **No silent failures.** Every branch returns a response — never `return undefined` without calling `sendResponse`.

## B.6 Size / payload considerations

| Format | Typical size | Notes |
|---|---|---|
| `json` | 1–10 MB | `pageResponses[].body` dominates. Can hit cap on 50+ page recordings. |
| `jmx` | 50–500 KB | Small. |
| `har` | 500 KB – 5 MB | Smaller than JSON (no full page HTML). |
| `csv` | 1–10 KB | Trivial. |

If `json` hits the cap, Studio should fall back to `jmx` or `har`.

## B.7 Playwright tests skeleton

`tests/pull-api.spec.js`:

```javascript
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..');

test.describe('Pull API', () => {
  let context;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    extensionId = sw.url().split('/')[2];
  });

  test.afterAll(() => context?.close());

  test('ping returns extension presence', async () => {
    const page = await context.newPage();
    await page.goto('http://localhost:3000/'); // must be in externally_connectable.matches
    const response = await page.evaluate(async (extId) => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(extId, { action: 'ping' }, resolve);
      });
    }, extensionId);
    expect(response.installed).toBe(true);
    expect(response.supportedFormats).toContain('jmx');
  });

  // test.todo — listRecordings, getRecording jmx/har/json/csv, error cases
});
```

## B.8 Implementation order for extension

1. Add constants.
2. Add `externally_connectable` to manifest.
3. Add bare `ping` handler. Test from a consuming page that the whitelist works.
4. Add `listRecordings` handler. Test with real recorded session.
5. Add `getRecording` for `format: "json"`. Test.
6. Add `format: "jmx"` branch.
7. Add `format: "har"` and `format: "csv"` branches.
8. Add error handling for all edge cases.
9. Write Playwright tests.
10. Replace extension ID placeholder in Studio after CWS publishing.

---

# Part C — Studio-Side Implementation

## C.1 What Studio is building

A web UI in Studio that lets a logged-in user pull a recording directly from the Contexta Recorder Chrome extension and save it into Studio's `recorder.Recordings` table, scoped to their tenant.

**User flow:**
1. User records a flow in their browser using the recorder.
2. User navigates to Studio's Recordings page (`/recordings`).
3. Page shows an "Import from Contexta Recorder" button.
4. Click to send a message to the extension via `chrome.runtime.sendMessage`.
5. Extension returns a list of recordings stored locally.
6. Studio shows a picker. User selects one.
7. Studio pulls the selected recording (full JSON) from the extension.
8. Studio POSTs the JSON to its own `/recordings/import` endpoint.
9. Server validates, stores under `session.company_id`, redirects user to a summary page.

## C.2 Server-side changes

### C.2.1 Database migration

```sql
-- sql/migrations/XXXX-add-companyid-to-recordings.sql
ALTER TABLE recorder.Recordings ADD CompanyID INT NULL;
UPDATE recorder.Recordings SET CompanyID = <admin_company_id> WHERE CompanyID IS NULL;
ALTER TABLE recorder.Recordings ALTER COLUMN CompanyID INT NOT NULL;
CREATE INDEX IX_Recordings_CompanyID ON recorder.Recordings (CompanyID);
```

### C.2.2 Refactor `blueprints/recordings.py`

Split into admin routes (`/admin/recordings/*`, `require_admin`) and tenant routes (`/recordings/*`, `require_login`).

```python
# blueprints/recordings.py

from flask import Blueprint, render_template, request, jsonify, redirect, url_for, session
from core.auth import require_login, require_admin
from core.database import execute_query, execute_update

recordings_bp = Blueprint('recordings', __name__)

# ── Tenant-scoped routes ──

@recordings_bp.route('/recordings/')
@require_login
def list_for_tenant():
    recordings = execute_query(
        "SELECT * FROM recorder.Recordings WHERE CompanyID = ? ORDER BY CreatedAt DESC",
        (session.get('company_id'),)
    ) or []
    return render_template('recordings/list.html', recordings=recordings)

@recordings_bp.route('/recordings/import', methods=['POST'])
@require_login
def import_from_extension():
    """Accept a session JSON body pulled from the Contexta Recorder."""
    import json
    company_id = session.get('company_id')
    if not company_id:
        return jsonify({'error': 'no_company'}), 403
    data = request.get_json(silent=True)
    if not data or 'session' not in data:
        return jsonify({'error': 'invalid_payload'}), 400
    session_data = data['session']
    # Data-integrity check only — business validation happens in UJ Builder
    if not isinstance(session_data, dict) or 'transactions' not in session_data:
        return jsonify({'error': 'invalid_session_shape'}), 400
    try:
        recording_id = execute_update(
            """INSERT INTO recorder.Recordings
               (CompanyID, JourneyCode, Name, SessionJSON, CreatedAt)
               OUTPUT INSERTED.RecordingID
               VALUES (?, ?, ?, ?, GETDATE())""",
            (company_id,
             session_data.get('journeyCode', ''),
             session_data.get('name', 'Untitled'),
             json.dumps(session_data))
        )
    except Exception as e:
        return jsonify({'error': 'db_error', 'message': str(e)}), 500
    return jsonify({
        'recording_id': recording_id,
        'redirect_to': url_for('recordings.summary', recording_id=recording_id),
    }), 201

@recordings_bp.route('/recordings/<int:recording_id>/summary')
@require_login
def summary(recording_id):
    row = execute_query(
        "SELECT * FROM recorder.Recordings WHERE RecordingID = ? AND CompanyID = ?",
        (recording_id, session.get('company_id'))
    )
    if not row:
        from flask import flash
        flash('Recording not found or you do not have access.', 'error')
        return redirect(url_for('recordings.list_for_tenant'))
    return render_template('recordings/summary.html', recording=row[0])

# ── Admin routes (existing) ──

@recordings_bp.route('/admin/recordings/')
@require_admin
def admin_list():
    recordings = execute_query(
        "SELECT * FROM recorder.Recordings ORDER BY CreatedAt DESC"
    ) or []
    return render_template('recordings/admin_list.html', recordings=recordings)

@recordings_bp.route('/admin/recordings/<int:recording_id>')
@require_admin
def admin_detail(recording_id):
    row = execute_query(
        "SELECT * FROM recorder.Recordings WHERE RecordingID = ?",
        (recording_id,)
    )
    if not row:
        from flask import flash
        flash('Recording not found.', 'error')
        return redirect(url_for('recordings.admin_list'))
    return render_template('recordings/admin_detail.html', recording=row[0])

@recordings_bp.route('/admin/recordings/<int:recording_id>/api/session')
@require_admin
def admin_session_json(recording_id):
    import json
    row = execute_query(
        "SELECT SessionJSON FROM recorder.Recordings WHERE RecordingID = ?",
        (recording_id,)
    )
    if not row or not row[0].SessionJSON:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(json.loads(row[0].SessionJSON))
```

Blueprint registration in `app.py`:

```python
# BEFORE:
app.register_blueprint(recordings_bp, url_prefix='/recordings')

# AFTER (blueprint now defines own prefixes per route):
app.register_blueprint(recordings_bp)
```

### C.2.3 Config

```python
# config.py
CONTEXTA_RECORDER_EXT_ID = os.environ.get(
    'CONTEXTA_RECORDER_EXT_ID',
    'PLACEHOLDER_REPLACE_AT_PUBLISH_TIME'
)
```

Expose to templates:
```python
@app.context_processor
def inject_config():
    return {
        'contexta_recorder_ext_id': app.config.get('CONTEXTA_RECORDER_EXT_ID'),
    }
```

## C.3 Client-side changes

### C.3.1 Template — `templates/recordings/list.html`

```html
{% extends "base.html" %}
{% block content %}
<div class="recordings-header">
  <h1>Recordings</h1>
  <button id="import-from-recorder-btn" class="btn btn-primary">
    Import from Contexta Recorder
  </button>
</div>

<div id="import-status" class="hidden"></div>

<div id="recorder-picker-modal" class="modal hidden">
  <div class="modal-content">
    <h2>Choose a recording to import</h2>
    <div id="recorder-picker-list"></div>
    <button id="picker-cancel" class="btn">Cancel</button>
  </div>
</div>

<table class="recordings-table">
  {% for r in recordings %}
    <tr>
      <td>{{ r.JourneyCode }}</td>
      <td>{{ r.Name }}</td>
      <td>{{ r.CreatedAt }}</td>
      <td><a href="{{ url_for('recordings.summary', recording_id=r.RecordingID) }}">View</a></td>
    </tr>
  {% endfor %}
</table>

<script>
  window.CONTEXTA_RECORDER_EXT_ID = "{{ contexta_recorder_ext_id }}";
</script>
<script src="{{ url_for('static', filename='js/recorder-import.js') }}"></script>
{% endblock %}
```

### C.3.2 JS — `static/js/recorder-import.js`

DOM built with `createElement` + `textContent`. No `innerHTML` with untrusted data.

```javascript
// recorder-import.js
//
// Pulls a recording from the Contexta Recorder Chrome extension
// and POSTs it to Studio's /recordings/import endpoint.

const EXT_ID = window.CONTEXTA_RECORDER_EXT_ID;
const MSG_TIMEOUT_MS = 10000;

function sendToRecorder(message) {
  return new Promise((resolve, reject) => {
    if (!window.chrome?.runtime?.sendMessage) {
      return reject(new Error('chrome.runtime.sendMessage unavailable — not a Chromium browser?'));
    }
    const timer = setTimeout(
      () => reject(new Error('Extension did not respond (timeout)')),
      MSG_TIMEOUT_MS
    );
    chrome.runtime.sendMessage(EXT_ID, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message || 'Extension unreachable'));
      }
      if (response?.error) {
        return reject(new Error(`${response.error}: ${response.message || ''}`));
      }
      resolve(response);
    });
  });
}

async function isRecorderInstalled() {
  try {
    const r = await sendToRecorder({ action: 'ping' });
    return r?.installed === true;
  } catch {
    return false;
  }
}

async function listRecordings() {
  const r = await sendToRecorder({ action: 'listRecordings' });
  return r?.recordings || [];
}

async function getRecording(id) {
  const r = await sendToRecorder({
    action: 'getRecording',
    id,
    format: 'json',
  });
  if (!r?.content) throw new Error('Empty recording content');
  return JSON.parse(r.content);
}

async function postToStudio(sessionData) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const resp = await fetch('/recordings/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken,
    },
    credentials: 'same-origin',
    body: JSON.stringify({ session: sessionData }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'unknown' }));
    throw new Error(`Import failed (HTTP ${resp.status}): ${err.error} — ${err.message || ''}`);
  }
  return resp.json();
}

async function openPicker() {
  const installed = await isRecorderInstalled();
  if (!installed) {
    showStatus(
      'Contexta Recorder extension not detected.',
      'Install it from the Chrome Web Store, then refresh this page.',
      'error'
    );
    return;
  }
  let recordings;
  try {
    recordings = await listRecordings();
  } catch (err) {
    showStatus('Could not list recordings', err.message, 'error');
    return;
  }
  if (recordings.length === 0) {
    showStatus('No recordings found', 'Record a flow in the extension first.', 'info');
    return;
  }
  renderPicker(recordings);
}

function renderPicker(recordings) {
  const list = document.getElementById('recorder-picker-list');
  while (list.firstChild) list.removeChild(list.firstChild);

  for (const r of recordings) {
    const item = document.createElement('div');
    item.className = 'picker-item';

    const title = document.createElement('div');
    title.className = 'picker-title';
    title.textContent = r.name;

    const meta = document.createElement('div');
    meta.className = 'picker-meta';
    meta.textContent = [
      `${r.transactionCount} transactions`,
      `${r.requestCount} requests`,
      `${r.correlationCount} correlations`,
      `${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
      new Date(r.createdAt).toLocaleString(),
    ].join(' · ');

    const button = document.createElement('button');
    button.className = 'btn btn-primary picker-select';
    button.textContent = 'Import';
    button.dataset.id = r.id;
    button.addEventListener('click', () => pickAndImport(r.id));

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(button);
    list.appendChild(item);
  }

  document.getElementById('recorder-picker-modal').classList.remove('hidden');
}

function closePicker() {
  document.getElementById('recorder-picker-modal').classList.add('hidden');
}

async function pickAndImport(id) {
  closePicker();
  showStatus('Importing', 'Pulling recording from extension.', 'info');

  let sessionData;
  try {
    sessionData = await getRecording(id);
  } catch (err) {
    showStatus('Pull failed', err.message, 'error');
    return;
  }
  let result;
  try {
    result = await postToStudio(sessionData);
  } catch (err) {
    showStatus(
      'Save failed',
      err.message + '\n(Recording is still in your extension — you can retry.)',
      'error'
    );
    return;
  }
  window.location.href = result.redirect_to;
}

function showStatus(title, body, level) {
  const el = document.getElementById('import-status');
  el.classList.remove('hidden');
  el.className = `status-${level}`;
  while (el.firstChild) el.removeChild(el.firstChild);
  const strong = document.createElement('strong');
  strong.textContent = title;
  el.appendChild(strong);
  el.appendChild(document.createElement('br'));
  el.appendChild(document.createTextNode(body));
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('import-from-recorder-btn')?.addEventListener('click', openPicker);
  document.getElementById('picker-cancel')?.addEventListener('click', closePicker);
});
```

### C.3.3 Template — `templates/recordings/summary.html`

```html
{% extends "base.html" %}
{% block content %}
<h1>Recording imported</h1>
<p>Journey: <strong>{{ recording.JourneyCode }}</strong></p>

{% set summary = recording.SessionJSON|from_json %}
<div class="summary-stats">
  <div>{{ summary.transactions|length }} transactions</div>
  <div>{{ summary.correlations|default([])|length }} correlations</div>
  <div>{{ summary.dataRequirements|default([])|length }} data fields</div>
</div>

<div class="summary-actions">
  <a href="{{ url_for('uj_builder.edit', recording_id=recording.RecordingID) }}"
     class="btn btn-primary">
    Validate step-by-step (UJ Builder)
  </a>
  <a href="{{ url_for('runs.smoke_from_recording', recording_id=recording.RecordingID) }}"
     class="btn">
    Save and run 1-user smoke
  </a>
  <a href="{{ url_for('recordings.list_for_tenant') }}" class="btn">
    Just save to my list
  </a>
</div>
{% endblock %}
```

`uj_builder.edit` and `runs.smoke_from_recording` routes need to exist (or be added) in their respective blueprints — not part of this spec.

## C.4 Error mapping (extension errors → user-visible)

| Extension error code | User sees |
|---|---|
| (no response / `lastError`) | "Extension not detected — install it from the Chrome Web Store" |
| `not_found` | "That recording no longer exists. Try a different one." |
| `too_large` | "Recording is too large to import. Try a shorter flow." |
| `corrupted` | "Recording is corrupted. Report to support with the recording ID." |
| Any other | "Could not import: <error message>" |

## C.5 Security considerations

- **CSRF** — use Flask-WTF or equivalent. JS reads token from `<meta name="csrf-token" content="...">` and sends as `X-CSRFToken`.
- **Origin whitelist** — Studio's production origin MUST be in the recorder's `externally_connectable.matches`. Coordinate before deploy.
- **No sensitive logging** — `session` payload contains PII (form values, cookies, CSRF tokens). Log only metadata.
- **Tenant isolation** — every SQL query includes `WHERE CompanyID = session.get('company_id')`. Enforced at every route.
- **DOM safety** — `createElement` + `textContent`, never `innerHTML` with untrusted data.

## C.6 Testing

### Unit tests

- `test_import_requires_login` — POST without login → 302 to login.
- `test_import_requires_company_id` — login without company → 403 `no_company`.
- `test_import_invalid_payload` — POST `{}` → 400 `invalid_payload`.
- `test_import_invalid_session_shape` — POST `{session: "not a dict"}` → 400.
- `test_import_happy_path` — valid session → 201, row inserted with correct `CompanyID`.
- `test_import_tenant_isolation` — user A's import is not visible to user B.

### Integration (Playwright)

- With extension installed + recording → Import succeeds → lands on summary.
- Without extension installed → "not detected" message.
- With extension but no recordings → "no recordings" message.

---

# Part D — Cross-Cutting Concerns

## D.1 Deployment order

1. **Recorder side first (independent):**
   - Ship recorder v0.2.0 to CWS with `externally_connectable` + message handlers.
   - Wait for CWS approval and auto-rollout (usually 1-2 days).
2. **Studio side (can start in parallel):**
   - DB migration (CompanyID column + backfill + NOT NULL).
   - Deploy refactored `blueprints/recordings.py`.
   - Deploy frontend JS + templates.
   - Set `CONTEXTA_RECORDER_EXT_ID` env var to the real CWS extension ID once published.
3. **End-to-end smoke test:**
   - Install recorder from CWS.
   - Record a flow.
   - Open Studio, click Import, verify end-to-end.

Neither side's code requires the other to deploy. Studio's Import button will silently fail until the recorder is live — that's acceptable because no user gets past "Import" without the recorder showing a "not detected" message.

## D.2 Out of scope for v0.2.0

- Auto-delete from extension after successful import.
- Real-time push notification when a new recording is stopped.
- Chunked response streaming for >60MB JSON.
- Native messaging host for CLI tool integration.
- Additional formats (Taurus YAML, Gatling DSL, Locust Python).
- "Import ALL recordings" bulk button.

## D.3 Open questions to resolve during implementation

- **Sort order of `listRecordings`** — newest first (propose yes).
- **Default JMX mode** — fragment vs standalone (propose fragment for parity with popup).
- **Handling in-progress recordings** in `getRecording` — return error or partial? (Propose error.)
- **Import button visibility** — always visible (propose yes).
- **UJ Builder route signature** — `uj_builder.edit(recording_id)` or different? (Confirm during Studio work.)

## D.4 Contact

- **Owner:** Paul (Contexta)
- **Support:** support@contexta.uk
- **Recorder repo:** `C:\Users\mrpfl\OneDrive\Documents\Contexta.uk\code\contexta-recorder`
- **Studio repo:** `C:\Users\mrpfl\OneDrive\Documents\Contexta.uk\code\PerftestFramework\studio`
