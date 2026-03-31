# NHS PerfTest Dashboard — Recorder Integration Spec

The Contexta Recorder Chrome extension pushes recordings to the NHS PerfTest Dashboard. This document specifies the API endpoints the dashboard needs to implement to receive recording data, store it, and integrate it with the existing Journey Builder and JMX Builder.

**Dashboard URL:** Configurable in extension options, defaults to `http://nbs-generic-mock-vm-feat.uksouth.cloudapp.azure.com:8081`

---

## 1. New Endpoints Required

The dashboard needs three new endpoints. All sit under `/api/v1/` alongside the existing `/api/v1/journeys` and `/api/v1/run-configs`.

### POST /api/v1/recordings

Receives the full recording session from the extension. This is the primary endpoint — one call delivers everything.

**Auth:** For now, accept any request (the dashboard currently uses session auth with hardcoded creds). Later, add API key or JWT support.

**Request:**
```json
{
  "recording": {
    "id": "uuid",
    "journeyCode": "Covid",
    "mode": "auto",
    "startTime": "2026-03-31T14:00:00Z",
    "endTime": "2026-03-31T14:02:30Z",
    "baseUrl": "https://www.nhswebsite-staging.nhs.uk",
    "targetHost": "www.nhswebsite-staging.nhs.uk",
    "protocol": "https",
    "port": "443",
    "options": { "namingConvention": "nhs", "stepPadding": 2 },
    "transactions": [...],
    "correlations": [...],
    "dataRequirements": [...],
    "assertions": [...],
    "fingerprints": [...],
    "pageResponses": [...]
  }
}
```

Full payload structure is documented in section 3 below.

**What to do with it:**

