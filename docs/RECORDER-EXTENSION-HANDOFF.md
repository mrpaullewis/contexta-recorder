# Contexta Recorder Extension — Backend Handoff

Backend API documentation for the Contexta Recorder Chrome extension. This covers authentication, recording storage, fingerprint sync, and feature gating.

---

## 1. Architecture Overview

```
Chrome Extension                          Assure SaaS
┌─────────────────┐                ┌──────────────────────────┐
│  Recorder UI    │                │  /api/v1/auth/*          │
│                 │  ── JWT ──►    │  /api/v1/recordings/*    │
│  Local storage  │                │  /api/v1/fingerprint-*   │
│  (guest mode)   │                │  /api/v1/shared/*        │
│                 │                │                          │
│  Popup + Panel  │  ── API Key ►  │  /nfr-perftest/api/v1/*  │
│  Options page   │  (legacy)      │  (framework endpoints)   │
└─────────────────┘                └──────────────────────────┘
```

- **Guest mode**: Everything works locally. No server calls, no account needed.
- **Free account**: Self-signup creates a personal workspace. Enables cloud save, history, share links.
- **Team member**: Invited to an existing company with Assure subscription. Enables push-to-assure, data specs, fingerprint sync.

---

## 2. Authentication

### 2.1 Self-Signup (Register)

```
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "phil@example.com",
  "name": "Phil Lewis",
  "password": "securepassword123"
}

Response 201:
{
  "token": "eyJhbGciOi...",
  "expires_at": "2026-04-01T10:00:00+00:00",
  "user": {
    "id": 42,
    "email": "phil@example.com",
    "name": "Phil Lewis",
    "role": "admin",
    "org": {
      "id": 15,
      "name": "Phil Lewis's Workspace",
      "plan": "free"
    },
    "projects": [],
    "features": ["cloud_storage", "share_link"]
  }
}

Response 400: { "error": "missing_fields" | "weak_password" }
Response 409: { "error": "email_taken" }
```

Creates a new company on the Free tier with the user as admin. The company code is auto-generated as `USR-{hash}`.

### 2.2 Login

```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "phil@example.com",
  "password": "securepassword123"
}

Response 200:
{
  "token": "eyJhbGciOi...",
  "expires_at": "2026-04-01T10:00:00+00:00",
  "user": { ... same shape as register ... }
}

Response 401: { "error": "invalid_credentials" }
```

### 2.3 Token Refresh

```
POST /api/v1/auth/refresh
Authorization: Bearer <expired-or-valid-token>

Response 200:
{
  "token": "eyJhbGciOi...(fresh token)",
  "expires_at": "2026-04-02T10:00:00+00:00"
}

Response 401: { "error": "token_expired" }  (token > 7 days old)
```

Tokens are valid for 24 hours. Refresh accepts tokens up to 7 days past expiry.

### 2.4 Get Current User

```
GET /api/v1/auth/me
Authorization: Bearer <token>

Response 200:
{
  "user": { ... same shape as login, without token/expires_at ... }
}

Response 401: { "error": "Invalid token" }
```

Use this on extension startup to validate the stored token and get fresh feature flags.

### 2.5 Auth Header

All authenticated requests use:

```
Authorization: Bearer <jwt-token>
```

The extension should fall back to `X-API-Key: ctx_...` if a legacy API key is configured and no JWT is present.

---

## 3. Feature Flags

The `features` array in the user object controls what the extension shows. The extension reads this list and shows/hides UI elements accordingly.

| Feature flag | What it enables | Available on |
|---|---|---|
| `cloud_storage` | "Save to Cloud" button, recording history | Free, Pro, Enterprise |
| `share_link` | Generate shareable recording links | Free, Pro, Enterprise |
| `push_to_assure` | "Push to Assure" button, project picker | Pro, Enterprise |
| `shared_library` | Access team recordings and journey configs | Pro, Enterprise |
| `data_specs` | Pull DataFileSpecs for CSV column mapping | Pro, Enterprise |
| `team_sync` | Sync options/defaults from team settings | Pro, Enterprise |
| `fingerprint_sync` | Share question fingerprints with team | Pro, Enterprise |

**Rule:** If a feature is not in the list, the corresponding button/section is hidden. No error messages, no paywall modals.

---

## 4. Extension Behaviour by Auth State

### Popup UI

| Element | Guest | Free User | Team Member | Admin |
|---|---|---|---|---|
| Record/Stop/Pause | Yes | Yes | Yes | Yes |
| Download JMX/HAR/JSON/CSV | Yes | Yes | Yes | Yes |
| "Sign in" link | Shown | Hidden | Hidden | Hidden |
| Account badge (name + org) | Hidden | Shown | Shown | Shown |
| "Save to Cloud" button | Hidden | Shown | Shown | Shown |
| "Push to Assure" button | Hidden | Hidden | Shown | Shown |
| Project picker dropdown | Hidden | Hidden | Shown | Shown |
| "Pull Data Specs" button | Hidden | Hidden | Shown | Shown |
| Recording history link | Hidden | Shown | Shown | Shown |

