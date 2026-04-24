# Contexta Recorder — External Pull API

**Target version:** Contexta Recorder v0.2.0+
**API status:** Draft spec for implementation
**Last updated:** 2026-04-24

A specification for web applications that want to pull browser session recordings from the Contexta Recorder Chrome extension.

---

## 1. What this API does

The Contexta Recorder is a Chrome extension that records browser sessions (HTTP requests, full response bodies, page HTML, form fields) and stores them locally in `chrome.storage.local`. This API lets an authorised web application pull those recordings directly from the extension's storage — no file upload, no clipboard hand-off, no server middleman.

**Transport:** Chrome's `chrome.runtime.sendMessage` IPC (in-browser messaging).

**Trust model:** Origin-based. The extension only responds to messages from origins explicitly whitelisted in its manifest's `externally_connectable.matches` list. Chrome enforces this at the IPC layer — non-whitelisted origins cannot message the extension at all.

**No secrets:** The API has no tokens, no bearer auth, no credentials of any kind. The consuming tool's own session authentication (cookies, JWT, whatever) handles user identity on its own side.

---

## 2. Prerequisites for the consuming tool

To integrate, your tool needs:

1. **A stable HTTPS origin** (e.g. `https://my-tool.example.com`). Local development origins (`http://localhost:*`) are also supported during dev.

2. **To be whitelisted in the recorder's manifest.** The recorder's `manifest.json` must list your origin in `externally_connectable.matches`. This requires a release of the recorder extension that includes your origin — coordinate with the Contexta team. Example:
   ```json
   "externally_connectable": {
     "matches": [
       "https://*.perfops.studio/*",
       "https://my-tool.example.com/*"
     ]
   }
   ```

3. **The recorder's extension ID.** A published Chrome extension has a stable 32-character ID (lowercase letters only) assigned by the Chrome Web Store on first publication. Obtain it from the Contexta team or read it from `chrome://extensions/` after installation. Store it as a config value on your side (hardcoded per-environment, or from env var). For development with unpacked extensions, the ID changes per machine — use an env var override.

---

## 3. Message API contract

### 3.1 Ping — detect extension presence and capabilities

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

**Behaviour when extension is not installed / disabled / old version:**
`chrome.runtime.sendMessage` sets `chrome.runtime.lastError` and response is `undefined`. Your tool should interpret this as "not available" and show an install CTA instead.

---

### 3.2 List recordings — metadata only

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

**Notes:**
- The extension stores up to 20 completed recordings (FIFO eviction of the 21st).
- `sizeBytes` is the serialised JSON size of the full session. Used to anticipate whether `getRecording` with `format: "json"` will fit within Chrome's ~64MB IPC limit.
- `id` values are stable across sessions but not cryptographically unguessable — they're timestamps. Treat them as opaque.

**Empty response (no recordings yet):**
```json
{ "recordings": [] }
```

---

### 3.3 Get a recording — in a specific format

**Request:**
```json
{
  "action": "getRecording",
  "id": "rec_20260424_143022",
  "format": "jmx",
  "options": { "mode": "standalone" }
}
```

**Parameters:**
- `id` (string, required): recording ID from `listRecordings`.
- `format` (string, required): one of `"jmx"`, `"har"`, `"json"`, `"csv"`.
- `options` (object, optional): format-specific options.
  - For `"jmx"`: `{ "mode": "fragment" | "standalone" }` (defaults to `"fragment"`).
  - For other formats: ignored.

**Response (success):**
```json
{
  "format": "jmx",
  "filename": "UJ01_standalone.jmx",
  "contentType": "application/octet-stream",
  "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<jmeterTestPlan ..."
}
```

**Response fields:**
- `format` — echoes back the requested format.
- `filename` — the filename the extension would use if downloading directly (e.g. `{journeyCode}_recording.har`, `{journeyCode}.jmx`, `{journeyCode}_standalone.jmx`, `{journeyCode}_recording.json`, `{journeyCode}_test_data.csv`). Your tool may override it or use it as-is.
- `contentType` — suggested MIME type.
- `content` — the file contents as a string. For binary content (none of the four formats are binary), this would be base64; currently all four formats are text.

