/**
 * Page structure analyser — deeper DOM analysis for fingerprinting and assertions.
 *
 * Extracts:
 * - Primary heading (H1, fallback to H2)
 * - Page summary text (lead paragraph, meta description)
 * - Summary lists (NHS/GovUK dt/dd patterns)
 * - Table structure (headers and row data)
 * - Error/warning messages on the page
 * - Breadcrumb navigation
 * - Key content sections
 */

(function () {
  'use strict';

  /**
   * Run full page analysis and return structured data.
   */
  function analysePage() {
    return {
      heading: extractHeading(),
      subHeadings: extractSubHeadings(),
      summary: extractSummary(),
      summaryLists: extractSummaryLists(),
      tables: extractTables(),
      errors: extractErrors(),
      breadcrumbs: extractBreadcrumbs(),
      landmarks: extractLandmarks(),
      pageType: detectPageType(),
    };
  }

  /**
   * Primary heading — H1, fallback to first H2 if no H1.
   */
  function extractHeading() {
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim();
    const h2 = document.querySelector('h2');
    return h2 ? h2.textContent.trim() : '';
  }

  /**
   * Sub-headings — all H2s on the page (useful for content assertions).
   */
  function extractSubHeadings() {
    return Array.from(document.querySelectorAll('h2'))
      .map(h => h.textContent.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  /**
   * Summary/lead text — first meaningful paragraph or meta description.
   */
  function extractSummary() {
    // NHS/GovUK lead paragraph
    const lead = document.querySelector('.nhsuk-lede-text, .govuk-body-l, .lede, [class*="lead"]');
    if (lead) return lead.textContent.trim().substring(0, 300);

    // Meta description
    const meta = document.querySelector('meta[name="description"]');
    if (meta?.content) return meta.content.trim().substring(0, 300);

    // First paragraph in main content area
    const main = document.querySelector('main, [role="main"], .main-content, #content');
    if (main) {
      const p = main.querySelector('p');
      if (p && p.textContent.trim().length > 20) {
        return p.textContent.trim().substring(0, 300);
      }
    }

    return '';
  }

  /**
   * Summary lists — NHS/GovUK dl/dt/dd patterns (check-your-answers pages).
   */
  function extractSummaryLists() {
    const lists = [];

    // NHS pattern
    document.querySelectorAll('.nhsuk-summary-list, .govuk-summary-list, dl').forEach(dl => {
      const items = [];
      const rows = dl.querySelectorAll('.nhsuk-summary-list__row, .govuk-summary-list__row, dt');

      if (rows.length === 0) {
        // Plain dt/dd pairs
        const dts = dl.querySelectorAll('dt');
        dts.forEach(dt => {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === 'DD') {
            items.push({
              key: dt.textContent.trim(),
              value: dd.textContent.trim().substring(0, 200),
            });
          }
        });
      } else {
        rows.forEach(row => {
          const key = row.querySelector('.nhsuk-summary-list__key, .govuk-summary-list__key, dt');
          const val = row.querySelector('.nhsuk-summary-list__value, .govuk-summary-list__value, dd');
          if (key && val) {
            items.push({
              key: key.textContent.trim(),
              value: val.textContent.trim().substring(0, 200),
            });
          }
        });
      }

      if (items.length > 0) lists.push(items);
    });

    return lists;
  }

  /**
   * Table data — headers and first few rows (useful for dynamic content).
   */
  function extractTables() {
    const tables = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('th'))
        .map(th => th.textContent.trim())
        .filter(Boolean);

      const rows = [];
      table.querySelectorAll('tbody tr').forEach((tr, i) => {
        if (i >= 5) return; // limit to 5 rows
        const cells = Array.from(tr.querySelectorAll('td'))
          .map(td => td.textContent.trim().substring(0, 100));
        rows.push(cells);
      });

      if (headers.length > 0 || rows.length > 0) {
        tables.push({ headers, rows, rowCount: table.querySelectorAll('tbody tr').length });
      }
    });
    return tables.slice(0, 5);
  }

  /**
   * Error and warning messages on the page.
   */
  function extractErrors() {
    const errors = [];
    const selectors = [
      '.nhsuk-error-summary', '.govuk-error-summary',
      '.nhsuk-error-message', '.govuk-error-message',
      '[class*="error-message"]', '[class*="alert-danger"]',
      '[class*="alert-warning"]', '[role="alert"]',
      '.validation-summary-errors', '.field-validation-error',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.textContent.trim().substring(0, 200);
        if (text) errors.push({ selector: sel, text });
      });
    }

    return errors.slice(0, 10);
  }

  /**
   * Breadcrumb navigation — helps identify page position in journey.
   */
  function extractBreadcrumbs() {
    const breadcrumb = document.querySelector(
      '.nhsuk-breadcrumb, .govuk-breadcrumbs, [aria-label="Breadcrumb"], nav.breadcrumb'
    );
    if (!breadcrumb) return [];

    return Array.from(breadcrumb.querySelectorAll('a, li'))
      .map(el => ({
        text: el.textContent.trim(),
        href: el.getAttribute('href') || '',
      }))
      .filter(b => b.text)
      .slice(0, 10);
  }

  /**
   * ARIA landmarks — main content regions.
   */
  function extractLandmarks() {
    const landmarks = [];
    document.querySelectorAll('[role="main"], [role="navigation"], [role="banner"], main, nav, header').forEach(el => {
      landmarks.push({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        label: el.getAttribute('aria-label') || '',
      });
    });
    return landmarks.slice(0, 10);
  }

  /**
   * Detect what type of page this is (for fingerprinting).
   */
  function detectPageType() {
    const hasForms = document.querySelectorAll('form').length > 0;
    const hasRadios = document.querySelectorAll('input[type="radio"]').length > 0;
    const hasCheckboxes = document.querySelectorAll('input[type="checkbox"]').length > 0;
    const hasSummaryList = document.querySelectorAll('.nhsuk-summary-list, .govuk-summary-list').length > 0;
    const hasTable = document.querySelectorAll('table').length > 0;
    const hasErrors = document.querySelectorAll('[class*="error"], [role="alert"]').length > 0;

    if (hasErrors) return 'error';
    if (hasSummaryList) return 'summary';
    if (hasRadios) return 'decision';
    if (hasForms) return 'form';
    if (hasTable) return 'data';
    return 'content';
  }

  /**
   * Send analysis to service worker.
   */
  function reportAnalysis() {
    const analysis = analysePage();
    chrome.runtime.sendMessage({
      type: 'page-analysis',
      analysis,
      url: window.location.href,
    }).catch(() => {});
  }

  // Run after initial page-info report (slight delay to not compete)
  setTimeout(reportAnalysis, 800);

  // Re-analyse on major DOM changes
  let analysisTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(reportAnalysis, 1000);
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
