/**
 * Content script — injected into every page to capture DOM state.
 *
 * Extracts: form fields with labels, hidden values, page title, H1 heading,
 * summary lists, and form submission events.
 */

(function() {
  'use strict';

  /**
   * Extract all form fields from the page with their labels, types, and values.
   */
  function extractFormFields() {
    const fields = [];
    const forms = document.querySelectorAll('form');

    forms.forEach((form, formIndex) => {
      const formAction = form.getAttribute('action') || '';
      const formMethod = (form.getAttribute('method') || 'GET').toUpperCase();

      form.querySelectorAll('input, select, textarea').forEach(el => {
        const name = el.getAttribute('name');
        if (!name) return;

        const field = {
          name,
          type: el.type || el.tagName.toLowerCase(),
          value: el.value || '',
          formIndex,
          formAction,
          formMethod,
          label: findLabel(el),
          placeholder: el.getAttribute('placeholder') || '',
          required: el.hasAttribute('required'),
          isHidden: el.type === 'hidden',
          options: [],
        };

        // Capture select options
        if (el.tagName === 'SELECT') {
          field.options = Array.from(el.options).map(opt => ({
            value: opt.value,
            label: opt.textContent.trim(),
            selected: opt.selected,
          }));
        }

        // Capture radio/checkbox state
        if (el.type === 'radio' || el.type === 'checkbox') {
          field.checked = el.checked;
          // Get all options for this radio group
          if (el.type === 'radio') {
            field.options = Array.from(form.querySelectorAll(`input[name="${name}"]`)).map(r => ({
              value: r.value,
              label: findLabel(r),
              checked: r.checked,
            }));
          }
        }

        fields.push(field);
      });
    });

    return fields;
  }

  /**
   * Find the label text for a form element.
   */
  function findLabel(el) {
    // 1. Explicit <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim();
    }

    // 2. Parent <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get text content excluding the input itself
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // 3. Previous sibling label
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();

    // 4. Aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

    // 5. Placeholder as fallback
    return el.getAttribute('placeholder') || '';
  }

  /**
   * Extract page metadata.
   */
  function getPageInfo() {
    const title = document.title || '';
    const h1 = document.querySelector('h1');
    const heading = h1 ? h1.textContent.trim() : '';

    // Extract summary/details content (NHS screening pages use these)
    const summaries = [];
    document.querySelectorAll('.nhsuk-summary-list__row, .govuk-summary-list__row, dl dt').forEach(el => {
      const key = el.querySelector('dt, .nhsuk-summary-list__key, .govuk-summary-list__key');
      const val = el.querySelector('dd, .nhsuk-summary-list__value, .govuk-summary-list__value');
      if (key && val) {
        summaries.push({ key: key.textContent.trim(), value: val.textContent.trim() });
      }
    });

    return { title, heading, summaries };
  }

  /**
   * Send page info to service worker after page loads.
   */
  function reportPageInfo() {
    const info = getPageInfo();
    const fields = extractFormFields();

    chrome.runtime.sendMessage({
      type: 'page-info',
      title: info.title,
      heading: info.heading,
      summaries: info.summaries,
      formFields: fields,
      url: window.location.href,
    }).catch(() => {});
  }

  /**
   * Intercept form submissions to capture the exact submitted values.
   */
  function interceptFormSubmissions() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;

      const fields = [];
      form.querySelectorAll('input, select, textarea').forEach(el => {
        const name = el.getAttribute('name');
        if (!name) return;

        let value = el.value;
        if (el.type === 'checkbox') value = el.checked ? el.value || 'on' : '';
        if (el.type === 'radio' && !el.checked) return;

        fields.push({
          name,
          value,
          type: el.type || el.tagName.toLowerCase(),
          label: findLabel(el),
          isHidden: el.type === 'hidden',
        });
      });

      chrome.runtime.sendMessage({
        type: 'form-submitted',
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'GET').toUpperCase(),
        fields,
        url: window.location.href,
      }).catch(() => {});
    }, true);
  }

  /**
   * Watch for navigation-like clicks (links, buttons that navigate).
   */
  function watchClicks() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('a, button, [role="button"], input[type="submit"]');
      if (!target) return;

      chrome.runtime.sendMessage({
        type: 'user-click',
        tag: target.tagName,
        text: target.textContent.trim().substring(0, 100),
        href: target.getAttribute('href') || '',
        url: window.location.href,
      }).catch(() => {});
    }, true);
  }

  // Run on page load
  reportPageInfo();
  interceptFormSubmissions();
  watchClicks();

  // Re-report on dynamic page changes (SPAs)
  const observer = new MutationObserver(() => {
    clearTimeout(observer._timer);
    observer._timer = setTimeout(reportPageInfo, 500);
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
