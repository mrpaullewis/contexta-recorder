# Contexta Performance Recorder

A Chrome extension that records browser sessions and generates JMeter performance test scripts with automatic correlation detection and assertions.

Built for performance testers who need a purpose-built recording tool with correlation detection, assertion generation, and JMX output — not a generic HTTP capture tool.

## Features

- Records every HTTP request and full response body via Chrome DevTools Protocol
- Captures form submissions, hidden fields, page structure, and timing
- Automatically detects correlations (CSRF tokens, session cookies, dynamic IDs, redirect chains)
- Classifies form fields (input, radio, select, hidden, CSRF)
- Generates response assertions (page titles, headings, status codes)
- Creates page fingerprints so scripts work across environments

## Export formats

Downloads locally from the popup:

- **JMX Fragment** — for use with a JMeter IncludeController
- **JMX Standalone** — full TestPlan, run directly in JMeter
- **HAR** — HTTP Archive 1.2, compatible with DevTools, Charles, Fiddler

## Recording modes

- **Auto** — new transaction on each page navigation (recommended)
- **Transaction** — mark step boundaries manually during recording
- **Full** — one continuous block, split into transactions later

## Installation

The extension is submitted to the Chrome Web Store. Once live, install from the store listing.

For development:

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select this folder

## Usage

1. Click the extension icon to open the popup
2. Set a journey code (e.g. `UJ01`, `Login`)
3. Pick a recording mode
4. Click **Start Recording** — the Chrome debugger attaches to the active tab
5. Perform your flow
6. Click **Stop** — the recorder runs correlation analysis
7. Download JMX or HAR from the results screen

## Privacy

All recording data stays local on your device. See [PRIVACY.md](PRIVACY.md) for full details.

## Support

- Website: https://contexta.uk
- Email: support@contexta.uk

## License

Proprietary. All rights reserved — Contexta.
