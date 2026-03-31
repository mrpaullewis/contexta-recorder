# Privacy Policy — Contexta Performance Recorder

**Last updated:** 31 March 2026

## What the extension does

Contexta Performance Recorder is a Chrome extension that records browser sessions and generates JMeter performance test scripts. It captures HTTP requests and responses during active recording sessions only.

## What data is collected

### During recording (local only)
- HTTP request URLs, headers, and bodies
- HTTP response status codes, headers, and body snippets
- Form field names, types, values, and labels
- Page titles, headings, and structure
- Request timing data

This data is stored locally in your browser using Chrome's storage API. It is **never transmitted** unless you explicitly choose to push it to a server (see below).

### When you sign in (optional)
If you choose to sign in with Google or Microsoft:
- Your email address and display name are stored locally to maintain your session
- A JWT authentication token is stored locally

### When you push to Contexta Assure or NHS Dashboard (optional)
If you explicitly click "Push to Assure" or "Push to NHS Dashboard":
- Your recording data is sent to the server you are connected to
- This includes request/response data, correlations, and form field classifications
- Data is transmitted over HTTPS

## What data is NOT collected
- No data is collected when the extension is idle (not recording)
- No browsing history is tracked
- No analytics or telemetry is sent
- No data is sold to third parties
- No data is shared with advertisers
- No data is used for purposes unrelated to performance test script generation

## Data storage
- All recording data is stored locally in Chrome's extension storage
- Local data persists until you clear it or uninstall the extension
- Authentication tokens are stored locally and can be cleared by signing out

## Third-party services
The extension connects to external services only when you explicitly initiate it:
- **Google OAuth** — when you click "Sign in with Google"
- **Microsoft Entra** — when you click "Sign in with Microsoft"
- **Contexta Assure** (dev.contexta.uk) — when you click "Push to Assure"

## Your rights
- You can view all stored data via Chrome's developer tools
- You can clear all data by clicking "Clear" in the extension popup
- You can sign out at any time to remove authentication data
- You can uninstall the extension to remove all local data

## Contact
For questions about this privacy policy:
- Email: support@contexta.uk
- Website: https://contexta.uk

## Changes
We may update this privacy policy from time to time. Changes will be reflected in the "Last updated" date above.
