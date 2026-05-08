# Privacy Policy — Contexta Performance Recorder

**Last updated:** 8 May 2026

## 1. What the extension does

Contexta Performance Recorder is a Chrome extension for performance testers. While a recording session is active, it captures HTTP requests and responses, form submissions, and page structure from the tab being recorded, and uses that data — locally on the user's device — to generate JMeter performance test scripts (JMX), HTTP archive files (HAR), and raw session JSON. This is its single purpose.

## 2. What data the extension collects

While a recording session is active, the extension collects, from the tab(s) the user chooses to record:

- HTTP request URLs, methods, headers, and request bodies
- HTTP response status codes, headers, and response bodies (including HTML and JSON payloads)
- Form field names, types, labels, and submitted values
- Page titles, headings, and HTML structure used to generate response assertions
- Request and response timing data

Captured request and response bodies can contain personal or sensitive content present on the pages and APIs the user records — including authentication tokens, session cookies, form values such as email addresses, postal addresses, payment details, health information, and personal communications. The extension treats all captured content as the user's own data; it does not separately classify, redact, or transmit it.

The extension does not collect any data while it is idle (i.e. when no recording is active).

## 3. Why each Chrome permission is requested

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Identify which tab the user has chosen to record. |
| `tabs` | Track tab IDs so the recording stays attached to the correct tab during navigation. |
| `storage` | Persist the current and most recent recording in the user's local Chrome profile. |
| `unlimitedStorage` | Allow large recordings (long sessions or large response bodies) to be stored without hitting Chrome's default quota. |
| `downloads` | Save JMX, HAR, and JSON files to the location the user selects when they click Download. |
| `debugger` | Attach the Chrome DevTools Protocol to the recorded tab to capture full HTTP request and response bodies. This is the only Chrome permission that exposes response bodies and is required for the extension's core function. |
| `host_permissions: <all_urls>` | Required by Chrome for `debugger`-based recording on whichever site the user chooses to test. The extension only attaches when the user starts a recording. |
| `externally_connectable` (Contexta Studio origins — see Section 6) | Allow Contexta Performance Studio to request a recording, only when the user clicks Import on a Studio page. |

## 4. How the extension uses the data

The extension uses recorded data only to:

- Display the session for review in the popup, options page, and DevTools panel
- Run correlation detection (CSRF tokens, session cookies, dynamic IDs, redirect chains)
- Generate response assertions and page fingerprints
- Produce JMX, HAR, and JSON output for export

All processing runs locally inside the user's browser. The extension does not send recorded data to a server for processing.

## 5. How the extension stores the data

Recordings are stored in the browser's `chrome.storage.local` area on the user's device. The extension does not apply additional encryption — it relies on Chrome's profile-level isolation, which limits access to the user's own Chrome profile on the user's own machine. The extension keeps the most recent completed recording so it can be reviewed, exported, or imported into Studio. No copy is held outside the user's browser by the extension.

## 6. How the data is shared, and with whom

The extension does not sell user data. The extension does not transmit data automatically; it does not run analytics, telemetry, or background uploads.

Data leaves the extension only through actions the user takes:

- **User downloads.** When the user clicks Download in the popup, the recording is saved as a JMX, HAR, or JSON file to the location the user selects on the user's own device.

- **Import into Contexta Performance Studio.** Contexta Performance Studio is a companion product, also operated by Contexta, used to generate JMeter performance-test scripts from recorded sessions. A Studio web page can request a recording from the extension, and only when the user clicks the "Import from Contexta Recorder" button on that Studio page. Chrome enforces an origin whitelist at the message-passing layer; only pages running at the following addresses can reach the extension:

  - `https://studio.contexta.uk/*` (Contexta's hosted Studio service)
  - `https://*.contexta.uk/*` (other Contexta-operated environments, e.g. staging)
  - `http://localhost/*` and `http://127.0.0.1/*` (local development of Studio)

  Pages on any other origin cannot reach the extension. The extension never initiates the request — Studio asks, the extension responds.

- **What Studio receives, and what happens to it there.** Studio first asks for a list of completed recordings (metadata only — names, timestamps, counts) and then, for each recording the user imports, the full session JSON containing the captured HTTP requests and responses described in Section 2. The imported recording is stored in Studio scoped to the importing user's company or individual account; it is not pooled with other Studio tenants and is not used for any purpose other than generating performance-test scripts and related testing artefacts for that account. Once data is held by Studio, Studio's own privacy policy governs it.

The extension does not share data with advertisers, analytics providers, or any third party other than the Contexta-operated Studio environments listed above. The extension contains no third-party SDKs.

## 7. Security and data handling

- All recording capture, processing, and export runs inside the Chrome extension sandbox on the user's own machine.
- There is no automatic outbound network connection from the extension.
- The extension contains no third-party SDKs and loads no remote code.
- Communication with Studio, when it happens, uses Chrome's `chrome.runtime.onMessageExternal` IPC channel and is gated by the origin whitelist in Section 6.

## 8. Data retention

Recordings remain in `chrome.storage.local` until the user clears them, the user uninstalls the extension, or the user's Chrome profile is removed. The user can clear the current session at any time from the popup. Uninstalling the extension removes all data the extension has stored.

## 9. User rights and controls

The user can:

- View stored data via Chrome DevTools → Application → Storage → Extensions
- Clear the current session from the popup
- Delete saved recordings from the saved-sessions list
- Download (export) recordings to the user's own device
- Decline to import into Studio — import only happens on an explicit click
- Uninstall the extension to remove all locally stored data

## 10. Limited Use disclosures

The extension's use of any data accessed through Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements:

- Contexta does not sell user data accessed through the extension.
- Contexta does not use or transfer user data accessed through the extension for purposes unrelated to the extension's single purpose: recording sessions and generating performance-test artefacts.
- Contexta does not use or transfer user data accessed through the extension to determine creditworthiness or for lending purposes.
- Contexta does not allow humans to read user data accessed through the extension, except (a) with the user's affirmative consent — for example, when the user shares a recording with Contexta support — (b) where necessary for security purposes or to comply with applicable law, or (c) where the data has been aggregated and anonymised for internal operations.

## 11. Children's privacy

The extension is a developer tool intended for performance testers. It is not directed at children under 13, and Contexta does not knowingly collect personal information from children.

## 12. Changes to this policy

Material changes to this policy will be reflected by updating the "Last updated" date at the top of this document. Continued use of the extension after a change constitutes acceptance of the updated policy.

## 13. Contact

For questions about this privacy policy, or to request information about data handled by the extension:

- Email: support@contexta.uk
- Website: https://contexta.uk
