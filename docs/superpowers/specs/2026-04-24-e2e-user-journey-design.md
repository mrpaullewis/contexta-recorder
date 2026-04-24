# Design — Contexta Recorder E2E User Journey (v0.2.0)

**Date:** 2026-04-24
**Status:** Draft for review
**Scope:** Spec A of three (A = user journey + integration, C = protocol detail, B = Playwright tests)
**Target release:** v0.2.0 (the version AFTER the v0.1.1 CWS rejection fix)

---

## Context

The Contexta Recorder is a Chrome extension that records browser sessions and produces rich session JSON + JMeter JMX scripts. Version 0.1.0 was rejected by the Chrome Web Store for declaring the `webRequest` permission but not using it (violation "Purple Potassium").

This spec defines the **v0.2.0 end-to-end user journey** — what a new user (a perf tester installing the extension for the first time) experiences from installation to landing a usable recording in PerfOps Studio.

The spec does NOT cover the v0.1.1 CWS resubmission (a separate permission-hygiene workstream described in the Appendix) or the v0.2.1+ Playwright E2E tests (Spec B, forthcoming).

## Positioning

The Contexta Recorder is a **BlazeMeter Recorder replacement** for Contexta clients. Its competitive wedge is **full response body + full page HTML capture**, enabling server-side correlation analysis that BlazeMeter cannot match (BlazeMeter only captures request + response headers).

Tagline: *"We capture what the page actually sent back, not just the headers."*

## User primary priorities

1. Experienced JMeter users who want a clean JMX they can run directly in their own JMeter / framework. Local JMX download is first-class.
2. Perf testers using PerfOps Studio for load testing. They want the recording to land in Studio with minimal friction so Studio can do correlation / templating / script generation server-side.
3. (Later, v0.3+) Users wanting screen-recorded walkthrough video.

## Key design decisions (made during brainstorming)

| Decision | Choice |
|---|---|
| Primary user (v1) | JMeter veterans first, Studio users second |
| Track architecture | Two independent tracks: (1) local JMX + JSON download, (2) Studio integration via Approach 4 |
| Studio integration pattern | Approach 4 — Studio pulls from Chrome via `chrome.runtime.sendMessage` with `externally_connectable` |
| Post-import landing page | Option B — summary page with 3 choices (Validate step-by-step / Save and run smoke / Just save) |
| Validation responsibility | Extension does data-integrity only (JSON parses, size sane). Studio does all business validation. |
| Secrets in extension | None. No OAuth, no bearer token. Studio's session cookie handles all auth. |
| Cross-device transfer | Out of scope for v0.2.0 (blob-drop was considered and rejected — adds cost, complexity, compliance hurdle). |

## Architecture

