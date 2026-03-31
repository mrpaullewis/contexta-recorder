# Contexta Recorder — Assure SaaS Integration Spec

Handoff document for the Assure SaaS team. Defines the user model, authentication flow, and API endpoints the Chrome extension requires to support login, recording storage, and cloud features.

---

## 1. User Types

The recorder is free and standalone — no account needed for core features (record, analyse, download JMX/HAR/JSON/CSV). Login unlocks cloud features and is the entry point into the Assure sales funnel.

### Guest (no account)

- All recording, analysis, and export features work locally
- No server calls, no login required
- Recordings stored in Chrome local storage (last 20 sessions)
- This is the default experience — zero friction

### Free User (personal account, no org)

Has a Contexta account but no paid subscription.

| Feature | Description |
|---|---|
| Cloud recording storage | Save recordings to Assure, access from any device |
| Recording history | Browse and reload past recordings |
| Share via link | Generate a shareable link to a recording |
| Basic data specs | Access public/demo DataFileSpecs |

**Purpose:** Captures the lead. Gets them using cloud features so they see the value of Assure.

### Team Member (belongs to an Assure org)

Invited by an admin, assigned to one or more projects.

| Feature | Description |
|---|---|
| Everything Free gets | Plus all below |
| Push to Assure | Upload recordings, manifests, and JMX to a project |
| Pull DataFileSpecs | Use team data specs for CSV column mapping |
| Shared journey library | Access team recordings and journey configs |
| Project picker | Choose which Assure project to push to |
| Fingerprint config sync | Share question fingerprints across the team |

**Purpose:** The working user on a paying team.

### Team Admin

Everything a member gets, plus:

| Feature | Description |
|---|---|
| Project management | Control which projects are available in the extension |
| Team defaults | Set default naming conventions, excluded domains, journey codes |
| API key management | Generate/revoke API keys for the team |
| Member management | Invite/remove members (done in Assure web UI, not the extension) |

**Purpose:** The buyer/decision-maker. Admin features are mostly in the Assure web UI, not the extension.

### Read-Only / Stakeholder (optional)

- View-only access to recordings and results in Assure web UI
- No extension access needed — they consume reports, not author scripts
- Useful for delivery managers, product owners, service managers

---

## 2. Authentication

### Current State

The extension currently uses `X-API-Key` header for Assure API calls, configured manually in the options page. This works but doesn't support user identity, roles, or the free tier.

### Required: OAuth / JWT Login Flow

The extension needs a proper login flow that returns user identity and feature entitlements.

#### Login Endpoint

```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "phil@contexta.uk",
  "password": "..."
}

Response 200:
{
  "token": "eyJhbGciOi...",
  "expires_at": "2026-04-01T10:00:00Z",
  "user": {
    "id": "uuid",
    "email": "phil@contexta.uk",
    "name": "Phil Lewis",
    "role": "admin",
    "org": {
      "id": "uuid",
      "name": "Contexta",
      "plan": "pro"
    },
    "projects": [
      {
        "id": "uuid",
        "name": "NHS Covid Booking",
        "code": "COVID",
        "system_id": 123
      }
    ],
    "features": [
      "cloud_storage",
      "push_to_assure",
      "shared_library",
      "data_specs",
      "team_sync",
      "fingerprint_sync"
    ]
  }
}

Response 401:
{ "error": "invalid_credentials", "message": "Invalid email or password" }
```

#### Token Refresh

```
POST /api/v1/auth/refresh
Authorization: Bearer <token>

Response 200:
{
  "token": "eyJhbGciOi...(new token)",
  "expires_at": "2026-04-01T22:00:00Z"
}

Response 401:
{ "error": "token_expired", "message": "Token has expired, please log in again" }
```

#### Get Current User (for extension startup)

```
GET /api/v1/auth/me
Authorization: Bearer <token>

Response 200:
(same user object as login response, without token)

Response 401:
{ "error": "unauthorized" }
```

### Feature Flags

The `features` array in the user object controls what the extension shows. This is the key mechanism — the extension doesn't hardcode tier logic, it reads the features list.

