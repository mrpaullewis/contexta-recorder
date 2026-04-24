# Implementation Spec — PerfOps Studio Recorder Integration

**Target:** PerfOps Studio (Flask app at `C:\Users\mrpfl\OneDrive\Documents\Contexta.uk\code\PerftestFramework\studio`)
**Audience:** Studio developer building the "Import from Contexta Recorder" feature
**Recorder target version:** v0.2.0 (not v0.1.1 — Stage 2 work)
**Related specs:**
- `docs/RECORDER-PULL-API.md` — extension-side API contract (read this first)
- `docs/superpowers/specs/2026-04-24-v0.2.0-pull-api-implementation.md` — extension-side impl (what the other team is building)

---

## 1. What Studio is building

A web UI in Studio that lets a logged-in user pull a recording directly from the Contexta Recorder Chrome extension and save it into Studio's `recorder.Recordings` table, scoped to their tenant.

**User flow:**
1. User records a flow in their browser using the Contexta Recorder extension.
2. User navigates to Studio's Recordings page (`/recordings`).
3. Page shows an "Import from Contexta Recorder" button.
4. Click to send a message to the extension via `chrome.runtime.sendMessage`.
5. Extension returns a list of recordings stored locally.
6. Studio shows a picker UI. User selects one.
7. Studio pulls the selected recording (full JSON) from the extension.
8. Studio POSTs the JSON to its own `/recordings/import` endpoint.
9. Server validates, stores under `session.company_id`, redirects user to a summary page.

No tokens, no OAuth, no API keys. The extension's trust model is origin-based (Chrome enforces). Studio's own session cookie handles user auth.

---

## 2. Server-side changes

### 2.1 Database migration

Add `CompanyID` column to `recorder.Recordings` so it can be tenant-scoped.

```sql
-- sql/migrations/XXXX-add-companyid-to-recordings.sql
ALTER TABLE recorder.Recordings ADD CompanyID INT NULL;

-- Backfill existing admin-owned rows to a well-known admin company
UPDATE recorder.Recordings SET CompanyID = <admin_company_id> WHERE CompanyID IS NULL;

-- After backfill verified, make NOT NULL
ALTER TABLE recorder.Recordings ALTER COLUMN CompanyID INT NOT NULL;

-- Add index for tenant-scoped queries
CREATE INDEX IX_Recordings_CompanyID ON recorder.Recordings (CompanyID);
```

### 2.2 Refactor `blueprints/recordings.py`

Today the file has `@require_admin` on every route. Split into two concerns:

```python
# blueprints/recordings.py

from flask import Blueprint, render_template, request, jsonify, redirect, url_for, session
from core.auth import require_login, require_admin
from core.database import execute_query, execute_update

recordings_bp = Blueprint('recordings', __name__)

# ── Tenant-scoped routes (require_login, filtered by company_id) ──

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
    """Accept a session JSON body from Studio JS (which pulled it from
    the Contexta Recorder extension via chrome.runtime.sendMessage)."""
    import json

    company_id = session.get('company_id')
    if not company_id:
        return jsonify({'error': 'no_company'}), 403

    data = request.get_json(silent=True)
    if not data or 'session' not in data:
        return jsonify({'error': 'invalid_payload'}), 400

    session_data = data['session']

    # Data-integrity check only — business validation is UJ Builder's job
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

# ── Admin routes (existing, require_admin, cross-tenant) ──

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

**Blueprint registration:** update `app.py`:
```python
# BEFORE:
app.register_blueprint(recordings_bp, url_prefix='/recordings')

# AFTER: (the blueprint now defines its own prefixes per route)
app.register_blueprint(recordings_bp)
```

### 2.3 Config

Add to `config.py` (or wherever Flask app config lives):

```python
# Extension ID of the Contexta Recorder (stable once published to Chrome Web Store)
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

---

## 3. Client-side changes

### 3.1 Template — `templates/recordings/list.html`

Main recordings list view with the Import button.

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

<!-- Picker modal (hidden by default) -->
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

### 3.2 JS — `static/js/recorder-import.js`

Uses `createElement` / `textContent` (no innerHTML with user data — safe by construction).

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

// Use createElement + textContent — never innerHTML with untrusted data.
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

