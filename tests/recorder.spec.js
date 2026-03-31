/**
 * E2E tests for the Contexta Recorder Chrome extension.
 *
 * Loads the extension into Chromium, records a session against the
 * test server (login → booking flow), and verifies the results:
 * correlations, field classifications, assertions, and exports.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const TEST_URL = 'http://localhost:3847';

let browser;
let context;
let extensionId;

test.beforeAll(async () => {
  // Launch Chromium with the extension loaded
  browser = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });
  context = browser;

  // Wait for the service worker to register, then find the extension ID
  let sw;
  if (context.serviceWorkers().length === 0) {
    sw = await context.waitForEvent('serviceworker');
  } else {
    sw = context.serviceWorkers()[0];
  }
  extensionId = sw.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * Open the extension popup as a full page (popups can't be automated
 * as actual popups in Playwright — open the popup.html directly).
 */
async function openPopup() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  // Wait for UI to initialise
  await page.waitForSelector('#cr-status');
  return page;
}

/**
 * Start a recording via the popup page.
 *
 * The extension needs a real tab to attach the debugger to.
 * We open the app page, then query for its tab ID from the
 * popup's extension context, and trigger recording.
 */
async function startRecording(popup, journeyCode = 'Test', mode = 'auto') {
  // Open the app page first so we have a real tab to record
  const appPage = await context.newPage();
  await appPage.goto(TEST_URL);
  await appPage.waitForLoadState('domcontentloaded');
  // Give the tab time to register
  await appPage.waitForTimeout(500);

  // From the popup (which runs in extension context), find the tab
  // with the test URL and start recording on it
  await popup.bringToFront();
  await popup.waitForTimeout(300);

  const started = await popup.evaluate(async ({ url, journeyCode, mode }) => {
    // Query all tabs and find one with our test URL
    const allTabs = await chrome.tabs.query({});
    const targetTab = allTabs.find(t => t.url && t.url.startsWith(url));
    if (!targetTab) {
      return { error: 'No tab found for ' + url, tabs: allTabs.map(t => t.url) };
    }
    const result = await chrome.runtime.sendMessage({
      type: 'start-recording',
      tabId: targetTab.id,
      journeyCode,
      mode,
    });
    return result;
  }, { url: TEST_URL, journeyCode, mode });

  console.log('start-recording result:', JSON.stringify(started));

  if (started?.error) {
    throw new Error('Failed to start recording: ' + started.error + (started.tabs ? ' — tabs: ' + started.tabs.join(', ') : ''));
  }

  // Wait for debugger to attach, then reload popup to show recording UI
  await popup.waitForTimeout(2000);
  await popup.reload();
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForTimeout(500);

  // Check what state the popup is in
  const uiState = await popup.evaluate(() => {
    return {
      setup: document.getElementById('cr-setup')?.style.display,
      active: document.getElementById('cr-active')?.style.display,
      results: document.getElementById('cr-results')?.style.display,
      status: document.getElementById('cr-status')?.textContent,
    };
  });
  console.log('Popup UI state after start:', JSON.stringify(uiState));

  // Verify recording state is showing
  await popup.waitForSelector('#cr-active', { state: 'visible', timeout: 5000 });

  return appPage;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

test.describe('Recording', () => {

  test('records a login and booking flow', async () => {
    const popup = await openPopup();
    const appPage = await startRecording(popup, 'Covid', 'auto');

    // ── Walk through the test server flow ──────────────────────
    await appPage.bringToFront();

    // Login page
    await appPage.goto(`${TEST_URL}/login`);
    await appPage.fill('#email', 'testuser@nhs.net');
    await appPage.fill('#password', 'Password1!');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/booking-question');

    // Booking question — select "Myself"
    await appPage.click('input[value="Myself"]');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/enter-name');

    // Enter name
    await appPage.fill('#Firstname', 'Test');
    await appPage.fill('#Surname', 'User');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/choose-site');

    // Choose site (click first site button)
    await appPage.click('form button[type="submit"]');
    await appPage.waitForURL('**/choose-date');

    // Choose date (click first radio)
    await appPage.click('input[name="DateData"]');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/choose-time');

    // Choose time
    await appPage.click('input[name="selectedHour"]');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/choose-appointment');

    // Choose appointment
    await appPage.click('input[name="SelectedAppointmentData"]');
    await appPage.click('button[type="submit"]');
    await appPage.waitForURL('**/booking-complete');

    // Verify we landed on the confirmation
    await expect(appPage.locator('h1')).toHaveText('Booking complete');

    // ── Stop recording ────────────────────────────────────────
    await popup.bringToFront();
    await popup.reload();
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForSelector('#cr-stop', { state: 'visible', timeout: 5000 });
    await popup.click('#cr-stop');

    // Wait for results to appear
    await popup.waitForSelector('#cr-results', { state: 'visible', timeout: 10_000 });

    // ── Verify results ────────────────────────────────────────
    const txCount = await popup.textContent('#cr-res-tx');
    const reqCount = await popup.textContent('#cr-res-req');
    const corrCount = await popup.textContent('#cr-res-corr');
    const fieldCount = await popup.textContent('#cr-res-fields');

    // Should have multiple transactions (login + each booking step)
    expect(parseInt(txCount)).toBeGreaterThanOrEqual(5);
    // Should have requests captured
    expect(parseInt(reqCount)).toBeGreaterThanOrEqual(10);
    // Should have CSRF correlations
    expect(parseInt(corrCount)).toBeGreaterThanOrEqual(1);

    console.log(`Results: ${txCount} tx, ${reqCount} req, ${corrCount} corr, ${fieldCount} fields`);

    // ── Verify correlation details ────────────────────────────
    // Download JSON and inspect
    const session = await popup.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({ type: 'get-session' });
      return result.session;
    });

    expect(session).toBeTruthy();
    expect(session.journeyCode).toBe('Covid');
    expect(session.correlations.length).toBeGreaterThanOrEqual(1);

    // CSRF correlation should exist
    const csrfCorr = session.correlations.find(c => c.type === 'csrf');
    expect(csrfCorr).toBeTruthy();
    expect(csrfCorr.name).toContain('RequestVerificationToken');
    expect(csrfCorr.usedInRequests.length).toBeGreaterThanOrEqual(1);

    // Data requirements should include name fields
    const nameFields = session.dataRequirements?.filter(d =>
      ['Firstname', 'Surname'].includes(d.fieldName)
    );
    expect(nameFields?.length).toBe(2);

    // Assertions should exist
    expect(session.assertions?.length).toBeGreaterThanOrEqual(1);

    // Fingerprints should exist
    expect(session.fingerprints?.length).toBeGreaterThanOrEqual(1);

    console.log('Correlations:', session.correlations.map(c => `${c.type}:${c.name}`));
    console.log('Data fields:', session.dataRequirements?.map(d => d.fieldName));
    console.log('Fingerprints:', session.fingerprints?.map(f => f.heading));

    await popup.close();
    await appPage.close();
  });

  test('generates valid JMX', async () => {
    const popup = await openPopup();

    // Should show last recording results
    await popup.waitForSelector('#cr-results', { state: 'visible', timeout: 5000 });

    // Generate JMX in-page and verify structure
    const jmx = await popup.evaluate(async () => {
      const { generateJmx } = await import(chrome.runtime.getURL('shared/jmx-generator.js'));
      const result = await chrome.runtime.sendMessage({ type: 'get-session' });
      return generateJmx(result.session, { mode: 'fragment' });
    });

    expect(jmx).toBeTruthy();

    // Verify basic JMX structure
    expect(jmx).toContain('<?xml version="1.0"');
    expect(jmx).toContain('<jmeterTestPlan');
    expect(jmx).toContain('TestFragmentController');
    expect(jmx).toContain('CookieManager');
    expect(jmx).toContain('TransactionController');
    expect(jmx).toContain('HTTPSamplerProxy');

    // Verify correlations are in the JMX
    expect(jmx).toContain('RegexExtractor');
    expect(jmx).toContain('RequestVerificationToken');

    // Verify every element has a hashTree sibling (JMeter requirement)
    const elements = [
      'RegexExtractor', 'ResponseAssertion', 'JSONPostProcessor',
      'CookieManager', 'UniformRandomTimer', 'CSVDataSet',
    ];
    for (const el of elements) {
      const regex = new RegExp(`</${el}>\\s*\\n\\s*<hashTree`, 'g');
      if (jmx.includes(`<${el}`)) {
        expect(jmx).toMatch(regex);
      }
    }

    // Verify CSV data references
    if (jmx.includes('CSVDataSet')) {
      expect(jmx).toContain('variableNames');
    }

    console.log('JMX length:', jmx.length, 'chars');
    console.log('Contains extractors:', jmx.includes('RegexExtractor'));
    console.log('Contains assertions:', jmx.includes('ResponseAssertion'));

    await popup.close();
  });

  test('generates valid HAR', async () => {
    const popup = await openPopup();
    await popup.waitForSelector('#cr-results', { state: 'visible', timeout: 5000 });

    const har = await popup.evaluate(async () => {
      const { generateHar } = await import(chrome.runtime.getURL('shared/har-export.js'));
      const result = await chrome.runtime.sendMessage({ type: 'get-session' });
      return generateHar(result.session);
    });

    expect(har).toBeTruthy();
    expect(har.log).toBeTruthy();
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toContain('Contexta');
    expect(har.log.entries.length).toBeGreaterThan(0);

    // Check first entry has required HAR fields
    const entry = har.log.entries[0];
    expect(entry.request).toBeTruthy();
    expect(entry.response).toBeTruthy();
    expect(entry.request.method).toBeTruthy();
    expect(entry.request.url).toBeTruthy();

    console.log('HAR entries:', har.log.entries.length);

    await popup.close();
  });

  test('handles failed login gracefully', async () => {
    const popup = await openPopup();

    // Start fresh — clear everything so popup shows setup view
    await popup.evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: 'stop-recording' }); } catch {}
      await chrome.storage.local.set({
        'currentSession': null,
        'recorderState': 'idle',
      });
    });
    await popup.waitForTimeout(500);
    await popup.reload();
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForTimeout(500);
    // If results are showing, click New Recording
    const resultsVisible = await popup.$eval('#cr-results', el => el.style.display !== 'none').catch(() => false);
    if (resultsVisible) {
      await popup.click('#cr-new-recording');
      await popup.waitForTimeout(300);
    }
    await popup.waitForSelector('#cr-setup', { state: 'visible', timeout: 5000 });
    const appPage = await startRecording(popup, 'FailTest', 'auto');

    await appPage.bringToFront();
    await appPage.goto(`${TEST_URL}/login`);
    await appPage.fill('#email', 'wrong@nhs.net');
    await appPage.fill('#password', 'wrongpassword');
    await appPage.click('button[type="submit"]');

    // Should redirect back to login with error
    await appPage.waitForURL('**/login?error=1*');
    const errorAlert = appPage.locator('[role="alert"]');
    await expect(errorAlert).toBeVisible();

    // Stop and check we still got a recording
    await popup.bringToFront();
    await popup.reload();
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForSelector('#cr-stop', { state: 'visible', timeout: 5000 });
    await popup.click('#cr-stop');
    await popup.waitForSelector('#cr-results', { state: 'visible', timeout: 10_000 });

    const reqCount = await popup.textContent('#cr-res-req');
    expect(parseInt(reqCount)).toBeGreaterThanOrEqual(2); // GET login + POST login

    await popup.close();
    await appPage.close();
  });
});