| Feature flag | What it enables in the extension |
|---|---|
| `cloud_storage` | "Save to Cloud" button, recording history |
| `push_to_assure` | "Push to Assure" button, project picker |
| `shared_library` | Access team recordings and journey configs |
| `data_specs` | Pull DataFileSpecs for CSV column mapping |
| `team_sync` | Sync options/defaults from team settings |
| `fingerprint_sync` | Share question fingerprints with team |
| `share_link` | Generate shareable recording links |

If a feature is not in the list, the button/section is hidden. No error, no paywall — just not shown. The Assure web UI handles upsell messaging.

### Auth Header

All authenticated API calls from the extension use:

```
Authorization: Bearer <jwt-token>
```

The extension falls back to `X-API-Key` if a legacy key is configured and no JWT is present — this supports existing integrations.

---

## 3. Recording Storage API

This is the core new capability. When a logged-in user clicks "Save to Cloud", the extension pushes the full recording session to Assure.

### Save Recording

```
POST /api/v1/recordings
Authorization: Bearer <token>
Content-Type: application/json

{
  "recording": { ... full session object, see section 4 ... },
  "project_id": "uuid" (optional, null for personal library)
}

Response 201:
{
  "recording_id": "uuid",
  "url": "https://app.contexta.uk/recordings/uuid",
  "created_at": "2026-03-31T14:30:00Z"
}
```

### List Recordings

```
GET /api/v1/recordings?project_id=uuid&limit=20&offset=0
Authorization: Bearer <token>

Response 200:
{
  "recordings": [
    {
      "recording_id": "uuid",
      "journey_code": "COVID",
      "base_url": "https://www.nhswebsite-staging.nhs.uk",
      "transaction_count": 8,
      "request_count": 24,
      "correlation_count": 5,
      "created_at": "2026-03-31T14:30:00Z",
      "created_by": "Phil Lewis",
      "duration_ms": 45000,
      "summary": "Covid booking flow — 8 steps, 5 correlations, 12 parameterised fields"
    }
  ],
  "total": 42
}
```

### Get Recording

```
GET /api/v1/recordings/<recording_id>
Authorization: Bearer <token>

Response 200:
{
  "recording_id": "uuid",
  "recording": { ... full session object ... },
  "created_at": "2026-03-31T14:30:00Z",
  "created_by": { "id": "uuid", "name": "Phil Lewis" },
  "project": { "id": "uuid", "name": "NHS Covid Booking" }
}
```

### Delete Recording

```
DELETE /api/v1/recordings/<recording_id>
Authorization: Bearer <token>

Response 200:
{ "ok": true }
```

### Share Recording

```
POST /api/v1/recordings/<recording_id>/share
Authorization: Bearer <token>

Response 200:
{
  "share_url": "https://app.contexta.uk/shared/abc123",
  "expires_at": "2026-04-07T14:30:00Z"
}
```

---

## 4. Recording Session Data Model

This is the complete JSON structure the extension sends when saving a recording. Assure needs to store this as-is (JSONB or similar) and index the metadata fields for listing/searching.

