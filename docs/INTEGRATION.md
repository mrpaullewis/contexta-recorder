# Integration Guide — Assure, PerftestFramework, NHS Dashboard

This document captures everything the Chrome extension needs to know about the three systems it integrates with: Contexta Assure (SaaS platform), the PerftestFramework (standalone JMeter orchestrator), and the NHS PerfTest Dashboard (journey builder + pipeline trigger).

---

## 1. Contexta Assure (SaaS Platform)

### Overview
Assure is a plugin on the Contexta SaaS platform (`plugins/nfr_perftest/`). It manages performance testing lifecycle: systems, NFRs, test configurations, executions, and sign-off. The Chrome extension pushes recordings and JMX to Assure, and pulls test data specs and system configs.

### API Endpoints

**Auth:** All requests use `X-API-Key` header.

#### Systems
```
GET /nfr-perftest/api/v1/systems
  → [{ system_id, system_code, system_name, description }]
```

#### Script Manifests
```
POST /api/v1/manifests
  Body: {
    system_code: "CTX-SAAS",
    scripts: [{
      code: "UJ01",
      name: "Login and Landing",
      file: "scripts/UJ01.jmx",
      description: "Authenticates via /login...",
      request_count: 4,
      has_own_think_time: true,
      endpoints: [
        { method: "GET", path: "/auth/login" },
        { method: "POST", path: "/auth/login" }
      ],
      protocol: "https",
      variables_required: [
        { name: "username", source: "csv:data/logins.csv" }
      ],
      variables_internal: [
        { name: "csrf_token", source: "extractor" }
      ],
      properties: [
        { name: "TARGET_HOST", default_value: "localhost" }
      ],
      csv_datasets: [{
        filename: "data/logins.csv",
        variable_names: ["username", "password"],
        delimiter: ",",
        has_header: true,
        sharing_mode: "shareMode.all",
        recycle: true,
        stop_thread: false
      }],
      assertions: [{ type: "response", field: "status", expected: "200" }],
      tags: ["smoke-safe", "auth", "data-driven"]
    }]
  }
  → { ok: true, stored: 6 }
```

#### Run Configs
```
GET /nfr-perftest/run-builder/configs?system_id=123
  → [{ config_id, name, system_id, created_at }]

GET /nfr-perftest/run-builder/configs/<config_id>
  → { config_id, name, system_id, config: { planName, subtype, targetHost, controlPoints, userJourneys, ... }, jmx: "<xml>..." }

POST /nfr-perftest/run-builder/configs
  Body: {
    system_id: 123,
    name: "Load Test Config",
    config: {
      planName: "Load Test",
      subtype: "ConcurrencyThreadGroup",
      targetHost: "${__P(TARGET_HOST,dev.contexta.uk)}",
      targetPort: "${__P(TARGET_PORT,443)}",
      thinkMin: 500,
      thinkMax: 2000,
      onSampleError: "continue",
      concurrencyLimit: 200,
      controlPoints: [
        { threads: 0, time: 0 },
        { threads: 20, time: 120 },
        { threads: 20, time: 3720 },
        { threads: 0, time: 3840 }
      ],
      userJourneys: [
        { code: "UJ01", name: "Login", script: "scripts/UJ01.jmx", weight: 10, enabled: true }
      ]
    },
    jmx: "<jmeterTestPlan>...</jmeterTestPlan>"
  }
  → { ok: true, config_id: 456 }
```

#### Data File Specs
```
GET /nfr-perftest/data-generator/specs?system_id=123
  → [{
    spec_id: 1,
    system_id: 123,
    spec_name: "Login Users",
    file_name: "logins.csv",
    columns: [
      { name: "username", type: "email", options: { domain: "test.com" } },
      { name: "password", type: "password", options: { length: 12 } }
    ],
    global_options: { delimiter: ",", includeHeader: true, lineEnding: "LF" },
    row_count: 1000
  }]

GET /nfr-perftest/data-generator/specs/<spec_id>
  → Full spec with columns and options

GET /nfr-perftest/data-generator/download/<spec_id>
  → CSV file download
```