Two parallel tracks, both permission-clean, both shipping on their own merits.

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome browser (user's device)                              │
│                                                              │
│   ┌────────────────────┐         ┌───────────────────────┐  │
│   │ Contexta Recorder  │         │ PerfOps Studio tab    │  │
│   │ extension          │         │ (logged-in user)      │  │
│   │                    │         │                       │  │
│   │ chrome.storage.    │◄────────┤  Import button →      │  │
│   │ local[recordings]  │ runtime │  chrome.runtime       │  │
│   │                    │ message │  .sendMessage(EXT_ID) │  │
│   │ service-worker.js  │────────►│  → gets JSON back     │  │
│   │ (onMessageExternal)│ runtime └───────┬───────────────┘  │
│   └────────────────────┘ message         │                  │
│            │                             │ POST (same       │
│            │ JMX/JSON file download      │  origin, session │
│            ▼                             │  cookie)         │
│   ┌────────────────────┐                 ▼                  │
│   │ Local filesystem   │       ┌────────────────────┐       │
│   │ (JMeter / airgap)  │       │ Studio Flask app   │       │
│   └────────────────────┘       │ POST /recordings/  │       │
│                                │        import      │       │
│                                └─────────┬──────────┘       │
└──────────────────────────────────────────┼──────────────────┘
                                           ▼
                            Studio DB: recorder.Recordings
                            (CompanyID-scoped, per-tenant)
```

### Key architectural properties

- **Extension is passive.** It only responds to messages from origins whitelisted in `externally_connectable.matches`. It never initiates outbound communication to Studio or any other server.
- **No secrets in the extension.** No OAuth, no bearer token, no paste-a-token UX. Chrome's IPC origin enforcement + Studio's existing session cookie provide all the auth needed.
- **Studio integration is same-origin.** Studio's JS posts to Studio's own server. No CORS, no cross-origin credentials.
- **Local track is entirely independent.** Airgap and JMeter-veteran users who never touch Studio experience no functional loss.
- **Extension does not know Studio's URL.** Only the `externally_connectable.matches` entry limits which origins may message the extension. Studio's JS tells the extension "I am Studio"; Chrome enforces the origin check.

### Prerequisites (Studio server-side, one-time)

1. SQL migration: add `CompanyID INT NULL` to `recorder.Recordings`, backfill existing admin-owned rows, then enforce `NOT NULL`.
2. Refactor `blueprints/recordings.py` into admin routes (`/admin/recordings/*` with `@require_admin`) and tenant-scoped self-service routes (`/recordings/*` with `@require_login`, filtered by `session.company_id`).
3. Add `CONTEXTA_RECORDER_EXT_ID` to Studio config, with a dev override env var.

## Components

### Extension changes

| Component | Change |
|---|---|
| `manifest.json` | Add `externally_connectable.matches` with Studio origin(s). No permission additions. |
| `background/service-worker.js` | Add `chrome.runtime.onMessageExternal` listener handling `listRecordings`, `getRecording`, `ping`. |
| `shared/storage.js` | Expose `listRecordings()` and `getRecording(id)` helpers used by the message listener. |
| `popup/popup.html` | Add hint text below download buttons: *"Or open PerfOps Studio → Recordings → Import from Contexta Recorder."* |
| `background/recorder.js`, `shared/correlator.js`, `shared/jmx-generator.js`, `shared/page-analyser.js`, etc. | Unchanged. |

### Studio changes

| Component | Change |
|---|---|
| SQL migration | Add `CompanyID` to `recorder.Recordings`. |
| `blueprints/recordings.py` | Split admin vs tenant routes. Add `POST /recordings/import` with `@require_login`. |
| `templates/recordings/index.html` (new or updated) | Tenant-scoped recordings list + "Import from Contexta Recorder" button. |
| Studio JS | Add message caller code that talks to the extension via `chrome.runtime.sendMessage(CONTEXTA_RECORDER_EXT_ID, ...)`. |
| Flask config | Add `CONTEXTA_RECORDER_EXT_ID` with dev override env var. |

### Not changed

- Recorder's correlation engine, JMX generation, full response capture, page analysis.
- Studio's UJ Builder, validate stage, save-without-validate flow, JMeter runner.

## Data flow

### Phase 1 — Record (unchanged)

User opens popup → sets journey code → clicks Start → Chrome debugger attaches to active tab → user performs flow → requests/responses captured, page HTML captured on each navigation → user clicks Stop.

### Phase 2 — Stop & Save (copy change only)

1. Debugger detaches.
2. Correlator runs. Assertions, field classification, and data requirements generated.
3. Session object stored in `chrome.storage.local.recordings[<id>]` with metadata `{id, name, createdAt, transactionCount, requestCount, sizeBytes}`.
4. Popup shows results screen with unchanged **Download JMX / JSON / HAR / CSV** buttons.
5. New hint below downloads: *"Or open PerfOps Studio → Recordings → Import from Contexta Recorder."*

### Phase 3 — Studio Import (NEW in v0.2.0)

```
User (Studio tab)          Studio JS              Extension SW           Studio Flask
     │                         │                      │                      │
     │ Click "Import from      │                      │                      │
     │ Contexta Recorder"      │                      │                      │
     ├────────────────────────►│                      │                      │
     │                         │ sendMessage(EXT_ID,  │                      │
     │                         │   {action:           │                      │
     │                         │    "listRecordings"})│                      │
     │                         ├─────────────────────►│                      │
     │                         │                      │ read chrome.storage  │
     │                         │                      │ .local.recordings    │
     │                         │ [{id,name,size,...}] │                      │
     │                         │◄─────────────────────┤                      │
     │ picker shows list       │                      │                      │
     │◄────────────────────────┤                      │                      │
     │ Picks recording X       │                      │                      │
     ├────────────────────────►│                      │                      │
     │                         │ sendMessage(EXT_ID,  │                      │
     │                         │   {action:           │                      │
     │                         │    "getRecording",   │                      │
     │                         │    id:X})            │                      │
     │                         ├─────────────────────►│                      │
     │                         │ {session: {...}}     │                      │
     │                         │◄─────────────────────┤                      │
     │                         │ POST /recordings     │                      │
     │                         │   /import (JSON)     │                      │
     │                         ├────────────────────────────────────────────►│
     │                         │                      │                      │ @require_login
     │                         │                      │                      │ session.company_id = N
     │                         │                      │                      │ INSERT CompanyID=N
     │                         │                      │                      │ _build_steps_from_session
     │                         │ 302 → /recordings/   │                      │
     │                         │   <new_id>/summary   │                      │
     │                         │◄────────────────────────────────────────────┤
     │ Lands on summary page   │                      │                      │
     │◄────────────────────────┤                      │                      │
```

### Phase 4 — Post-Import landing page

The summary page shows counts and three user choices (Q4 option B):

> **Recording imported.**
> 5 transactions · 42 requests · 8 correlations detected · 3 data fields · 1.2 MB
>
> [ Validate step-by-step (UJ Builder) ]  [ Save and run 1-user smoke ]  [ Just save to my list ]

All three paths are existing Studio flows — no new downstream work required beyond wiring the summary page to them.

### Message API contract (extension ↔ Studio)

**`listRecordings`**
```jsonc
// Request
{ "action": "listRecordings" }

// Response
{
  "recordings": [
    {
      "id": "rec_20260424_143022",
      "name": "UJ01 - Covid Booking",
      "createdAt": "2026-04-24T14:30:22Z",
      "transactionCount": 5,
      "requestCount": 42,
      "sizeBytes": 1048576
    }
  ]
}
```

**`getRecording`**
```jsonc
// Request
{ "action": "getRecording", "id": "rec_20260424_143022" }

// Response
{ "session": { /* full session JSON — same shape as JSON download */ } }
```

**`ping`** (Studio uses this to detect extension presence)
```jsonc
// Request
{ "action": "ping" }