**Format details:**

| Format | Content type | Notes |
|---|---|---|
| `json` | `application/json` | Full rich session — transactions, requests, responses, `pageResponses` (full HTML bodies), `correlations`, `assertions`, `dataRequirements`, `fingerprints`. The raw data. Can be large (up to ~tens of MB). |
| `jmx` | `application/octet-stream` | JMeter 5.x script. With correlation extractors (RegexExtractor, JSONPostProcessor), assertions, think times. Fragment mode = `TestFragmentController` for use inside a wrapper TestPlan. Standalone mode = full TestPlan with ThreadGroup. |
| `har` | `application/json` | HTTP Archive 1.2 format. Standard, compatible with Charles, Fiddler, DevTools. |
| `csv` | `text/csv` | One column per detected form field, two rows (header + sample values). Suitable for JMeter CSV Data Set Config. Returns `{error: "no_data_fields"}` if no fields were detected. |

---

### 3.4 Error responses

Errors are returned as `{ "error": "<code>", "message": "<human-readable>" }`. Possible codes:

| Code | Meaning | When |
|---|---|---|
| `not_found` | No recording with the given ID | ID doesn't match any stored recording (possibly deleted between `listRecordings` and `getRecording`). |
| `invalid_format` | Unknown `format` value | Not in `["jmx", "har", "json", "csv"]`. |
| `invalid_options` | Unknown/invalid `options` value | e.g. `{mode: "weird"}` for JMX. |
| `no_data_fields` | CSV requested but no form fields detected in session | Only applies to `format: "csv"`. |
| `too_large` | Recording exceeds Chrome's IPC payload limit (~64MB) | Mostly affects `format: "json"` on very long recordings. Other formats are much smaller. |
| `corrupted` | Session JSON failed to parse | Session data in `chrome.storage.local` is damaged. Rare. |
| `generator_error` | Format generator threw an unexpected error | Bug in `jmx-generator.js` / `har-export.js`. Includes stack trace in dev builds. |

---

## 4. Example: consuming tool implementation (JavaScript)

### 4.1 Check extension installed

```javascript
const EXTENSION_ID = 'aaaaaaaabbbbbbbbccccccccdddddddd'; // 32-char CWS ID

function sendToRecorder(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(EXTENSION_ID, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(`${response.error}: ${response.message || ''}`));
      } else {
        resolve(response);
      }
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
```

### 4.2 List recordings and show picker

```javascript
async function showRecordingPicker() {
  const { recordings } = await sendToRecorder({ action: 'listRecordings' });
  if (!recordings.length) {
    alert('No recordings found in the extension. Record a flow first.');
    return;
  }
  // render picker UI from `recordings` array...
}
```

### 4.3 Pull a recording as JMX and save

```javascript
async function pullAsJmx(recordingId) {
  const r = await sendToRecorder({
    action: 'getRecording',
    id: recordingId,
    format: 'jmx',
    options: { mode: 'standalone' },
  });
  // r.content is the JMX string; r.filename suggested filename
  const blob = new Blob([r.content], { type: r.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = r.filename;
  a.click();
}
```

### 4.4 Pull a recording as JSON and POST to your own API

```javascript
async function importRecording(recordingId) {
  const r = await sendToRecorder({
    action: 'getRecording',
    id: recordingId,
    format: 'json',
  });
  const session = JSON.parse(r.content);
  const resp = await fetch('/api/recordings/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
    credentials: 'same-origin',  // use your tool's session cookie
  });
  if (!resp.ok) throw new Error(`Import failed: HTTP ${resp.status}`);
  return resp.json();
}
```

---

## 5. Security considerations

### 5.1 What the extension protects against