#### Executions (for publishing results)
```
POST /nfr-perftest/api/v1/executions
  Body: {
    system_code: "CTX-SAAS",
    run_name: "Load Test — Build 123",
    build_id: "20260330.1",
    test_type: "Load",
    environment: "dev.contexta.uk",
    total_samples: 50000,
    error_count: 12,
    error_rate: 0.024,
    avg_response_time: 245,
    p90_response_time: 450,
    p95_response_time: 680,
    p99_response_time: 1200,
    max_tps: 42.5,
    duration_seconds: 3600,
    start_time: "2026-03-30T10:00:00Z",
    end_time: "2026-03-30T11:00:00Z",
    transactions: [{
      transaction_name: "UJ01_S01_login",
      total_count: 5000,
      failure_count: 2,
      error_rate: 0.04,
      avg_response_time: 120,
      p90_response_time: 200,
      p95_response_time: 350,
      p99_response_time: 800,
      max_response_time: 1500,
      min_response_time: 45
    }]
  }
  → { execution_id: 789, evaluations: [{ nfr_code: "LOGIN_P90", result: "Pass" }] }
```

### Assure Data Model (key tables in `nfr_perftest` schema)

| Table | Purpose |
|-------|---------|
| `Systems` | Registered systems under test (SystemID, SystemCode, SystemName) |
| `ScriptManifests` | Script metadata pushed by framework (ManifestID, SystemID, Code, ManifestJSON) |
| `RunConfigs` | Saved run builder configs + generated JMX (ConfigID, SystemID, ConfigName, ConfigJSON, GeneratedJMX) |
| `DataFileSpecs` | CSV data file specifications (SpecID, SystemID, SpecName, ColumnsJSON, GlobalOptionsJSON) |
| `ExecutionLog` | Test run results (LogID, SystemID, BuildID, TestType, metrics...) |
| `TestSummaryDetails` | Per-transaction breakdown per execution |
| `SystemNFRs` | NFR definitions linked to systems (NFRID, SystemID, NFRCode, MetricType, Operator, Threshold) |
| `NFREvaluationResults` | Auto-evaluation: NFR vs execution metrics (Pass/Fail) |

### Assure Column Types (for DataFileSpecs)

The extension can suggest these types when classifying recorded form fields:

| Type | Label | Options |
|------|-------|---------|
| `email` | Email Address | domain |
| `username` | Username | prefix |
| `password` | Password | length |
| `first_name` | First Name | — |
| `last_name` | Last Name | — |
| `full_name` | Full Name | — |
| `phone_uk` | UK Phone | prefix |
| `int_sequential` | Integer (Sequential) | start, step |
| `int_random` | Integer (Random) | min, max |
| `float_random` | Decimal (Random) | min, max, precision |
| `uuid` | UUID | — |
| `date` | Date | format, min, max |
| `timestamp` | Timestamp | format |
| `boolean` | Boolean | trueLabel, falseLabel, probability |
| `choice` | Choice List | values |
| `nhs_number` | NHS Number | separator |
| `ni_number` | NI Number | separator |
| `postcode` | UK Postcode | — |
| `currency` | Currency | symbol, min, max |
| `pattern` | Custom Pattern | pattern |
| `lorem` | Lorem Text | minWords, maxWords |

### JMX Generation (Assure side)

Assure's `jmx_service.py` generates JMX with:
- **Thread group types:** ConcurrencyThreadGroup, ThreadGroup, SteppingThreadGroup, ArrivalsThreadGroup, UltimateThreadGroup, OpenModelThreadGroup
- **Structure:** Single thread group → IncludeController per UJ → shared HeaderManager, CookieManager, CacheManager, HTTP Request Defaults
- **Properties:** `${__P(THREADS,10)}`, `${__P(RAMP_UP,120)}`, `${__P(DURATION,3600)}`, `${__P(TARGET_HOST,...)}`, `${__P(TARGET_PORT,...)}`
- **On sample error:** configurable (continue, stopthread, stoptest, stoptestnow)
- **Response timeout:** configurable (default 10000ms)

---

## 2. PerftestFramework (Standalone JMeter Orchestrator)

### Overview
Separate repo at `code/PerftestFramework`. Runs distributed JMeter tests on Azure VMs via Azure DevOps pipeline. Publishes results to its own SQL database, then optionally pushes to Assure.