// Wire up on page load
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('import-from-recorder-btn')?.addEventListener('click', openPicker);
  document.getElementById('picker-cancel')?.addEventListener('click', closePicker);
});
```

### 3.3 Template — `templates/recordings/summary.html`

The page the user lands on after a successful import. Shows counts and the three choices.

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

The `uj_builder.edit` and `runs.smoke_from_recording` routes need to exist or be added in their respective blueprints. Not part of this spec.

---

## 4. Error handling

The extension returns `{error: <code>, message: <string>}` on failure. Map to user-friendly messages:

| Extension error code | User sees |
|---|---|
| (no response / `lastError`) | "Extension not detected — install it from the Chrome Web Store" |
| `not_found` | "That recording no longer exists. Try a different one." |
| `too_large` | "Recording is too large to import. Try a shorter flow." |
| `corrupted` | "Recording is corrupted. Report to support with the recording ID." |
| Any other error | "Could not import: <error message>" |

Server-side errors from `/recordings/import` are mapped in the `postToStudio()` catch block.

---

## 5. Security considerations

- **CSRF.** Use Flask-WTF or equivalent CSRF middleware. JS reads the token from a `<meta name="csrf-token" content="...">` tag and sends it as `X-CSRFToken` header. Confirm Studio already has this pattern before relying on it.
- **Origin whitelist.** Studio's production origin MUST be listed in the recorder's `manifest.json` `externally_connectable.matches`. Coordinate with Contexta team before deploying.
- **No sensitive logging.** Do not log the `session` payload on the server — it contains PII (form values, CSRF tokens, session cookies). Log metadata only (user ID, recording size, success/fail).
- **Tenant isolation.** Every SQL query MUST include `WHERE CompanyID = session.get('company_id')`. The `/recordings/import` route must never insert without this.
- **DOM safety.** The client JS uses `createElement` + `textContent`, never `innerHTML` with untrusted data. Recording metadata (name, journeyCode) comes from the user's own browser extension, but treated as untrusted to keep the pattern safe for future changes.

---

## 6. Testing

### 6.1 Unit tests

- `test_import_requires_login` — POST to `/recordings/import` without login → 302 to login page.
- `test_import_requires_company_id` — login without company binding → 403 `no_company`.
- `test_import_invalid_payload` — POST `{}` → 400 `invalid_payload`.
- `test_import_invalid_session_shape` — POST `{session: "not a dict"}` → 400 `invalid_session_shape`.
- `test_import_happy_path` — POST valid session → 201, row inserted with correct `CompanyID`.
- `test_import_tenant_isolation` — user A imports, user B cannot see it in `list_for_tenant`.

### 6.2 Integration tests (Playwright)

- Load Studio with the extension installed → click Import → picker shows → select → import succeeds → land on summary page.
- Load Studio without extension installed → click Import → see "not detected" message.
- Load Studio with extension but no recordings → click Import → see "no recordings" message.

---

## 7. Deployment order

1. Merge the DB migration (`CompanyID` column + backfill + NOT NULL). Verify no existing admin views broke.
2. Ship the refactored `blueprints/recordings.py` and new templates. Verify admin `/admin/recordings/` still works for cross-tenant views.
3. Wait for recorder v0.2.0 to ship (it needs `externally_connectable` with Studio's origin + the message handlers).
4. Replace `CONTEXTA_RECORDER_EXT_ID` placeholder with the real ID in Studio's env var.
5. Smoke test the full flow end to end.

Studio and recorder should NOT be deployed in lockstep. Studio-side changes do nothing until the recorder is also ready, so Studio can deploy incrementally without waiting.

---

## 8. Out of scope

- Auto-delete from extension after successful import (no `deleteRecording` action in recorder v0.2.0).
- Real-time notification when a new recording is made (no `subscribeToRecordings` action).
- Pulling formats other than JSON (Studio only needs the rich session; JMX/HAR/CSV are recorder-side concerns for users who download directly).
- Chunked import for recordings >60MB (if needed later, extend the API on both sides).

---

## 9. Open questions

- Should the Import button be hidden until `isRecorderInstalled()` resolves true, or always visible with a status message? Recommend: always visible, shows status after click.
- What's the UJ Builder route name for step-by-step validation starting from a recording? Confirm `uj_builder.edit` takes a `recording_id` parameter or needs a different signature.
- Should there be a "import ALL my recordings" bulk button? Not in MVP — user can import one at a time.

---

## 10. Contact

- Recorder side: see `docs/RECORDER-PULL-API.md` and `docs/superpowers/specs/2026-04-24-v0.2.0-pull-api-implementation.md`.
- Studio CLAUDE.md: `C:\Users\mrpfl\OneDrive\Documents\Contexta.uk\code\PerftestFramework\studio\CLAUDE.md`.
- Owner: Paul.