```json
{
  "id": "uuid",
  "journeyCode": "COVID",
  "mode": "auto",
  "startTime": "2026-03-31T14:00:00Z",
  "endTime": "2026-03-31T14:02:30Z",
  "baseUrl": "https://www.nhswebsite-staging.nhs.uk",
  "targetHost": "www.nhswebsite-staging.nhs.uk",
  "protocol": "https",
  "port": "443",

  "options": {
    "namingConvention": "nhs",
    "stepPadding": 2
  },

  "transactions": [
    {
      "code": "COVID",
      "stepNumber": 1,
      "name": "Covid_S01_proxy-booking-question",
      "startTime": "2026-03-31T14:00:01Z",
      "endTime": "2026-03-31T14:00:12Z",
      "requests": [
        {
          "seq": 0,
          "method": "GET",
          "url": "https://www.nhswebsite-staging.nhs.uk/nbs/booking-question",
          "path": "/nbs/booking-question",
          "headers": { "Accept": "text/html", "Cookie": "session=abc123" },
          "queryParams": {},
          "body": null,
          "bodyType": null,
          "timestamp": "2026-03-31T14:00:01Z",
          "resourceType": "Document",

          "response": {
            "status": 200,
            "statusText": "OK",
            "headers": {
              "Content-Type": "text/html",
              "Set-Cookie": "session=abc123; Path=/"
            },
            "contentType": "text/html",
            "bodySnippet": "first 64KB of response body (for correlation scanning)",
            "timing": {
              "dns": 5,
              "connect": 12,
              "ssl": 8,
              "ttfb": 145,
              "total": 210
            },
            "size": 28400
          },

          "formFields": [
            {
              "name": "SelectedOption",
              "type": "radio",
              "value": "Myself",
              "label": "Book for myself",
              "placeholder": "",
              "required": false,
              "isHidden": false,
              "options": [
                { "value": "Myself", "label": "Book for myself", "selected": true },
                { "value": "SomeoneElse", "label": "Book for someone else", "selected": false }
              ],
              "classification": "radio"
            },
            {
              "name": "__RequestVerificationToken",
              "type": "hidden",
              "value": "CfDJ8_abc123...",
              "label": "",
              "isHidden": true,
              "classification": "csrf"
            }
          ],

          "pageTitle": "Are you booking for yourself? - Book a vaccination - NHS",
          "pageHeading": "Are you booking for yourself or someone else?",

          "pageAnalysis": {
            "heading": "Are you booking for yourself or someone else?",
            "subHeadings": [],
            "summary": "",
            "summaryLists": [],
            "tables": [],
            "errors": [],
            "breadcrumbs": ["Home", "Vaccinations", "Book"],
            "landmarks": ["banner", "main", "contentinfo"],
            "pageType": "form"
          }
        }
      ]
    }
  ],

  "correlations": [
    {
      "name": "RequestVerificationToken",
      "type": "csrf",
      "extractType": "regex",
      "extractRegex": "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
      "extractJsonPath": null,
      "sourceTransaction": "COVID",
      "sourceRequestSeq": 0,
      "sourceUrl": "https://www.nhswebsite-staging.nhs.uk/nbs/booking-question",
      "sourceLocation": "hidden_input",
      "sampleValue": "CfDJ8_abc123...",
      "cookieName": null,
      "allSources": [
        { "transaction": "COVID", "seq": 0 },
        { "transaction": "COVID", "seq": 2 },
        { "transaction": "COVID", "seq": 4 }
      ],
      "usedInRequests": [
        { "transaction": "COVID", "seq": 1, "field": "__RequestVerificationToken" },
        { "transaction": "COVID", "seq": 3, "field": "__RequestVerificationToken" },
        { "transaction": "COVID", "seq": 5, "field": "__RequestVerificationToken" }
      ]
    },
    {
      "name": "selectedSiteId",
      "type": "dynamic_id",
      "extractType": "regex",
      "extractRegex": "name=\"selectedSiteId\" value=\"([^\"]+)\"",
      "sourceTransaction": "COVID",
      "sourceRequestSeq": 4,
      "sourceUrl": "https://www.nhswebsite-staging.nhs.uk/nbs/choose-site",
      "sourceLocation": "hidden_input",
      "sampleValue": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "usedInRequests": [
        { "transaction": "COVID", "seq": 5, "field": "selectedSiteId" }
      ]
    }
  ],

  "dataRequirements": [
    {
      "fieldName": "Firstname",
      "fieldType": "text",
      "classification": "input",
      "transaction": "COVID",
      "requestSeq": 3,
      "sampleValue": "John",
      "label": "First name",
      "suggestedCsvColumn": "Firstname",
      "assureColumnType": "first_name",
      "datafileSpecId": null,
      "datafileColumn": null
    },
    {
      "fieldName": "SelectedOption",
      "fieldType": "radio",
      "classification": "radio",
      "transaction": "COVID",
      "requestSeq": 1,
      "sampleValue": "Myself",
      "label": "Book for myself",
      "suggestedCsvColumn": "SelectedOption",
      "assureColumnType": "choice",
      "datafileSpecId": null,
      "datafileColumn": null
    }
  ],

  "assertions": [
    {
      "transaction": "Covid_S01_proxy-booking-question",
      "requestSeq": 0,
      "type": "title",
      "field": "Assertion.response_data",
      "expected": "Are you booking for yourself?",
      "testType": 2,
      "not": false
    },
    {
      "transaction": "Covid_S01_proxy-booking-question",
      "requestSeq": 0,
      "type": "heading",
      "field": "Assertion.response_data",
      "expected": "Are you booking for yourself or someone else?",
      "testType": 2,
      "not": false
    },
    {
      "transaction": "Covid_S01_proxy-booking-question",
      "requestSeq": 0,
      "type": "negative",
      "field": "Assertion.response_data",
      "expected": "session expired",
      "testType": 6,
      "not": true
    }
  ],

  "fingerprints": [
    {
      "heading": "Are you booking for yourself or someone else?",
      "fields": ["SelectedOption"],
      "key": "Are you booking for yourself or someone else?|SelectedOption",
      "transaction": "COVID",
      "requestSeq": 0,
      "pageType": "form",
      "answers": { "SelectedOption": "Myself" },
      "sources": { "SelectedOption": "recorded_value" }
    },
    {
      "heading": "What is your name?",
      "fields": ["Firstname", "Surname"],
      "key": "What is your name?|Firstname,Surname",
      "transaction": "COVID",
      "requestSeq": 2,
      "pageType": "form",
      "answers": { "Firstname": "John", "Surname": "Smith" },
      "sources": { "Firstname": "recorded_value", "Surname": "recorded_value" }
    }
  ],

  "pageResponses": [
    {
      "seq": 0,
      "url": "https://www.nhswebsite-staging.nhs.uk/nbs/booking-question",
      "path": "/nbs/booking-question",
      "transaction": "COVID",
      "body": "<!DOCTYPE html><html>... full HTML page content ..."
    }
  ]
}
```