### Directory Structure
```
PerftestFramework/
├── jmeter-tests/
│   ├── TestManager.jmx              # Legacy orchestrator
│   ├── TestManager-CTG.jmx          # Current orchestrator
│   ├── OpenTest.jmx                 # UTG-based orchestrator
│   └── scripts/
│       ├── UJ01.jmx                 # User journey fragments
│       ├── UJ02.jmx
│       └── ...UJ06.jmx
├── data/                             # CSV test data (gitignored)
├── scripts/                          # PowerShell pipeline scripts
│   ├── ContextaPerftest.psm1         # Shared module
│   ├── run-load-test.ps1             # Main test execution
│   ├── run-smoke-test.ps1            # Pipe clean
│   ├── run-analysis.ps1              # Parse JTL + reports
│   ├── publish-to-assure.ps1         # Push results to Assure
│   ├── start-workers.ps1             # Scale VMSS up
│   └── stop-workers.ps1              # Scale VMSS down
├── analysis/
│   ├── analyse_results.py            # JTL parsing + SQL insert
│   ├── publish_assure.py             # POST results to Assure API
│   ├── script_manifest.py            # Extract manifest from JMX
│   ├── pull_config.py                # Fetch config from Assure
│   └── common.py                     # Shared utilities
├── pipelines/
│   ├── perftest-pipeline.yml         # Main test pipeline
│   └── infrastructure-build.yml      # Packer + Terraform
├── sql/
│   └── CreateRunLogTables.sql        # DB schema
└── docs/
```

### UJ Script Structure

Each UJ script (`scripts/UJ01.jmx`) is a **TestFragmentController** (not a full TestPlan):
```xml
<TestFragmentController testname="UJ01 - Login and Landing" enabled="true"/>
```

Internal structure:
- `CookieManager` — session management
- `ConstantTimer` — think time: `${__Random(${__P(minTime,500)},${__P(maxTime,2000)})}`
- `TransactionController` (parent) — `UJ01_Login_And_Landing`
  - `TransactionController` (step) — `UJ01-S001_Login_Page`
    - `HTTPSamplerProxy` — actual requests
    - `RegexExtractor` — CSRF, dynamic values
    - `ResponseAssertion` — validate status/content
  - `TransactionController` (step) — `UJ01-S002_Submit_Login`
    - ...

**Transaction naming convention in framework:**
```
UJ{NN}_{JourneyName}             (parent)
UJ{NN}-S{NNN}_{step_name}        (step)
```

**IncludeController paths** — always relative from JMeter working directory:
```xml
<IncludeController testname="Include UJ01">
  <stringProp name="IncludeController.includepath">jmeter-tests/scripts/UJ01.jmx</stringProp>
</IncludeController>
```

### Configuration System

**Three sources (precedence order):**
1. Pipeline parameters (YAML) → override everything
2. Assure config (`pull_config.py` → `config.json`) → if `configSource: assure`
3. Environment variables (`.env` files, Key Vault) → defaults

**JMeter properties (passed via `-J` flags):**
```
-JTARGET_HOST=dev.contexta.uk
-JTARGET_PORT=443
-JDURATION=3600
-JTHREADS=100
-JRAMP_UP=900
-JminTime=2000
-JmaxTime=5000
-JRATIO_UJ01=10
-JRATIO_UJ02=8
```

**JMX references these via:**
```xml
${__P(TARGET_HOST,demo.contexta.uk)}
${__P(TARGET_PORT,443)}
${__Random(${__P(minTime,500)},${__P(maxTime,2000)})}
```

### CSV Data Files

**Location:** `data/` directory (gitignored, seeded by pipeline)

**JMX CSVDataSet config:**
```xml
<CSVDataSet testname="Login Data">
  <stringProp name="filename">data/logins.csv</stringProp>
  <stringProp name="variableNames">username,password</stringProp>
  <stringProp name="delimiter">,</stringProp>
  <boolProp name="ignoreFirstLine">true</boolProp>
  <boolProp name="recycle">true</boolProp>
  <stringProp name="shareMode">shareMode.all</stringProp>
  <boolProp name="stopThread">false</boolProp>
</CSVDataSet>
```

Variables become `${username}`, `${password}` in HTTP samplers.