- **Non-whitelisted origins:** Chrome enforces `externally_connectable.matches` at the IPC layer. A page on a non-whitelisted origin cannot send messages to the extension at all.
- **Malicious extensions on the user's machine:** Other extensions cannot impersonate your origin because messages carry the sender's origin as verified by Chrome.
- **CSRF / XSS in your tool:** Not the extension's responsibility. Your tool must use standard web defences (CSRF tokens, CSP, input sanitisation). If your tool has an XSS vulnerability, an attacker could use it to call `chrome.runtime.sendMessage` and exfiltrate recordings — but that's the same blast radius as any XSS.

### 5.2 What the extension does NOT protect against

- **User installing a fake/malicious extension with the same name:** The user is responsible for installing the correct extension from the Chrome Web Store. Your tool should document the exact extension ID to install.
- **User deliberately exporting their own data:** Recordings contain the user's own browsing data on sites they chose to record. The user has full ownership and control.
- **Social engineering:** Convincing the user to install the extension and then record a sensitive flow for you is out of scope — that's a social/policy concern.

### 5.3 Data the user should know lives in the extension

Recordings can contain PII — passwords typed into forms, NHS numbers, session cookies, CSRF tokens, hidden form values. Your tool should:

- Display a clear notice when pulling a recording, so the user understands what's being transferred.
- Treat pulled recordings as sensitive by default (TLS in transit, encryption at rest if stored, retention policy, deletion capability).
- Never log recording contents to analytics / error reporting without scrubbing.

---

## 6. Versioning and compatibility

- The `version` field in the `ping` response is the extension's version (e.g. `"0.2.0"`).
- New message actions added in future versions will not break older consumers — the extension ignores unknown fields in requests.
- Removed actions (if any) will first be deprecated in one minor version, then removed in the next.
- The `supportedFormats` list is the source of truth. If your tool wants to support a format the extension doesn't (e.g. a hypothetical `"taurus"`), feature-detect via the `ping` response rather than assuming.

---

## 7. Getting your tool whitelisted

To add your origin to the recorder's `externally_connectable.matches`:

1. Contact the Contexta team with your origin(s) and a brief description of your tool.
2. Contexta will add the entry to `manifest.json`, publish a new extension version, and the update will roll out to users automatically via the Chrome Web Store.
3. Wait 1-2 hours for the auto-update to reach users (or instruct users to click "Update" in `chrome://extensions/` for immediate update).

Local development: Contexta can provide a dev build of the extension with your `http://localhost:*` origins whitelisted for testing.

---

## 8. Limitations and known issues

- **Max IPC payload ~64MB.** Chrome's structured-clone IPC limits response size. Very long recordings may hit this on `format: "json"`. Other formats are much smaller and rarely hit it.
- **Service worker cold start.** Chrome MV3 service workers sleep after ~30 seconds idle. The first message after sleep has a ~500ms cold-start lag — budget accordingly if you have a UI timeout.
- **Recording storage cap.** Extension keeps only the last 20 completed recordings. Older ones are evicted. Your tool can pull a recording immediately after it's created, or the user risks losing it to eviction if they record many more before importing.
- **No streaming.** The full payload is returned in a single response. No chunking in v0.2.0.
- **No push from extension.** The extension never initiates outbound communication. Your tool always pulls, never receives pushes. Poll `listRecordings` if you want to detect new recordings.

---

## 9. Open questions (to be resolved before implementation)

- Should the `getRecording` response include a content hash (SHA-256) for integrity verification? (Probably yes for JSON; overkill for JMX/HAR/CSV which are deterministic from JSON.)
- Should there be a `deleteRecording(id)` action for consuming tools to clean up after successful import? (Currently no — deletion is user-initiated from the extension popup. Makes tool flows that want auto-cleanup awkward.)
- Should there be a `subscribeToRecordings` action that notifies the consuming tool via `chrome.runtime.onMessage` when a new recording is stopped? (Not in v0.2.0; polling `listRecordings` works but is less slick.)

---

## 10. Contact

- Contexta: support@contexta.uk
- Recorder source / issues: (internal repo — request access from support)