### Storage Notes

- **`pageResponses`** contains full HTML pages (can be 30-100KB each). These are needed for re-running correlation analysis but are expensive to store. Consider:
  - Storing them in blob/object storage rather than the database
  - Stripping them from the listing endpoint (only return on full GET)
  - Setting a retention policy (e.g. 90 days, then strip page bodies)
- **`response.bodySnippet`** on each request is the first 64KB — also large, same storage consideration
- **`correlations`**, **`dataRequirements`**, **`assertions`**, **`fingerprints`** are the high-value analysis data — always keep these
- The session `id` is a UUID generated client-side. Assure should use its own `recording_id` as the primary key and store the client `id` for deduplication

### Indexable Metadata (for listing/search)

These fields should be extracted into columns for efficient querying:

| Field | Type | Source |
|---|---|---|
| `recording_id` | UUID (PK) | Assure-generated |
| `client_id` | UUID (unique) | `recording.id` |
| `user_id` | UUID (FK) | From auth token |
| `project_id` | UUID (FK, nullable) | From request body |
| `journey_code` | varchar(50) | `recording.journeyCode` |
| `base_url` | varchar(500) | `recording.baseUrl` |
| `target_host` | varchar(200) | `recording.targetHost` |
| `transaction_count` | int | `recording.transactions.length` |
| `request_count` | int | Sum of requests across transactions |
| `correlation_count` | int | `recording.correlations.length` |
| `data_field_count` | int | `recording.dataRequirements.length` |
| `assertion_count` | int | `recording.assertions.length` |
| `duration_ms` | int | `endTime - startTime` |
| `recording_mode` | varchar(20) | `recording.mode` |
| `created_at` | datetime | Server timestamp |

---

## 5. Fingerprint Config Sync API

Fingerprints let recordings reuse known answers across environments and sessions. When a team member records a journey, their fingerprint configs should be available to the whole team.

### Save Fingerprint Configs (bulk, from a recording)