### On Extension Startup

1. Check for stored JWT token in `chrome.storage.local`
2. If token exists, call `GET /api/v1/auth/me` to validate
3. If valid: show user badge, enable features per `features` array
4. If 401: try `POST /api/v1/auth/refresh`
5. If refresh fails: clear token, show "Sign in" link — all local features still work
6. If no token: guest mode, everything local

---

## 5. Recording Storage API

### 5.1 Save Recording

```
POST /api/v1/recordings
Authorization: Bearer <token>
Content-Type: application/json

{
  "recording": { ... full session object (see ASSURE-RECORDER-API.md §4) ... },
  "project_id": 123  (optional, null for personal library — maps to SystemID)
}

Response 201:
{
  "recording_id": 456,
  "created_at": "2026-03-31T14:30:00+00:00"
}
```

The server extracts metadata (journey code, counts, duration) from the recording JSON and stores it in indexed columns. The full JSON goes to Azure Blob Storage. Page response bodies (`pageResponses`) are stripped from the main blob and stored individually for size management.

### 5.2 List Recordings

```
GET /api/v1/recordings?project_id=123&limit=20&offset=0
Authorization: Bearer <token>

Response 200:
{
  "recordings": [
    {
      "recording_id": 456,
      "client_id": "uuid-from-extension",
      "journey_code": "COVID",
      "base_url": "https://www.nhs.uk",
      "transaction_count": 8,
      "request_count": 24,
      "correlation_count": 5,
      "data_field_count": 12,
      "assertion_count": 3,
      "duration_ms": 45000,
      "recording_mode": "auto",
      "summary": "COVID — 8 steps, 5 correlations, 12 data fields",
      "created_at": "2026-03-31T14:30:00",
      "created_by": "Phil Lewis",
      "system": { "id": 123, "name": "NHS Booking", "code": "NHS" }
    }
  ],
  "total": 42
}
```

Query params:
- `project_id` (int, optional) — filter by Assure system
- `limit` (int, default 20, max 100)
- `offset` (int, default 0)

### 5.3 Get Full Recording

```
GET /api/v1/recordings/456
Authorization: Bearer <token>

Response 200:
{
  "recording_id": 456,
  "created_at": "2026-03-31T14:30:00",
  "created_by": { "id": 42, "name": "Phil Lewis" },
  "system": { "id": 123, "name": "NHS Booking", "code": "NHS" },
  "recording": { ... full session JSON from blob storage ... }
}
```

### 5.4 Delete Recording

```
DELETE /api/v1/recordings/456
Authorization: Bearer <token>

Response 200: { "ok": true }
Response 404: { "error": "not_found" }
```

Deletes the DB row, all associated blobs, and any share links.

### 5.5 Share Recording

```
POST /api/v1/recordings/456/share
Authorization: Bearer <token>

Response 200:
{
  "share_token": "abc123...",
  "share_url": "https://app.contexta.uk/api/v1/shared/abc123...",
  "expires_at": "2026-04-07T14:30:00+00:00"
}
```

Share links expire after 7 days by default.

### 5.6 Access Shared Recording (Public)

```
GET /api/v1/shared/<share_token>
(No auth required)

Response 200:
{
  "recording_id": 456,
  "recording": { ... full session JSON ... },
  "summary": "COVID — 8 steps, 5 correlations",
  "journey_code": "COVID",
  "base_url": "https://www.nhs.uk",
  "created_at": "2026-03-31T14:30:00",
  "created_by": "Phil Lewis"
}

Response 404: { "error": "not_found" }
Response 410: { "error": "expired" }
```

---

## 6. Fingerprint Config Sync API

Fingerprints let recordings reuse known answers across environments and sessions. When a team member records a journey, their fingerprint configs are shared with the team.

### 6.1 Save Fingerprint Configs (bulk)

```
POST /api/v1/fingerprint-configs
Authorization: Bearer <token>
Content-Type: application/json

{
  "project_id": 123,
  "journey_code": "COVID",
  "configs": [
    {
      "key": "What is your name?|Firstname,Surname",
      "heading": "What is your name?",
      "fields": ["Firstname", "Surname"],
      "page_type": "form",
      "answers": { "Firstname": "John", "Surname": "Smith" },
      "sources": { "Firstname": "recorded_value", "Surname": "csv:Firstname" }
    }
  ]
}

Response 200:
{ "ok": true, "saved": 8, "updated": 2 }
```

Upserts on `(CompanyID, SystemID, FingerprintKey)`. Existing configs with the same key are updated; new ones are inserted.

### 6.2 Get Fingerprint Configs

