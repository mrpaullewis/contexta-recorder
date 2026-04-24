/**
 * Question fingerprint config system.
 *
 * Generates fingerprints from page content (heading + sorted field names) and
 * matches them against saved configs to auto-fill known answers.
 *
 * Emits a DefinitionJSON-shaped structure for downstream tooling.
 *
 * Fingerprint key format:
 *   "What is your name?|Firstname,Surname"
 *
 * Matching algorithm scores candidates and picks the best match above threshold.
 */

const MATCH_THRESHOLD = 6;

/**
 * Generate a fingerprint for a page based on its heading and form fields.
 */
export function generateFingerprint(heading, formFields) {
  const fieldNames = (formFields || [])
    .filter(f => f.name && !f.isHidden && f.type !== 'hidden')
    .map(f => f.name)
    .sort();

  // Deduplicate (radio groups produce multiple fields with same name)
  const uniqueFields = [...new Set(fieldNames)];

  const key = `${heading || ''}|${uniqueFields.join(',')}`;

  return {
    heading: heading || '',
    fields: uniqueFields,
    key,
  };
}

/**
 * Generate fingerprints for all pages in a session.
 * Returns the fingerprints array for the session data model.
 */
export function generateSessionFingerprints(session) {
  const fingerprints = [];
  const seenKeys = new Set();

  for (const tx of session.transactions) {
    for (const req of tx.requests) {
      const heading = req.pageHeading || '';
      const fields = req.formFields || [];

      // Skip requests with no meaningful content to fingerprint
      if (!heading && fields.length === 0) continue;

      const fp = generateFingerprint(heading, fields);

      // Skip duplicates within the same session
      if (seenKeys.has(fp.key)) continue;
      seenKeys.add(fp.key);

      // Collect answers from the form fields
      const answers = {};
      const sources = {};
      for (const f of fields) {
        if (!f.name || f.isHidden || f.type === 'hidden') continue;
        if (f.value !== undefined && f.value !== '') {
          answers[f.name] = f.value;
          sources[f.name] = 'recorded_value';
        }
      }

      fingerprints.push({
        heading: fp.heading,
        fields: fp.fields,
        key: fp.key,
        transaction: tx.name,
        requestSeq: req.seq,
        pageType: req.pageAnalysis?.pageType || 'form',
        answers,
        sources,
      });
    }
  }

  return fingerprints;
}

/**
 * Match a page fingerprint against a list of saved configs.
 * Returns the best matching config or null if none meet the threshold.
 */
export function matchFingerprint(pageFingerprint, savedConfigs) {
  let bestMatch = null;
  let bestScore = 0;

  for (const config of savedConfigs) {
    const score = scoreMatch(pageFingerprint, config);
    if (score > bestScore && score >= MATCH_THRESHOLD) {
      bestScore = score;
      bestMatch = { config, score };
    }
  }

  return bestMatch;
}

/**
 * Score how well a page fingerprint matches a saved config fingerprint.
 *
 * Scoring:
 *   10 — fields match exactly
 *    8 — config fields are subset of page fields
 *    6 — page fields are subset of config fields
 *   4+ — partial field overlap (>50%)
 *   +5 — exact heading match
 *   +3 — substring heading match
 */
export function scoreMatch(pageFingerprint, configFingerprint) {
  let score = 0;

  const pageFields = new Set(pageFingerprint.fields || []);
  const configFields = new Set(configFingerprint.fields || []);

  // Field matching
  if (pageFields.size > 0 || configFields.size > 0) {
    const intersection = new Set([...pageFields].filter(f => configFields.has(f)));
    const intersectionSize = intersection.size;

    if (pageFields.size === configFields.size && intersectionSize === pageFields.size) {
      // Exact match
      score += 10;
    } else if (configFields.size > 0 && intersectionSize === configFields.size) {
      // Config fields are a subset of page fields
      score += 8;
    } else if (pageFields.size > 0 && intersectionSize === pageFields.size) {
      // Page fields are a subset of config fields
      score += 6;
    } else {
      // Partial overlap
      const maxSize = Math.max(pageFields.size, configFields.size);
      const overlapRatio = maxSize > 0 ? intersectionSize / maxSize : 0;
      if (overlapRatio > 0.5) {
        score += 4 + Math.round(overlapRatio * 2);
      }
    }
  }

  // Heading matching
  const pageHeading = (pageFingerprint.heading || '').toLowerCase().trim();
  const configHeading = (configFingerprint.heading || '').toLowerCase().trim();

  if (pageHeading && configHeading) {
    if (pageHeading === configHeading) {
      score += 5;
    } else if (pageHeading.includes(configHeading) || configHeading.includes(pageHeading)) {
      score += 3;
    }
  }

  return score;
}

