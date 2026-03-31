/**
 * Assertion generator — auto-generates response assertions per transaction.
 *
 * Types:
 * - title: regex on <title> content
 * - heading: H1 text that identifies the page
 * - status: expected HTTP status code (200, 302, etc.)
 * - content: key text that must appear (from headings)
 * - negative: text that must NOT appear (error messages, session expired)
 */

// Common error indicators that should trigger negative assertions
const NEGATIVE_PATTERNS = [
  'session expired',
  'session has expired',
  'session timed out',
  'an error has occurred',
  'an error occurred',
  'something went wrong',
  'internal server error',
  'page not found',
  'access denied',
  'forbidden',
  'unauthori',
  'sorry, there is a problem',
  'service unavailable',
  'try again later',
  'we could not process',
  'technical error',
  'unexpected error',
];

/**
 * Generate assertions for a completed session.
 * Returns an array matching the session data model assertions structure.
 */
export function generateAssertions(session) {
  const assertions = [];

  for (const tx of session.transactions) {
    // Find the primary page request (first Document-type GET or the first request)
    const primaryRequest = findPrimaryRequest(tx);
    if (!primaryRequest) continue;

    // Status code assertion
    if (primaryRequest.response?.status) {
      assertions.push({
        transaction: tx.name,
        requestSeq: primaryRequest.seq,
        type: 'status',
        field: 'Assertion.response_code',
        expected: String(primaryRequest.response.status),
        testType: 8, // equals
        not: false,
      });
    }

    // Page title assertion
    if (primaryRequest.pageTitle) {
      assertions.push({
        transaction: tx.name,
        requestSeq: primaryRequest.seq,
        type: 'title',
        field: 'Assertion.response_data',
        expected: primaryRequest.pageTitle,
        testType: 2, // contains
        not: false,
      });
    }

    // Heading assertion (H1)
    if (primaryRequest.pageHeading) {
      assertions.push({
        transaction: tx.name,
        requestSeq: primaryRequest.seq,
        type: 'heading',
        field: 'Assertion.response_data',
        expected: primaryRequest.pageHeading,
        testType: 2, // contains
        not: false,
      });
    }

    // Content assertion — use heading if available, otherwise title
    const keyContent = primaryRequest.pageHeading || primaryRequest.pageTitle;
    if (keyContent && keyContent.length > 3) {
      assertions.push({
        transaction: tx.name,
        requestSeq: primaryRequest.seq,
        type: 'content',
        field: 'Assertion.response_data',
        expected: keyContent,
        testType: 2, // contains
        not: false,
      });
    }

    // Negative assertions — check the response body for error text that should NOT appear
    const negatives = detectNegativeAssertions(primaryRequest);
    for (const neg of negatives) {
      assertions.push({
        transaction: tx.name,
        requestSeq: primaryRequest.seq,
        type: 'negative',
        field: 'Assertion.response_data',
        expected: neg,
        testType: 2, // contains
        not: true,
      });
    }

    // Also generate assertions for non-primary requests with meaningful responses
    for (const req of tx.requests) {
      if (req.seq === primaryRequest.seq) continue;
      if (!req.response) continue;

      // POST responses that redirect — assert the redirect status
      if (req.method === 'POST' && req.response.status >= 300 && req.response.status < 400) {
        assertions.push({
          transaction: tx.name,
          requestSeq: req.seq,
          type: 'status',
          field: 'Assertion.response_code',
          expected: String(req.response.status),
          testType: 8, // equals
          not: false,
        });
      }

      // JSON API responses — assert status 200
      if (req.response.contentType?.includes('json') && req.response.status === 200) {
        assertions.push({
          transaction: tx.name,
          requestSeq: req.seq,
          type: 'status',
          field: 'Assertion.response_code',
          expected: '200',
          testType: 8,
          not: false,
        });
      }
    }
  }

  return assertions;
}

/**
 * Find the primary page-level request in a transaction.
 * This is the request whose response we use for title/heading assertions.
 */
function findPrimaryRequest(tx) {
  if (!tx.requests || tx.requests.length === 0) return null;

  // Prefer the first Document GET
  const docGet = tx.requests.find(r =>
    r.resourceType === 'Document' && r.method === 'GET' && r.response?.status === 200
  );
  if (docGet) return docGet;

  // Then any Document request
  const doc = tx.requests.find(r => r.resourceType === 'Document');
  if (doc) return doc;

  // Fallback to first request with a response
  return tx.requests.find(r => r.response) || tx.requests[0];
}

/**
 * Detect which negative assertion patterns should be applied.
 * We add standard negative assertions that guard against common error states.
 */
function detectNegativeAssertions(req) {
  const negatives = [];
  const body = (req.response?.bodySnippet || '').toLowerCase();

  // Always add these standard negative assertions (they should NOT appear)
  const standardNegatives = [
    'session expired',
    'an error has occurred',
    'something went wrong',
  ];

  for (const neg of standardNegatives) {
    // Only add if it doesn't actually appear in the current response
    // (if it does appear, the recording captured an error page — don't assert against it)
    if (!body.includes(neg)) {
      negatives.push(neg);
    }
  }

  return negatives;
}