1. Store the recording in a new `RecorderRecordings` table (section 5)
2. Store `pageResponses` separately (they're large — 30-100KB each)
3. Auto-create a `JourneyBuilderDefinition` from the fingerprints and correlations (section 4)
4. Push the script manifest into `ScriptManifests` / `JMXJourneys` (section 4)

**Response (201):**
```json
{
  "recording_id": 42,
  "journey_definition_id": 15,
  "journey_code": "Covid",
  "created_at": "2026-03-31T14:30:00Z",
  "fingerprints_matched": 5,
  "fingerprints_new": 3,
  "correlations_found": 6
}
```

**Error responses:**
```json
// 400
{ "error": "missing_recording", "message": "recording object is required" }

// 500
{ "error": "server_error", "message": "Failed to save recording" }
```

### POST /api/v1/scripts/manifest

Receives the structured script manifest — the same format the PerftestFramework already pushes. This populates the JMX Builder's journey library.

**Request:**
```json
{
  "system_code": "NBS",
  "scripts": [
    {
      "code": "Covid",
      "name": "Covid Booking",
      "file": "scripts/Covid.jmx",
      "description": "Recorded from www.nhswebsite-staging.nhs.uk — 8 steps",
      "request_count": 16,
      "has_own_think_time": true,
      "endpoints": [
        { "method": "GET", "path": "/nbs/booking-question" },
        { "method": "POST", "path": "/nbs/booking-question" },
        { "method": "GET", "path": "/nbs/enter-name" },
        { "method": "POST", "path": "/nbs/enter-name" }
      ],
      "protocol": "https",
      "variables_required": [
        { "name": "Firstname", "source": "csv:data/covid_data.csv" },
        { "name": "Surname", "source": "csv:data/covid_data.csv" }
      ],
      "variables_internal": [
        { "name": "RequestVerificationToken", "source": "extractor" },
        { "name": "selectedSiteId", "source": "extractor" }
      ],
      "properties": [
        { "name": "TARGET_HOST", "default_value": "www.nhswebsite-staging.nhs.uk" },
        { "name": "TARGET_PORT", "default_value": "443" }
      ],
      "csv_datasets": [
        {
          "filename": "data/covid_data.csv",
          "variable_names": ["Firstname", "Surname", "SelectedOption"],
          "delimiter": ",",
          "has_header": true,
          "sharing_mode": "shareMode.all",
          "recycle": true,
          "stop_thread": false
        }
      ],
      "assertions": [
        { "type": "title", "field": "response_data", "expected": "Are you booking for yourself?" },
        { "type": "heading", "field": "response_data", "expected": "What is your name?" }
      ],
      "tags": ["recorder-generated"]
    }
  ]
}
```

**What to do with it:**

1. Upsert into `JMXJourneys` — match on `code`, update or create
2. Upsert `JMXJourneyDataFiles` from `csv_datasets`
3. Upsert `JMXJourneyParams` from `properties`
4. The journey now appears in the JMX Builder UI as a selectable journey

**Response (200):**
```json
{
  "status": "accepted",
  "system_code": "NBS",
  "scripts_received": 1,
  "scripts_created": 1,
  "scripts_updated": 0
}
```

### GET /api/v1/recordings

List recordings for the dashboard UI.

**Response (200):**
```json
{
  "recordings": [
    {
      "recording_id": 42,
      "journey_code": "Covid",
      "base_url": "https://www.nhswebsite-staging.nhs.uk",
      "transaction_count": 8,
      "request_count": 16,
      "correlation_count": 6,
      "created_at": "2026-03-31T14:30:00Z",
      "created_by": "contexta-recorder"
    }
  ]
}
```

---

## 2. Mapping to Existing Dashboard Systems

### Recording → Journey Builder Definition

The recording's fingerprints map directly to the dashboard's existing `DefinitionJSON` format. The dashboard should auto-create a `JourneyBuilderDefinition` from each recording.

| Recording Field | Dashboard DefinitionJSON Field |
|---|---|
| `transactions[].requests[].path` | `pages[].path` |
| `transactions[].requests[].pageTitle` | `pages[].title` |
| `transactions[].requests[].pageHeading` | `pages[].heading` |
| `transactions[].requests[].response.status` | `pages[].status_code` |
| `transactions[].requests[].formFields` | `pages[].forms_found[].fields` |
| `fingerprints[].heading` | `pages[].fingerprint.heading` |
| `fingerprints[].fields` | `pages[].fingerprint.fields` |
| `fingerprints[].key` | `pages[].fingerprint.key` |
| `fingerprints[].answers` | `answers[].values` |
| `fingerprints[].sources` | `answers[].sources` |
| `correlations[].name` | `correlations[].refname` |
| `correlations[].extractRegex` | `correlations[].regex` |
| `correlations[].extractType` | `correlations[].extraction` |
| `correlations[].usedInRequests` | `correlations[].consumed_by` |
| `dataRequirements[].fieldName` | `csv_requirements.variable_names` |
| `dataRequirements[].suggestedCsvColumn` | `csv_columns[].csvColumn` |

### Recording → JMX Journey

The manifest's script entry maps to the `JMXJourneys` table:

| Manifest Field | JMXJourneys Column |
|---|---|
| `code` | `Code` |
| `name` | `Name` |
| `file` | `ScriptPath` |
| `description` | `Description` |
| `properties[TARGET_HOST]` | Used in JMX generation |
| `csv_datasets[0].variable_names` | `JMXJourneyDataFiles.VariableNames` |
| `csv_datasets[0].filename` | `JMXJourneyDataFiles.DefaultFilename` |

### Recording → JMX Run Config

Once the journey exists in `JMXJourneys`, it can be added to any JMX run config. The JMX Builder UI already handles this — the new journey just appears in the journey list.

---

## 3. Full Recording Payload Reference

The recording object sent by the extension contains:

### Session metadata
```json
{
  "id": "uuid",
  "journeyCode": "Covid",
  "mode": "auto | transaction | full",
  "startTime": "ISO",
  "endTime": "ISO",
  "baseUrl": "https://...",
  "targetHost": "hostname",
  "protocol": "https",
  "port": "443",
  "options": {
    "namingConvention": "nhs | slug | plain",
    "stepPadding": 2
  }
}
```

### transactions[]
Each transaction is a step in the journey (e.g. one page navigation + form submit):
```json
{
  "code": "Covid",
  "stepNumber": 1,
  "name": "Covid_S01_proxy-booking-question",
  "startTime": "ISO",
  "endTime": "ISO",
  "requests": [
    {
      "seq": 0,
      "method": "GET | POST",
      "url": "full URL",
      "path": "/nbs/booking-question",
      "headers": { "Accept": "text/html", "Cookie": "..." },
      "queryParams": {},
      "body": "form-encoded body or null",
      "bodyType": "form-urlencoded | json | null",
      "timestamp": "ISO",
      "resourceType": "Document | XHR | Fetch",
      "response": {
        "status": 200,
        "statusText": "OK",
        "headers": { "Content-Type": "text/html", "Set-Cookie": "..." },
        "contentType": "text/html",
        "bodySnippet": "first 64KB of response body",
        "timing": { "dns": 5, "connect": 12, "ssl": 8, "ttfb": 145, "total": 210 },
        "size": 28400
      },
      "formFields": [
        {
          "name": "SelectedOption",
          "type": "radio",
          "value": "Myself",
          "label": "Book for myself",
          "required": false,
          "isHidden": false,
          "options": [
            { "value": "Myself", "label": "Book for myself", "selected": true },
            { "value": "SomeoneElse", "label": "Book for someone else", "selected": false }
          ],
          "classification": "radio | input | select | csrf | hidden | checkbox | static"
        }
      ],
      "pageTitle": "Page title from <title> tag",
      "pageHeading": "H1 text",
      "pageAnalysis": {
        "heading": "H1 text",
        "subHeadings": [],
        "summary": "",
        "tables": [],
        "errors": [],
        "breadcrumbs": ["Home", "Vaccinations"],
        "pageType": "form | results | confirmation | error"
      }
    }
  ]
}
```

### correlations[]
Dynamic values the JMX needs to extract at runtime:
```json
{
  "name": "RequestVerificationToken",
  "type": "csrf | dynamic_id | viewstate | cookie | redirect",
  "extractType": "regex | jsonpath | header",
  "extractRegex": "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
  "extractJsonPath": null,
  "sourceTransaction": "Covid",
  "sourceRequestSeq": 0,
  "sourceUrl": "https://...",
  "sourceLocation": "hidden_input | meta_tag | json_body | set-cookie",
  "sampleValue": "CfDJ8_abc123...",
  "allSources": [{ "transaction": "Covid", "seq": 0 }],
  "usedInRequests": [{ "transaction": "Covid", "seq": 1, "field": "__RequestVerificationToken" }]
}
```

### dataRequirements[]
Form fields that need test data:
```json
{
  "fieldName": "Firstname",
  "fieldType": "text",
  "classification": "input",
  "transaction": "Covid",
  "requestSeq": 3,
  "sampleValue": "John",
  "label": "First name",
  "suggestedCsvColumn": "Firstname",
  "assureColumnType": "first_name"
}
```

### assertions[]
Response checks per page:
```json
{
  "transaction": "Covid_S01_proxy-booking-question",
  "requestSeq": 0,
  "type": "title | heading | status | content | negative",
  "field": "Assertion.response_data | Assertion.response_code",
  "expected": "Are you booking for yourself?",
  "testType": 2,
  "not": false
}
```

testType values: 2 = contains, 8 = equals, 1 = matches. Add 4 for NOT (so 6 = not contains).

### fingerprints[]
Page identity for config reuse across environments:
```json
{
  "heading": "What is your name?",
  "fields": ["Firstname", "Surname"],
  "key": "What is your name?|Firstname,Surname",
  "transaction": "Covid",
  "requestSeq": 2,
  "pageType": "form",
  "answers": { "Firstname": "John", "Surname": "Smith" },
  "sources": { "Firstname": "recorded_value", "Surname": "recorded_value" }
}
```

The `key` is the unique identifier — heading + sorted fields, joined by `|`. This matches the dashboard's existing `page_fingerprint()` output format.

### pageResponses[]
Full HTML pages for re-analysis:
```json
{
  "seq": 0,
  "url": "https://...",
  "path": "/nbs/booking-question",
  "transaction": "Covid",
  "body": "<!DOCTYPE html>... full page HTML ..."
}
```

These are 30-100KB each. Store separately from the main recording JSON.

---

## 4. Processing Logic

When `POST /api/v1/recordings` receives a recording, the dashboard should:

### Step 1: Store the raw recording
```python
recording_id = db.insert('RecorderRecordings', {
    'ClientID': recording['id'],
    'JourneyCode': recording['journeyCode'],
    'BaseUrl': recording['baseUrl'],
    'TargetHost': recording['targetHost'],
    'TransactionCount': len(recording['transactions']),
    'RequestCount': sum(len(tx['requests']) for tx in recording['transactions']),
    'CorrelationCount': len(recording.get('correlations', [])),
    'DataFieldCount': len(recording.get('dataRequirements', [])),
    'SessionJSON': json.dumps(strip_page_responses(recording)),
    'CreatedBy': 'contexta-recorder',
})
```

### Step 2: Store page responses separately
```python
for pr in recording.get('pageResponses', []):
    db.insert('RecorderPageResponses', {
        'RecordingID': recording_id,
        'Seq': pr['seq'],
        'Url': pr['url'],
        'Path': pr['path'],
        'TransactionCode': pr.get('transaction'),
        'Body': pr['body'],
    })
```

### Step 3: Build a JourneyBuilderDefinition
```python
# Convert recording to the dashboard's DefinitionJSON format
pages = []
for tx in recording['transactions']:
    for req in tx['requests']:
        if req.get('resourceType') != 'Document':
            continue
        if not req.get('formFields'):
            continue

        # Find matching fingerprint
        fp = next((f for f in recording.get('fingerprints', [])
                    if f.get('requestSeq') == req['seq']), None)

        # Find correlations born on this page
        page_corrs = [c for c in recording.get('correlations', [])
                      if c.get('sourceRequestSeq') == req['seq']]

        pages.append({
            'path': req['path'].split('?')[0],
            'title': req.get('pageTitle', ''),
            'heading': req.get('pageHeading', ''),
            'status_code': req.get('response', {}).get('status', 200),
            'forms_found': [{
                'method': 'POST',
                'action': req['path'].split('?')[0],
                'fields': [{
                    'name': f['name'],
                    'type': f['type'],
                    'value': f.get('value', ''),
                    'label': f.get('label', ''),
                    'classification': f.get('classification', 'input'),
                    'is_hidden': f.get('isHidden', False),
                    'is_csrf': f.get('classification') == 'csrf',
                    'options': f.get('options', []),
                } for f in req.get('formFields', [])],
            }],
            'fingerprint': {
                'heading': fp['heading'],
                'fields': fp['fields'],
                'key': fp['key'],
            } if fp else None,
            'correlations': [{
                'refname': c['name'],
                'extraction': c['extractType'],
                'pattern': c.get('extractRegex', ''),
                'consumed_by': [u['seq'] for u in c.get('usedInRequests', [])],
            } for c in page_corrs],
        })

# Build answers from fingerprints
answers = []
for fp in recording.get('fingerprints', []):
    if fp.get('answers'):
        answers.append({
            'match': {
                'heading': fp['heading'],
                'fields': fp['fields'],
            },
            'values': fp['answers'],
            'sources': fp.get('sources', {}),
        })

# Build CSV column mapping from data requirements
csv_columns = [
    {'fieldName': d['fieldName'], 'csvColumn': d['suggestedCsvColumn']}
    for d in recording.get('dataRequirements', [])
]

definition_json = {
    'entry_path': pages[0]['path'] if pages else '',
    'environment': detect_environment(recording['targetHost']),
    'target_host': recording['targetHost'],
    'pages': pages,
    'correlations': [{
        'refname': c['name'],
        'description': c['type'],
        'extraction': c['extractType'],
        'regex': c.get('extractRegex', ''),
        'template': '$1$',
        'default': '',
    } for c in recording.get('correlations', [])],
    'answers': answers,
    'csv_columns': csv_columns,
    'csv_requirements': {
        'variable_names': ','.join(d['suggestedCsvColumn']
                                   for d in recording.get('dataRequirements', []))
    },
}

# Check if a definition already exists for this journey code
existing = db.query(
    'SELECT DefinitionID FROM JourneyBuilderDefinitions '
    'WHERE JourneyCode = ? AND IsActive = 1',
    recording['journeyCode']
)

if existing:
    db.update('JourneyBuilderDefinitions', existing[0].DefinitionID, {
        'DefinitionJSON': json.dumps(definition_json),
        'UpdatedAt': datetime.utcnow(),
    })
    definition_id = existing[0].DefinitionID
else:
    definition_id = db.insert('JourneyBuilderDefinitions', {
        'JourneyCode': recording['journeyCode'],
        'JourneyName': f"{recording['journeyCode']} Booking",
        'EntryUrl': pages[0]['path'] if pages else '',
        'Environment': detect_environment(recording['targetHost']),
        'DefinitionJSON': json.dumps(definition_json),
        'CreatedBy': 'contexta-recorder',
    })
```

### Step 4: Environment detection helper
```python
def detect_environment(host):
    if 'staging' in host:
        return 'staging'
    elif 'integration' in host:
        return 'integration'
    elif 'perf' in host:
        return 'performance'
    return 'unknown'
```

---

## 5. New Database Tables

### RecorderRecordings

```sql
CREATE TABLE RecorderRecordings (
    RecordingID       INT IDENTITY PRIMARY KEY,
    ClientID          NVARCHAR(100),
    JourneyCode       NVARCHAR(50),
    BaseUrl           NVARCHAR(500),
    TargetHost        NVARCHAR(200),
    TransactionCount  INT,
    RequestCount      INT,
    CorrelationCount  INT,
    DataFieldCount    INT,
    DurationMs        INT,
    RecordingMode     NVARCHAR(20),
    SessionJSON       NVARCHAR(MAX),
    CreatedAt         DATETIME2 DEFAULT GETUTCDATE(),
    CreatedBy         NVARCHAR(200)
);
```

### RecorderPageResponses

```sql
CREATE TABLE RecorderPageResponses (
    ResponseID      INT IDENTITY PRIMARY KEY,
    RecordingID     INT NOT NULL REFERENCES RecorderRecordings(RecordingID),
    Seq             INT,
    Url             NVARCHAR(500),
    Path            NVARCHAR(500),
    TransactionCode NVARCHAR(50),
    Body            NVARCHAR(MAX),
    CreatedAt       DATETIME2 DEFAULT GETUTCDATE()
);
```

No changes to existing tables — the recording data maps into the existing `JourneyBuilderDefinitions.DefinitionJSON` and `JMXJourneys` structures.

---

## 6. What This Replaces

| Before (manual) | After (recorder) |
|---|---|
| Start Journey Builder session | User records in browser, clicks Push |
| Click through each page manually | All pages captured in one recording |
| Wait for server to fetch + parse each page | Recording already has full HTML + analysis |
| Manually identify correlations | Correlations auto-detected with regex patterns |
| Manually classify form fields | Fields auto-classified (csrf, input, radio, etc.) |
| Manually enter test data answers | Sample values captured during recording |
| No assertions | Assertions auto-generated (title, heading, status) |
| Config works on one environment | Fingerprints work across staging/integration/perf |
| No timing data | Full request timing captured (DNS, connect, TTFB) |

---

## 7. Auth Considerations

The dashboard currently uses session auth (`admin` / `perftest123`). For the recorder integration, the simplest approach is:

**Option A: No auth on the API endpoint (quickest)**
- The endpoint is only accessible from within the network
- Add a simple check like `X-Source: contexta-recorder` header

**Option B: Shared JWT (recommended)**
- Accept the same JWT token that Assure issues
- Validate using the same secret key
- The user is already authenticated via Microsoft/Google in the extension

**Option C: API key**
- Create a simple API key table
- Extension sends `Authorization: Bearer <key>`
- Generate keys from the dashboard settings page

The extension currently sends `Authorization: Bearer <jwt-token>` on all API calls. The dashboard just needs to accept it.