/**
 * Merge saved config answers into a page's form fields.
 * Returns an object mapping field names to their auto-filled values.
 */
export function applyConfigAnswers(pageFingerprint, matchedConfig) {
  if (!matchedConfig?.answers) return {};

  const result = {};
  for (const fieldName of pageFingerprint.fields) {
    if (matchedConfig.answers[fieldName] !== undefined) {
      result[fieldName] = {
        value: matchedConfig.answers[fieldName],
        source: matchedConfig.sources?.[fieldName] || 'config',
      };
    }
  }
  return result;
}

/**
 * Convert session fingerprints to DefinitionJSON-shaped output.
 */
export function toDefinitionJson(session, fingerprints) {
  const pages = [];
  const answers = [];

  for (const fp of fingerprints) {
    // Find the matching request
    const tx = session.transactions.find(t => t.name === fp.transaction);
    const req = tx?.requests.find(r => r.seq === fp.requestSeq);

    pages.push({
      step_number: pages.length + 1,
      url: req?.url || '',
      page_heading: fp.heading,
      fingerprint: {
        heading: fp.heading,
        fields: fp.fields,
        key: fp.key,
      },
      forms_found: req?.formFields ? [{
        method: req.method === 'GET' ? 'POST' : req.method,
        action: req.path || '',
        fields: req.formFields
          .filter(f => f.name)
          .map(f => ({
            name: f.name,
            type: f.type,
            is_csrf: f.classification === 'csrf',
            is_hidden: f.isHidden || false,
            options: f.options || [],
          })),
      }] : [],
      field_labels: buildFieldLabels(req?.formFields || []),
      correlations: buildPageCorrelations(session, req),
    });

    if (Object.keys(fp.answers).length > 0) {
      answers.push({
        match: {
          heading: fp.heading,
          fields: fp.fields,
        },
        values: fp.answers,
        sources: fp.sources,
      });
    }
  }

  return {
    entry_path: pages[0]?.url ? new URL(pages[0].url).pathname : '',
    environment: extractEnvironment(session.baseUrl),
    pages,
    answers,
  };
}


// ── Helpers ──────────────────────────────────────────────────

function buildFieldLabels(formFields) {
  const labels = {};
  for (const f of formFields) {
    if (f.name && f.label) {
      labels[f.name] = f.label;
    }
  }
  return labels;
}

function buildPageCorrelations(session, req) {
  if (!session.correlations || !req) return [];
  return session.correlations
    .filter(c => c.sourceRequestSeq === req.seq)
    .map(c => ({
      refname: c.name,
      extraction: c.extractType === 'jsonpath' ? 'jsonpath' : 'regex',
      pattern: c.extractRegex || c.extractJsonPath || '',
      consumed_by: c.usedInRequests.map(u => u.seq),
    }));
}

function extractEnvironment(baseUrl) {
  if (!baseUrl) return 'unknown';
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host.includes('staging') || host.includes('stg')) return 'staging';
  if (host.includes('integration') || host.includes('int')) return 'integration';
  if (host.includes('perf') || host.includes('load')) return 'performance';
  if (host.includes('dev') || host.includes('local')) return 'dev';
  if (host.includes('prod') || host.includes('live')) return 'production';
  return 'unknown';
}