### Script Manifest Extraction

`analysis/script_manifest.py` parses a UJ JMX and extracts:
```python
{
    "code": "UJ01",
    "name": "Login and Landing",
    "file": "scripts/UJ01.jmx",
    "request_count": 4,
    "has_own_think_time": True,
    "endpoints": [{ "method": "GET", "path": "/auth/login" }, ...],
    "variables_required": [{ "name": "username", "source": "csv:data/logins.csv" }],
    "variables_internal": [{ "name": "csrf_token", "source": "extractor" }],
    "properties": [{ "name": "TARGET_HOST", "default_value": "localhost" }],
    "csv_datasets": [{ "filename": "data/logins.csv", "variable_names": [...], ... }],
    "assertions": [{ "type": "response", "field": "status", "expected": "200" }],
    "tags": ["smoke-safe", "auth", "data-driven"]
}
```

### Publishing Results to Assure

`analysis/publish_assure.py`:
1. Reads from local SQL (ExecutionLog + RunSummaryDetails)
2. Builds payload with execution summary + per-transaction metrics
3. POSTs to `{ASSURE_URL}/executions` with Bearer token
4. Assure auto-evaluates NFRs and returns pass/fail results

### Pipeline Stages
```
S0_StartVMs        → Ensure master + workers running
S1_Prepare         → Create execution dir, validate environment
S1b_PullConfig     → (if configSource=assure) Fetch JMX + config from Assure
S2_ScaleInjectors  → Start N worker VMs (VMSS)
S3_SeedData        → Generate/distribute CSV test data
S4_Smoke           → Low-volume validation (pipe clean)
S5_Execute         → Main load test (distributed JMeter)
S6_Analyse         → Parse JTL, generate reports, insert to SQL
S6b_RSSReport      → Collect Azure Monitor metrics
S6c_PublishAssure  → Push results to Assure API
S7_Archive         → Compress and store results
S8_Teardown        → Stop worker VMs
```

### Framework Database Schema

```sql
CREATE TABLE ExecutionLog (
    LogId INT IDENTITY PRIMARY KEY,
    BuildID VARCHAR(256),
    StartTime DATETIME, EndTime DATETIME,
    RunType VARCHAR(256),       -- Smoke, Load, Soak, Stress
    RunReason VARCHAR(256),
    TotalSamples INT, TotalErrors INT, ErrorRate FLOAT,
    DurationSeconds FLOAT, ThroughputTPS FLOAT,
    AvgResponseMs FLOAT, P90ResponseMs FLOAT, P95ResponseMs FLOAT,
    P99ResponseMs FLOAT, MaxResponseMs FLOAT,
    RunStatus NVARCHAR(100),    -- Pass, Fail, Error
    AppVersion VARCHAR(256),
    TotalThreads INT, TargetTPS INT,
    RampUpSeconds INT, RampDownSeconds INT, InjectorCount INT
);

CREATE TABLE RunSummaryDetails (
    Id INT IDENTITY PRIMARY KEY,
    LogId INT FK,
    TransactionName VARCHAR(256),
    TotalCount BIGINT, FailureCount BIGINT, ErrorRate FLOAT,
    ResponsetimeAvg FLOAT, P50 FLOAT, P90 FLOAT, P95 FLOAT, P99 FLOAT,
    MaxResponseMs FLOAT
);
```

---

## 3. NHS PerfTest Dashboard

### Overview
Flask app (`perftest-dashboard/app.py`) at port 8081. Enterprise performance testing dashboard for NHS booking systems (Covid, Flu, RSV). Has its own journey builder with question fingerprinting, JMX builder, and pipeline integration.

### Journey Builder — Question Fingerprinting

**Core concept:** Pages are identified by their semantic meaning (heading + form fields), not their URL. This means configs work across environments and survive URL changes.

**Fingerprint generation:**
```python
fingerprint = {
    "heading": "What is your name?",
    "fields": sorted(["Firstname", "Surname"]),
    "key": "What is your name?|Firstname,Surname"
}
```

**Answer matching algorithm** — scores candidates:

| Score | Condition |
|-------|-----------|
| 10 | Fields match exactly |
| 8 | Config fields are subset of page fields |
| 6 | Page fields are subset of config fields |
| 4+ | Partial field overlap (>50%) |
| +5 | Exact heading match |
| +3 | Substring heading match |

Best match with score >= threshold is used to auto-fill form values.

**DefinitionJSON structure** (saved journey config):
```json
{
  "entry_path": "/nbs/start/covid",
  "environment": "staging",
  "pages": [{
    "step_number": 1,
    "url": "https://www.nhswebsite-staging.nhs.uk/nbs/start/covid",
    "page_heading": "What is your vaccination status?",
    "fingerprint": {
      "heading": "What is your vaccination status?",
      "fields": ["status", "eligibility"],
      "key": "What is your vaccination status?|eligibility,status"
    },
    "forms_found": [{
      "method": "POST",
      "action": "/nbs/process",
      "fields": [
        { "name": "status", "type": "radio", "is_csrf": false, "is_hidden": false },
        { "name": "eligibility", "type": "select", "options": [...] }
      ]
    }],
    "field_labels": { "status": "Are you eligible?" },
    "correlations": [{
      "refname": "appointmentId",
      "extraction": "regex",
      "pattern": "appointmentId: (\\d+)",
      "consumed_by": [2]
    }]
  }],
  "answers": [{
    "match": {
      "heading": "What is your vaccination status?",
      "fields": ["status", "eligibility"]
    },
    "values": { "status": "unvaccinated", "eligibility": "adult" },
    "sources": { "status": "recorded_value", "eligibility": "csv:EligibilityType" }
  }]
}
```

### NHS Dashboard Database Tables

```sql
CREATE TABLE JourneyBuilderDefinitions (
    DefinitionID INT IDENTITY PRIMARY KEY,
    JourneyCode NVARCHAR(50),           -- "covid_booking_v1"
    JourneyName NVARCHAR(200),
    EntryUrl NVARCHAR(500),             -- /nbs/start/covid
    Environment NVARCHAR(50),           -- staging, integration, performance
    DefinitionJSON NVARCHAR(MAX),       -- Full config (pages, answers, correlations)
    GeneratedJMX NVARCHAR(MAX),         -- Generated JMX XML
    JourneyID INT FK,                   -- Link to JMXJourneys
    CreatedBy NVARCHAR(200),
    CreatedAt DATETIME2, UpdatedAt DATETIME2,
    IsActive BIT DEFAULT 1
);

CREATE TABLE JMXRunConfigs (
    ConfigID INT IDENTITY PRIMARY KEY,
    ConfigName NVARCHAR(200) UNIQUE,    -- "Combined Load Test v1.2"
    TestType NVARCHAR(100),             -- Combined, Spring, COVID, Flu
    ThreadGroupType NVARCHAR(100),      -- OpenModelThreadGroup, etc.
    ConfigJSON NVARCHAR(MAX),           -- Builder state
    GeneratedJMX NVARCHAR(MAX),         -- Final JMX XML
    Description NVARCHAR(1000),
    IsActive BIT DEFAULT 1,
    CreatedBy NVARCHAR(200),
    CreatedAt DATETIME2, UpdatedAt DATETIME2
);

CREATE TABLE JMXJourneys (
    JourneyID INT IDENTITY PRIMARY KEY,
    Code NVARCHAR(50) UNIQUE,           -- CovidBooking, FluBooking
    Name NVARCHAR(200),
    ScriptPath NVARCHAR(500),           -- scripts/CovidBooking.jmx
    TpsParam NVARCHAR(200),             -- bookingTransactionsPerSecond
    DefaultTps FLOAT DEFAULT 1,
    DefaultWeight INT DEFAULT 5,
    IsActive BIT DEFAULT 1
);

CREATE TABLE JMXJourneyDataFiles (
    DataFileID INT IDENTITY PRIMARY KEY,
    JourneyID INT FK,
    CsvParam NVARCHAR(200),             -- bookingInputCsvFile
    InternalVarName NVARCHAR(200),      -- csvCovidData
    DefaultFilename NVARCHAR(500),      -- test-data.csv
    VariableNames NVARCHAR(1000),       -- CSV column names
    ShareMode NVARCHAR(50),             -- shareMode.all
    IgnoreFirstLine BIT DEFAULT 1,
    Recycle BIT DEFAULT 1
);

CREATE TABLE JMXJourneyParams (
    ParamID INT IDENTITY PRIMARY KEY,
    JourneyID INT FK,
    ParamName NVARCHAR(200),            -- bookingThinkTimeOffset
    DefaultValue NVARCHAR(500),
    Description NVARCHAR(500)
);
```