// Response
{ "installed": true, "version": "0.2.0" }
```

If the extension is not installed, `chrome.runtime.sendMessage` to the extension ID fails with `lastError` — Studio treats this as "not installed" and shows an install CTA instead of the picker.

## Error handling

### Communication errors (Studio ↔ Extension)

| Condition | Detection | User sees |
|---|---|---|
| Extension not installed | `chrome.runtime.lastError`; no `ping` response | "Contexta Recorder extension not detected. [Install it →]" |
| Extension installed but disabled | Same symptom | Same message |
| Extension installed but old version (pre-Approach-4) | `ping` fails because handler doesn't exist | "Extension needs updating to v0.2.0 or later." |
| Service worker cold start | First message delayed ~500ms | Loading spinner from click; no special handling |
| Message timeout (>5s no response) | `setTimeout` in Studio JS | "Extension didn't respond. [Retry] or [Refresh the page]." |

### Recording data errors (data-integrity only; business validation happens in Studio's UJ Builder)

| Condition | Detection | User sees |
|---|---|---|
| Zero recordings in storage | `listRecordings` returns `{recordings: []}` | "No recordings yet. Record a flow first." |
| Recording deleted between list and get | `getRecording` returns `{error: "not_found"}` | "Recording no longer exists. Pick another." |
| Recording JSON parse failure in extension | Try/catch in storage read; returns `{error: "corrupted"}` | "Recording is corrupted. [Download as file for support]" |
| Recording larger than 50MB | Size check before response; returns `{error: "too_large", sizeMB}` | "Recording is {N}MB, too large for direct import. [Download JSON file] then upload manually." |

### Studio ingestion errors

| Condition | Detection | User sees |
|---|---|---|
| Session missing `company_id` (edge case) | Flask route check | 403 → "Your account isn't linked to a company. Contact support." |
| DB insert fails | Exception in route | 500 → "Save failed. The recording is still in your extension — [Retry]." |
| Payload fails `_build_steps_from_session` structure check | Caught, sanitised error logged | 400 → "Recording format unrecognised. [Report — attach JSON]." |
| POST body exceeds Flask `MAX_CONTENT_LENGTH` | Flask rejects before route runs | 413 → "Recording too large. Try a shorter flow." |
| CSRF token missing / invalid | Existing Flask CSRF middleware | 403 → "Session expired. Refresh and try again." |

### Security boundaries

| Risk | Mitigation |
|---|---|
| Malicious page tries to scan/message the extension | `externally_connectable.matches` enforces origin at Chrome IPC layer |
| Malicious extension tries to intercept Studio data | Studio JS sends only to the specific `CONTEXTA_RECORDER_EXT_ID` |
| Phishing site claiming to be Studio (e.g. `studi0.perfops.studio`) | Not in `externally_connectable.matches` → Chrome rejects messages |
| CSRF on `/recordings/import` | Existing Flask CSRF token infrastructure |
| Replay attack (reusing captured POST) | CSRF token is per-session; session cookie binds to user |
| XSS in Studio → auto-import under different user | Same blast radius as any Studio XSS; not worsened by this feature; usual XSS defenses apply |

### UX recovery patterns

- Every error message shows the user their next step. Never "something went wrong, try again."
- **Retry** button on transient errors (timeout, 5xx). Disabled on permanent ones (corrupted, too large).
- **File download fallback** on every data/ingestion failure — download JSON and use a Studio file-picker upload path as a durable backup.
- Studio-side logging of failed imports with anonymised metadata (size, error class, user agent) for triage.

## Testing

Deferred to **Spec B — Playwright E2E tests** (next spec in the sequence). This spec's success criteria for manual testing:

1. Fresh Chrome profile with extension installed → record a flow on a test site → JMX downloads and runs in JMeter at 1 user → all transactions green.
2. Same recording → open Studio tab → click Import → picker shows the recording → click to import → lands on summary page with non-zero counts for transactions/requests/correlations.
3. Uninstall extension → same Studio flow → sees "extension not detected" install CTA.
4. Delete recording from popup → Studio Import picker → recording is gone from the list.
5. Record a 100MB flow → Import → sees "too large, download file" fallback message with working download link.

## Appendix A — v0.1.1 CWS resubmission (separate workstream)

Not part of this spec, but documented here for context.

The rejected submission is preserved as `contexta-recorder.zip` (manifest v0.1.0, dated 2026-03-31). The resubmission is the **current codebase** (with full response capture, PerfOps Studio rename, enhanced correlator — all added since v0.1.0) minus declared-but-unused permissions.

**Permission delta for v0.1.1:**

| Current | Action | Reason |
|---|---|---|
| `webRequest` | Remove | Zero `chrome.webRequest.*` calls (this was Google's rejection reason) |
| `activeTab` | Keep | Declarative, used by popup |
| `storage` | Keep | 18 `chrome.storage.*` call sites |
| `unlimitedStorage` | Keep | Needed for full-response capture (MB-sized sessions) |
| `tabs` | Keep | 4 `chrome.tabs.*` call sites |
| `downloads` | Keep | JMX/JSON/HAR/CSV download |
| `debugger` | Keep | Core recording engine |
| `identity` | Remove | Used only by auth UI being stripped |

**Code delta for v0.1.1:**
- Strip auth UI from `popup/popup.html` (sign-in form, OAuth buttons, logged-in badge, cloud actions, sign-in prompts).
- Strip auth code from `popup/popup.js` (`chrome.identity.*`, sign-in/out handlers).
- Strip NHS Dashboard URL field from `options/options.html` and `options/options.js`.
- Version bump `0.1.0` → `0.1.1`.
- Everything else unchanged — all features stay.

**Store listing note to provide to CWS reviewer:**
- `unlimitedStorage` justification: *"We capture full HTML response bodies per page navigation to support server-side correlation analysis. Sessions can exceed 10MB. `unlimitedStorage` prevents `chrome.storage.local` from throwing `QUOTA_BYTES` errors mid-recording."*

## Appendix B — Rejected alternatives and why

| Alternative | Why rejected |
|---|---|
| Approach 3: extension pushes to Studio API with pasted bearer token | Introduces a secret in the client bundle, token lifecycle burden (generate/rotate/revoke/expiry UX), extra API surface to secure. Approach 4 avoids all of this without losing capability. |
| Approach 5: encrypted blob drop with pickup-by-code | Adds storage cost, abuse surface (anonymous uploads), compliance hurdle (third-party vendor in data path), and URL-fragment leak risk. Only added capability is cross-device transfer — not a priority for v0.2.0 and solvable with JSON file export if ever needed. |
| Embedded video walkthrough recording | Requires `tabCapture` or `desktopCapture` permission. Google's rejection policy explicitly forbids declaring permissions for unimplemented features. Deferred to v0.3.0 when the feature is actually built. |
| Direct Studio push in v0.1.1 | Same policy problem — can't add permissions ahead of working code. v0.1.1 is pure cleanup; integration lands together in v0.2.0. |

## Open questions

None at time of writing. All brainstorming questions resolved.

---

**Next step:** Implementation plan via `superpowers:writing-plans` skill after user review.
