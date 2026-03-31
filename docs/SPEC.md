# Contexta Performance Recorder — Specification

## Vision

A fully-featured Chrome extension that records browser sessions and produces complete, ready-to-run JMeter performance test scripts. Built for performance testers — not a generic HTTP recorder, but a purpose-built tool that understands correlations, decision points, data parameterisation, and transaction structure.

Works standalone as a recording tool, but also integrates with Contexta Assure for config management, test data, and pipeline execution.

Think BlazeMeter's extension but built specifically for performance testing workflows — with correlation detection, assertion generation, CSV data mapping, and multi-path journey support baked in.

---

## Tech Stack

- **Chrome Manifest V3** extension
- **Vanilla JavaScript** (ES modules, no framework, no build step)
- **Chrome Debugger API** for network capture (full request/response bodies)
- **chrome.storage.local** for session persistence
- Contexta branded: navy (#1F5240), teal (#5D8B84), gold (#D5A344)

---

## Core Features

### 1. Recording Engine

**What it captures:**
- Every HTTP request/response (via Chrome DevTools Protocol / debugger API)
- Full headers, cookies, request body (form-encoded + JSON)
- Response status, content-type, timing (DNS, connect, SSL, TTFB, total)
- Page navigation events (URL changes, redirects)
- Form submissions with all field values and labels
- DOM state at each page (hidden fields, form structure, page title, H1 heading)

**What it ignores (configurable):**
- Static resources (CSS, JS, images, fonts, SVGs)
- Third-party domains (analytics, CDN, ads)
- Browser-internal requests (chrome-extension://, devtools://)

**Recording modes:**
- **Transaction-based** — user marks transaction boundaries (click "New Transaction" between logical steps)
- **Auto-transaction** — automatically creates transactions on page navigation
- **Full recording** — captures everything from Start to Stop, split into transactions later

### 2. Transaction Naming

Auto-generates transaction names following the convention:

```
{JourneyCode}_{StepType}{StepNumber}_{page-slug}
```

Examples:
- `Covid_S01_proxy-booking-question`
- `UJ01_S02_enter-name`
- `Flu_S08_find-a-vaccination-centre`

The user sets the journey code (e.g. "Covid", "UJ01", "RSV") at the start of recording. Step numbers auto-increment. Page slugs are derived from the URL path's last segment.

Users can also:
- Rename transactions during or after recording
- Split/merge transactions
- Mark transactions as "sub-transaction" (nested under a parent)

### 3. Correlation Detection

Automatically identifies values that are:
- **Born** in a response (hidden fields, JSON values, headers, cookies)
- **Consumed** in a subsequent request (form fields, URL parameters, headers)

Correlation types detected:
- **CSRF tokens** — hidden inputs matching common patterns (`__RequestVerificationToken`, `csrf_token`, `_csrf`, `authenticity_token`)
- **Session cookies** — Set-Cookie headers propagated in subsequent requests
- **Dynamic IDs** — values from response bodies that appear in later request URLs or bodies (e.g. `selectedSiteId`, `appointmentTypeId`)
- **Redirect targets** — Location headers that become the next request URL
- **JSON response values** — extracted values from API responses used in subsequent calls
- **Viewstate** — ASP.NET `__VIEWSTATE` patterns

For each correlation, generates:
- JMeter RegexExtractor / JSONExtractor / BoundaryExtractor config
- The extraction regex/JSONPath
- Which request it's extracted from
- Which subsequent requests consume it
- The JMeter variable name (`${variableName}`)

### 4. Form Field Classification

Every form field captured during recording is classified:

| Classification | Description | JMX Treatment |
|---|---|---|
| `csrf` | Anti-forgery token | Auto-correlated, extracted from previous response |
| `hidden` | Dynamic hidden field | Correlation candidate, extracted via regex |
| `input` | User text input (name, email, etc.) | Parameterised from CSV data |
| `radio` | Decision point (Yes/No, option selection) | Fixed value or parameterised |
| `select` | Dropdown selection | Fixed or parameterised |
| `checkbox` | Toggle (true/false) | Fixed value |
| `static` | Unchanging value | Hardcoded in JMX |

### 5. Assertion Generation

For each page/transaction, auto-generates response assertions:
- **Page title assertion** — regex on `<title>` content
- **Heading assertion** — H1 text that identifies the page
- **Status code assertion** — expected HTTP status (200, 302, etc.)
- **Content assertion** — key text that must appear (from page headings)
- **Negative assertion** — text that must NOT appear (error messages, "session expired")

### 6. Data Parameterisation

The extension identifies which fields need test data:
- Text inputs (name, NHS number, email, phone, postcode, DOB)
- Dynamic selections (site IDs, appointment data)

For each data field:
- Records the example value used during recording
- Suggests a CSV column name
- Generates the CSVDataSet config for JMX
- Maps `${variableName}` references in the HTTP samplers
- Can pull DataFileSpecs from Assure for column linking

### 7. Question Fingerprint Config

Each page visited during recording generates a fingerprint:
```json
{
  "heading": "What is your name?",
  "fields": ["Firstname", "Surname"],
  "key": "What is your name?|Firstname,Surname"
}
```

The recorded answers are saved against the fingerprint, not the URL. This means:
- Configs work across environments (staging, integration, perf)
- Configs survive URL changes
- Configs can be shared between similar journeys
- Only genuinely new pages need re-recording

### 8. Multi-Path Journey Support

During recording, when the user encounters a decision point (radio button, Yes/No), the extension:
- Records the chosen path
- Marks the decision point with the alternatives
- Allows the user to "bookmark" the branch point
- After completing the first path, offers to replay up to the branch point and record the alternative path

The result is a journey tree with multiple recorded paths, each producing its own JMX script or a combined script with IfControllers.

---

## Recording Session Data Model

The complete recording session is stored as JSON and contains all data needed for correlation analysis, field classification, JMX generation, and Assure integration.

```json
{
  "id": "uuid",
  "journeyCode": "UJ01",
  "startTime": "ISO",
  "endTime": "ISO",
  "baseUrl": "https://example.com",
  "targetHost": "example.com",
  "protocol": "https",
  "port": "443",
  "mode": "transaction",
  "transactions": [
    {
      "code": "UJ01",
      "stepNumber": 1,
      "name": "UJ01_S01_login",
      "startTime": "ISO",
      "endTime": "ISO",
      "requests": [
        {
          "seq": 0,
          "method": "GET",
          "url": "https://example.com/login",
          "path": "/login",
          "headers": {},
          "queryParams": {},
          "body": null,
          "bodyType": null,
          "timestamp": "ISO",
          "resourceType": "Document",
          "response": {
            "status": 200,
            "statusText": "OK",
            "headers": {},
            "contentType": "text/html",
            "bodySnippet": "first 4KB for correlation scanning",
            "timing": {
              "dns": 5,
              "connect": 10,
              "ssl": 8,
              "ttfb": 45,
              "total": 120
            },
            "size": 12345
          },
          "formFields": [
            {
              "name": "email",
              "type": "email",
              "value": "user@test.com",
              "label": "Email address",
              "placeholder": "",
              "required": true,
              "isHidden": false,
              "options": []
            }
          ],
          "pageTitle": "Login - Example App",
          "pageHeading": "Sign in to your account"
        }
      ]
    }
  ],
  "correlations": [
    {
      "name": "csrf_token",
      "type": "csrf",
      "extractRegex": "name=\"csrf_token\" value=\"([^\"]+)\"",
      "sourceTransaction": "UJ01",
      "sourceRequestSeq": 0,
      "usedInRequests": [{"transaction": "UJ01", "seq": 1}]
    }
  ],
  "dataRequirements": [
    {
      "fieldName": "email",
      "fieldType": "email",
      "classification": "input",
      "transaction": "UJ01",
      "requestSeq": 1,
      "sampleValue": "user@test.com",
      "suggestedCsvColumn": "email",
      "datafileSpecId": null,
      "datafileColumn": null
    }
  ],
  "fingerprints": [
    {
      "heading": "Sign in to your account",
      "fields": ["email", "password"],
      "key": "Sign in to your account|email,password",
      "answers": {"email": "user@test.com", "password": "***"}
    }
  ],
  "assertions": [
    {
      "transaction": "UJ01_S01_login",
      "requestSeq": 0,
      "type": "title",
      "expected": "Login - Example App"
    }
  ]
}
```

---

## JMX Output Structure

```xml
<jmeterTestPlan>
  <TestPlan>
    <TestFragment>
      <!-- Global: CSRF extractor -->
      <RegexExtractor refname="RequestVerificationToken" />
      <!-- Global: CSV Data Set -->
      <CSVDataSet filename="${csvDataFile}" variableNames="..." />

      <!-- Per-transaction -->
      <TransactionController testname="UJ01_S01_login">
        <HTTPSamplerProxy method="GET" path="/login" />
        <HTTPSamplerProxy method="POST" path="/login">
          <!-- Form parameters with ${variable} references -->
        </HTTPSamplerProxy>
        <!-- Extractors for correlations born on this page -->
        <RegexExtractor refname="sessionToken" />
        <!-- Response assertion -->
        <ResponseAssertion testStrings="Sign in to your account" />
        <!-- Think time -->
        <UniformRandomTimer />
      </TransactionController>

      <!-- Decision point -->
      <IfController condition="${__groovy(...)}">
        <!-- Branch A transactions -->
      </IfController>
    </TestFragment>
  </TestPlan>
</jmeterTestPlan>
```

---

## Integration

### Standalone Mode (no server needed)
- Record, analyse, generate JMX locally
- Download JMX / HAR / JSON recording as files
- Store recordings in Chrome local storage (last 20 sessions)

### Contexta Assure Integration
- `POST /api/v1/manifests` — push script manifests
- `POST /nfr-perftest/run-builder/configs` — push run config with generated JMX
- `GET /nfr-perftest/data-generator/specs` — pull DataFileSpecs for CSV column linking
- Save/load recordings, push JMX to journey library, pull test data CSV
- Auth via API key header (`X-API-Key`)

---

## File Structure

```
contexta-recorder/
├── manifest.json                    # Chrome Manifest V3
├── package.json                     # Jest for testing
├── docs/
│   └── SPEC.md                      # This file
├── icons/                           # Extension icons (16, 48, 128px)
├── background/
│   ├── service-worker.js            # Recording state machine, debugger coordination
│   ├── recorder.js                  # Request/response capture, session model, filtering
│   └── correlator.js                # Correlation detection engine [Phase 2]
├── content/
│   ├── content-script.js            # Form fields, labels, hidden values, page info
│   └── page-analyser.js             # Page structure analysis [Phase 2]
├── popup/
│   ├── popup.html                   # Extension popup
│   ├── popup.js                     # Controls, stats, transaction list, exports
│   └── popup.css                    # Contexta-branded styles
├── panel/
│   ├── devtools.html                # DevTools panel registration
│   ├── panel.html                   # Full panel UI [Phase 5]
│   ├── panel.js
│   └── components/
├── shared/
│   ├── constants.js                 # Detection patterns, filters, config
│   ├── storage.js                   # chrome.storage wrapper
│   ├── config.js                    # Fingerprint config system [Phase 2]
│   ├── field-classifier.js          # Field classification [Phase 2]
│   ├── jmx-generator.js            # JMX generation [Phase 3]
│   ├── assertion-generator.js       # Assertion generation [Phase 2]
│   ├── assure-api.js                # Assure API client [Phase 6]
│   └── har-export.js                # HAR export [Phase 3]
├── options/
│   ├── options.html                 # Assure URL, API key, filters
│   └── options.js
└── tests/                           # Jest unit tests
```

---

## Implementation Phases

### Phase 1: Scaffold + Recording Engine [DONE]
- manifest.json, package.json, constants, storage
- service-worker.js — state machine, debugger API, message handling
- recorder.js — request/response capture, session model, transaction management
- content-script.js — DOM extraction, form interception, click tracking
- popup.html/js/css — record/stop/pause, stats, transaction list, export buttons
- options.html/js — Assure settings

### Phase 2: Analysis Engine
- correlator.js — CSRF, cookies, dynamic IDs, redirects, JSON values, viewstate
- field-classifier.js — classify form fields by type
- assertion-generator.js — title, heading, status, content, negative assertions
- page-analyser.js — page structure (heading, summary, tables)
- config.js — question fingerprint generation and matching

### Phase 3: JMX Generation + Export
- jmx-generator.js — full JMX with TransactionControllers, HTTP Samplers, extractors, CSVDataSet, assertions, think time
- har-export.js — standard HAR format
- Wire Download JMX / Download HAR buttons in popup

### Phase 4: Popup UI — Transaction Management
- Live transaction list with request counts and timing
- Transaction rename, split, merge
- Decision point indicators
- Data requirements summary

### Phase 5: DevTools Panel
- Full request/response viewer (like Network tab)
- Correlation viewer with extraction patterns
- Field classification editor with CSV column mapping
- Assertion editor
- JMX live preview
- Post-recording UJ drag-drop grouping

### Phase 6: Assure Integration
- assure-api.js — push recordings, pull configs/specs
- "Push to Assure" button in popup with system selector
- Pull DataFileSpecs for parameterisation linking

### Phase 7: Multi-Path + Advanced
- Branch point detection and bookmarking
- Multi-path recording
- IfController generation
- Recording replay with different data

---

## Differentiators vs BlazeMeter Extension

| Feature | BlazeMeter | Contexta |
|---|---|---|
| Correlation detection | Manual | Automatic (CSRF, IDs, cookies, JSON) |
| Transaction naming | Generic | Convention-based (Journey_S01_slug) |
| Decision points | Not detected | Auto-detected, multi-path support |
| Data parameterisation | Manual | Auto-classified, CSV mapping |
| Assertions | None | Auto-generated (title, heading, status) |
| Config reuse | None | Question-fingerprint matching |
| Multi-environment | None | Configs work across envs |
| Dashboard integration | BlazeMeter cloud only | Contexta Assure |
| Field labels | None | Extracted from HTML labels |
| Response details | Limited | Full headers, body snippet, timing |