### NHS Dashboard API Endpoints

**Journey Builder:**
```
POST /journey-builder/session/start         — Start interactive recording session
POST /journey-builder/session/<id>/submit   — Submit form, advance to next page
POST /journey-builder/session/<id>/back     — Go back
POST /journey-builder/session/<id>/branch   — Queue branch point exploration
GET  /journey-builder/session/<id>/config   — Build final config from session
GET  /journey-builder/configs               — List saved configs
GET  /journey-builder/configs/<id>          — Fetch full DefinitionJSON
POST /journey-builder/configs               — Save config
POST /journey-builder/generate-jmx          — Generate JMX from journey def
```

**Run Configs (pipeline-friendly):**
```
GET  /api/v1/journeys                                    — List available journeys
GET  /api/v1/run-configs                                 — List run configs
GET  /api/v1/run-configs/<name>?format=jmx               — Fetch JMX file
GET  /api/v1/run-configs/<name>?format=json              — Fetch config JSON
GET  /api/v1/run-configs/<name>?format=run-params        — Fetch PowerShell params
POST /api/v1/run-configs                                 — Save config
```

**Chrome Extension (planned):**
```
POST /api/v1/recordings                     — Save a recording
GET  /api/v1/recordings                     — List recordings
POST /api/v1/recordings/generate            — Generate JMX from recording
POST /api/v1/journey-configs                — Save fingerprint config
GET  /api/v1/journey-configs                — List/load configs
```

### NHS Transaction Naming Convention

```
{JourneyCode}_{StepType}{StepNumber}_{page-slug}
```

Examples from real NHS scripts:
- `Covid_S01_proxy-booking-question`
- `Covid_S02_enter-name`
- `Covid_S08_find-a-vaccination-centre`
- `Flu_S01_start-booking`
- `RSV_S03_confirm-eligibility`

The Chrome extension should support both this NHS convention and the Assure convention (`UJ01_S01_login`).

---

## 4. How the Chrome Extension Fits In

### Recording → Assure Flow
```
1. User records browser session via extension
2. Extension captures: requests, responses, form fields, timing, DOM state
3. Correlation engine detects: CSRF, sessions, dynamic IDs, redirects
4. Field classifier tags: csrf, hidden, input, radio, select
5. Assertion generator creates: title, heading, status assertions
6. User downloads JMX locally (standalone)
   OR
7. User pushes to Assure:
   a. POST /api/v1/manifests — register the scripts
   b. POST /nfr-perftest/run-builder/configs — save config + JMX
   c. Recording appears in Run Builder, ready for execution
```

### Recording → PerftestFramework Flow
```
1. Extension generates JMX as TestFragmentController (not TestPlan)
2. User saves as scripts/UJ01.jmx in framework repo
3. Framework orchestrator includes via IncludeController
4. Pipeline runs distributed test
5. publish_assure.py pushes results back to Assure
6. NFRs auto-evaluated
```

### Recording → NHS Dashboard Flow
```
1. Extension records journey through NHS screening pages
2. For each page: captures heading, form fields, answers
3. Generates fingerprint config (heading + sorted field names)
4. Pushes to NHS dashboard: POST /api/v1/journey-configs
5. On subsequent recordings: fingerprint matching auto-fills known answers
6. Only genuinely new pages need manual data entry
7. Config works across staging/integration/performance environments
```

### Data Mapping

| Extension Concept | Assure Equivalent | Framework Equivalent | NHS Dashboard Equivalent |
|---|---|---|---|
| Transaction | User Journey (UJ) | TestFragmentController | JourneyBuilderDefinitions page |
| Step | UJ step (UJ01_S01) | TransactionController | Step with fingerprint |
| Form field | DataFileSpec column | CSVDataSet variable | Answer value/source |
| Correlation | Correlation (detect_correlations) | RegexExtractor in JMX | Correlation in DefinitionJSON |
| Recording | Run Config | config.json | Session recording |
| Assertion | — (manual NFRs) | ResponseAssertion in JMX | page_content check |
| Journey code | System + UJ code | UJ01-UJ06 prefix | JourneyCode (Covid, Flu, RSV) |
| Think time | thinkMin/thinkMax | minTime/maxTime properties | thinkTimeOffset |