```
POST /api/v1/fingerprint-configs
Authorization: Bearer <token>
Content-Type: application/json

{
  "project_id": "uuid",
  "journey_code": "COVID",
  "configs": [
    {
      "key": "What is your name?|Firstname,Surname",
      "heading": "What is your name?",
      "fields": ["Firstname", "Surname"],
      "page_type": "form",
      "answers": { "Firstname": "John", "Surname": "Smith" },
      "sources": { "Firstname": "recorded_value", "Surname": "recorded_value" }
    }
  ]
}

Response 200:
{ "ok": true, "saved": 8, "updated": 2 }
```

### Get Fingerprint Configs (for a project)

```
GET /api/v1/fingerprint-configs?project_id=uuid&journey_code=COVID
Authorization: Bearer <token>

Response 200:
{
  "configs": [
    {
      "config_id": "uuid",
      "key": "What is your name?|Firstname,Surname",
      "heading": "What is your name?",
      "fields": ["Firstname", "Surname"],
      "page_type": "form",
      "answers": { "Firstname": "John", "Surname": "Smith" },
      "sources": { "Firstname": "recorded_value", "Surname": "csv:Firstname" },
      "updated_at": "2026-03-31T14:30:00Z",
      "updated_by": "Phil Lewis"
    }
  ]
}
```

The extension uses these to auto-fill form values during recording — if a page matches a known fingerprint, the user doesn't need to type the answers again.

---

## 6. Existing Endpoints the Extension Already Uses

These are already defined in Assure. The recorder will continue to call them for push-to-assure functionality. Listed here for completeness — no changes needed unless noted.

### Push Script Manifest

```
POST /api/v1/manifests
Authorization: Bearer <token>
Body: { system_code, scripts: [...] }
```

The recorder builds the manifest from the recording session — each transaction becomes a script entry with endpoints, variables, CSV datasets, and assertions extracted automatically.

### Push Run Config + JMX

```
POST /nfr-perftest/run-builder/configs
Authorization: Bearer <token>
Body: { system_id, name, config: {...}, jmx: "<xml>..." }
```

### Pull DataFileSpecs

```
GET /nfr-perftest/data-generator/specs?system_id=123
Authorization: Bearer <token>
```

The extension uses these to link recorded form fields to existing data specs — e.g., matching a "Firstname" field to an existing `first_name` column in a team data spec.

---

## 7. Extension Behaviour by Auth State

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

### Options Page

| Element | Guest | Free User | Team Member |
|---|---|---|---|
| Assure URL + API Key (manual) | Shown | Hidden | Hidden |
| Login / Account section | "Sign in" button | Logged in as... / Logout | Logged in as... / Logout |
| Team defaults sync | Hidden | Hidden | "Sync from team" button |

### On Extension Startup

1. Check for stored JWT token
2. If token exists, call `GET /api/v1/auth/me` to validate
3. If valid: show user badge, enable cloud features per `features` array
4. If expired: try `POST /api/v1/auth/refresh`
5. If refresh fails: clear token, show "Sign in" link — all local features still work
6. If no token: guest mode, everything local works

---

## 8. Suggested Database Schema (Assure Side)

New tables needed in Assure to support recording storage and user management for the extension.

### RecorderUsers (or extend existing Users table)

```sql
-- If Assure already has a Users table, add these fields:
-- role: 'free' | 'member' | 'admin' | 'readonly'
-- org_id: FK to Organisations (nullable for free users)
-- features: JSON array of feature flags
-- plan: derived from org subscription

-- If no Users table exists:
CREATE TABLE RecorderUsers (
    UserID UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    Email NVARCHAR(200) UNIQUE NOT NULL,
    Name NVARCHAR(200),
    PasswordHash NVARCHAR(500),
    Role NVARCHAR(20) DEFAULT 'free',        -- free, member, admin, readonly
    OrgID UNIQUEIDENTIFIER NULL,             -- FK to Organisations
    Features NVARCHAR(MAX),                  -- JSON: ["cloud_storage", "push_to_assure"]
    LastLoginAt DATETIME2,
    CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
    IsActive BIT DEFAULT 1
);
```

### Recordings