```
GET /api/v1/fingerprint-configs?project_id=123&journey_code=COVID
Authorization: Bearer <token>

Response 200:
{
  "configs": [
    {
      "config_id": 789,
      "journey_code": "COVID",
      "key": "What is your name?|Firstname,Surname",
      "heading": "What is your name?",
      "fields": ["Firstname", "Surname"],
      "page_type": "form",
      "answers": { "Firstname": "John", "Surname": "Smith" },
      "sources": { "Firstname": "recorded_value", "Surname": "csv:Firstname" },
      "updated_at": "2026-03-31T14:30:00",
      "updated_by": "Phil Lewis"
    }
  ]
}
```

Query params:
- `project_id` (int, required) — Assure SystemID
- `journey_code` (string, optional) — filter by journey

---

## 7. Existing Endpoints (no changes needed)

These are already built and the extension can continue using them:

| Endpoint | Purpose |
|---|---|
| `POST /nfr-perftest/api/v1/scripts/manifest` | Push script manifests |
| `POST /nfr-perftest/run-builder/configs` | Push run config + JMX |
| `GET /nfr-perftest/data-generator/specs?system_id=123` | Pull DataFileSpecs |
| `GET /health` | Connection test |

These currently use `X-API-Key` auth. They will also accept `Authorization: Bearer <jwt>` once the user is logged in, since the `@require_context` decorator now supports both.

---

## 8. Database Schema (Assure side)

Three new tables in the `nfr_perftest` schema:

### Recordings
- `RecordingID` (int, PK, auto-increment)
- `CompanyID` (FK to Companies)
- `ClientID` (extension-generated UUID, unique, for deduplication)
- `UserID` (FK to Users)
- `SystemID` (FK to Systems, nullable = personal library)
- Metadata columns: JourneyCode, BaseUrl, TargetHost, TransactionCount, RequestCount, CorrelationCount, DataFieldCount, AssertionCount, DurationMs, RecordingMode
- `BlobPath` — path to `session.json` in Azure Blob Storage
- `PageBlobPath` — prefix for individual page HTML blobs
- `Summary` — human-readable one-liner for listing

### SharedRecordingLinks
- `LinkID` (int, PK)
- `RecordingID` (FK)
- `ShareToken` (unique varchar for URL)
- `ExpiresAt` (datetime2)

### FingerprintConfigs
- `ConfigID` (int, PK)
- `CompanyID`, `SystemID` (tenant + project scoping)
- `FingerprintKey` (unique per company+system)
- `Fields`, `Answers`, `Sources` (JSON columns)

---

## 9. Blob Storage Layout

```
company-{code}/
  recordings/
    {recording_id}/
      session.json          ← Full recording minus pageResponses
      pages/
        0.html              ← Page response body for seq 0
        1.html              ← Page response body for seq 1
        ...
```

- Container per company: `company-{company_code.lower()}`
- Session JSON typically 50-500KB (without page bodies)
- Individual page bodies can be 30-100KB each
- Page bodies are stripped from the main JSON before upload

---

## 10. Error Responses

All error responses follow this shape:

```json
{
  "error": "error_code",
  "message": "Human-readable description"
}
```

| HTTP Status | Error Code | Meaning |
|---|---|---|
| 400 | `missing_fields` | Required fields not provided |
| 400 | `weak_password` | Password < 8 characters |
| 400 | `missing_recording` | Recording object not in request body |
| 400 | `missing_project_id` | project_id required but not provided |
| 401 | `invalid_credentials` | Wrong email or password |
| 401 | `token_expired` | JWT expired and too old to refresh |
| 404 | `not_found` | Resource not found or not accessible |
| 404 | `invalid_project` | Project doesn't exist or user can't access it |
| 409 | `email_taken` | Account with this email already exists |
| 410 | `expired` | Share link has expired |

---

## 11. Testing Against Dev

1. **Base URL**: `https://dev.contexta.uk`
2. **Register**: `POST /api/v1/auth/register` with a test email
3. **Login**: `POST /api/v1/auth/login` to get a JWT
4. **Save a recording**: `POST /api/v1/recordings` with a sample session JSON
5. **List**: `GET /api/v1/recordings` to see it
6. **Share**: `POST /api/v1/recordings/{id}/share` to get a public link
7. **View shared**: `GET /api/v1/shared/{token}` (no auth)

For team features (push to assure, data specs, fingerprints), you need:
- A company on Professional or Enterprise tier
- An Assure system created in the web UI
- The user assigned to that company

The existing demo user `jmeter@contexta.uk` / `DemoTest123!` (Company 1, Enterprise) has Assure systems and will return all feature flags.

---

## 12. CORS

Chrome extensions make `fetch()` calls from the `chrome-extension://` origin, which is not subject to CORS. No CORS configuration changes are needed on the Assure side.

If using the API from a web page (e.g. for the shared recording viewer), standard CORS headers may need to be added — but this is not a current requirement.