---

## 5. JMX Output Compatibility

The extension must generate JMX that works with both systems:

### For PerftestFramework (IncludeController mode)
```xml
<!-- UJ script: scripts/UJ01.jmx -->
<jmeterTestPlan version="1.2">
  <hashTree>
    <TestFragmentController testname="UJ01 - Login and Landing" enabled="true"/>
    <hashTree>
      <CookieManager testname="HTTP Cookie Manager">
        <boolProp name="CookieManager.clearEachIteration">false</boolProp>
      </CookieManager>
      <hashTree/>

      <TransactionController testname="UJ01_Login_And_Landing" generateParentSample="true">
      <hashTree>
        <!-- Step 1 -->
        <TransactionController testname="UJ01-S001_Login_Page">
        <hashTree>
          <HTTPSamplerProxy testname="01 Login Page" method="GET"
                           domain="${__P(TARGET_HOST,localhost)}"
                           port="${__P(TARGET_PORT,443)}"
                           protocol="https" path="/login">
          </HTTPSamplerProxy>
          <hashTree>
            <RegexExtractor testname="Extract csrf_token">
              <stringProp name="RegexExtractor.refname">csrf_token</stringProp>
              <stringProp name="RegexExtractor.regex">name="csrf_token" value="([^"]+)"</stringProp>
              <stringProp name="RegexExtractor.template">$1$</stringProp>
              <stringProp name="RegexExtractor.match_nr">1</stringProp>
            </RegexExtractor>
            <ResponseAssertion testname="Assert Login Page">
              <collectionProp name="Asserion.test_strings">
                <stringProp>Sign in</stringProp>
              </collectionProp>
              <intProp name="Assertion.test_type">2</intProp>
            </ResponseAssertion>
          </hashTree>
        </hashTree>
        </TransactionController>

        <!-- Step 2 -->
        <TransactionController testname="UJ01-S002_Login_Submit">
        <hashTree>
          <HTTPSamplerProxy testname="02 Login Submit" method="POST" path="/login">
            <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
              <collectionProp name="Arguments.arguments">
                <elementProp name="csrf_token" elementType="HTTPArgument">
                  <stringProp name="Argument.value">${csrf_token}</stringProp>
                  <stringProp name="Argument.name">csrf_token</stringProp>
                </elementProp>
                <elementProp name="email" elementType="HTTPArgument">
                  <stringProp name="Argument.value">${username}</stringProp>
                  <stringProp name="Argument.name">email</stringProp>
                </elementProp>
                <elementProp name="password" elementType="HTTPArgument">
                  <stringProp name="Argument.value">${password}</stringProp>
                  <stringProp name="Argument.name">password</stringProp>
                </elementProp>
              </collectionProp>
            </elementProp>
          </HTTPSamplerProxy>
        </hashTree>
        </TransactionController>

        <!-- Think time between steps -->
        <UniformRandomTimer>
          <stringProp name="ConstantTimer.delay">${__P(minTime,500)}</stringProp>
          <stringProp name="RandomTimer.range">${__intSum(${__P(maxTime,2000)},-${__P(minTime,500)})}</stringProp>
        </UniformRandomTimer>
      </hashTree>
      </TransactionController>

      <!-- CSV Data Set -->
      <CSVDataSet testname="Login Data">
        <stringProp name="filename">data/logins.csv</stringProp>
        <stringProp name="variableNames">username,password</stringProp>
        <stringProp name="delimiter">,</stringProp>
        <boolProp name="ignoreFirstLine">true</boolProp>
        <stringProp name="shareMode">shareMode.all</stringProp>
      </CSVDataSet>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
```

### For Standalone (full TestPlan mode)
Same content but wrapped in a full TestPlan with thread group, HTTP defaults, cookie/cache managers — matching what `jmx_service.generate_jmx()` produces.