```sql
CREATE TABLE Recordings (
    RecordingID UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    ClientID UNIQUEIDENTIFIER UNIQUE,         -- Dedup: extension-generated UUID
    UserID UNIQUEIDENTIFIER NOT NULL,         -- FK RecorderUsers
    ProjectID UNIQUEIDENTIFIER NULL,          -- FK to project/system (nullable = personal)
    JourneyCode NVARCHAR(50),
    BaseUrl NVARCHAR(500),
    TargetHost NVARCHAR(200),
    TransactionCount INT,
    RequestCount INT,
    CorrelationCount INT,
    DataFieldCount INT,
    AssertionCount INT,
    DurationMs INT,
    RecordingMode NVARCHAR(20),
    SessionJSON NVARCHAR(MAX),                -- Full recording (minus pageResponses)
    CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CreatedBy NVARCHAR(200)
);
```

### RecordingPageResponses (separate for size management)

```sql
CREATE TABLE RecordingPageResponses (
    ResponseID UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    RecordingID UNIQUEIDENTIFIER NOT NULL,    -- FK Recordings
    Seq INT,
    Url NVARCHAR(500),
    Path NVARCHAR(500),
    TransactionCode NVARCHAR(50),
    Body NVARCHAR(MAX),                       -- Full HTML page content
    CreatedAt DATETIME2 DEFAULT GETUTCDATE()
);
```

### FingerprintConfigs

```sql
CREATE TABLE FingerprintConfigs (
    ConfigID UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    ProjectID UNIQUEIDENTIFIER NOT NULL,
    JourneyCode NVARCHAR(50),
    FingerprintKey NVARCHAR(500) UNIQUE,      -- "What is your name?|Firstname,Surname"
    Heading NVARCHAR(500),
    Fields NVARCHAR(MAX),                     -- JSON array: ["Firstname", "Surname"]
    PageType NVARCHAR(20),
    Answers NVARCHAR(MAX),                    -- JSON: { "Firstname": "John" }
    Sources NVARCHAR(MAX),                    -- JSON: { "Firstname": "csv:Firstname" }
    UpdatedAt DATETIME2 DEFAULT GETUTCDATE(),
    UpdatedBy NVARCHAR(200)
);
```

### SharedRecordingLinks

```sql
CREATE TABLE SharedRecordingLinks (
    LinkID UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    RecordingID UNIQUEIDENTIFIER NOT NULL,
    ShareToken NVARCHAR(100) UNIQUE,          -- Short token for URL
    ExpiresAt DATETIME2,
    CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CreatedBy UNIQUEIDENTIFIER
);
```

---

## 9. Summary: What the Extension Needs from Assure

### New Endpoints (must build)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/login` | Email/password login, returns JWT + user object |
| `POST /api/v1/auth/refresh` | Refresh expired JWT |
| `GET /api/v1/auth/me` | Validate token, return current user |
| `POST /api/v1/recordings` | Save a recording |
| `GET /api/v1/recordings` | List recordings (with filters) |
| `GET /api/v1/recordings/:id` | Get full recording |
| `DELETE /api/v1/recordings/:id` | Delete a recording |
| `POST /api/v1/recordings/:id/share` | Generate share link |
| `POST /api/v1/fingerprint-configs` | Save fingerprint configs (bulk) |
| `GET /api/v1/fingerprint-configs` | Get configs for a project |

### Existing Endpoints (no changes needed)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/manifests` | Push script manifests |
| `POST /nfr-perftest/run-builder/configs` | Push run config + JMX |
| `GET /nfr-perftest/data-generator/specs` | Pull DataFileSpecs |
| `GET /health` | Connection test |

### Auth Changes

| Change | Detail |
|---|---|
| Support `Authorization: Bearer <jwt>` | New — for logged-in users |
| Continue supporting `X-API-Key` | Existing — for CI/CD and legacy |
| Return `features` array in user object | New — drives extension UI |
| Return `projects` array in user object | New — for project picker |

### CORS

The extension makes direct `fetch()` calls from the Chrome extension context. Chrome extensions are not subject to CORS (requests come from `chrome-extension://` origin), so no CORS changes should be needed. However, if Assure sits behind a gateway that blocks non-browser origins, allow the extension's origin.
