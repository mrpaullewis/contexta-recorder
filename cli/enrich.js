#!/usr/bin/env node
/**
 * enrich.js — read a SessionJSON from stdin, enrich with correlations +
 * data requirements + assertions using the same modules the browser
 * extension uses, write enriched JSON to stdout.
 *
 * Designed to be invoked from Studio (Python subprocess) so the cloud-
 * recorded sessions go through the EXACT same inference pipeline as the
 * Chrome-extension-recorded ones. Single source of truth for correlation
 * detection, field classification, and assertion generation lives in the
 * shared modules — never ported to Python.
 *
 * Usage:
 *   echo '<session-json>' | node cli/enrich.js
 *   cat session.json | node cli/enrich.js > enriched.json
 *
 * Exit codes:
 *   0  — enriched JSON on stdout
 *   1  — parse error / module error / missing data (error JSON on stdout)
 */
import { detectCorrelations } from '../background/correlator.js';
import { classifyFields } from '../shared/field-classifier.js';
import { generateAssertions } from '../shared/assertion-generator.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function fail(message, details) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: message,
    details: details || null,
  }) + '\n');
  process.exit(1);
}

(async () => {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    fail('stdin read failed', String(e));
  }
  if (!raw || !raw.trim()) {
    fail('empty stdin — expected SessionJSON');
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    fail('SessionJSON parse failed', String(e));
  }

  // Defensive shape check — match the extension's expectations.
  if (!session || typeof session !== 'object') {
    fail('SessionJSON must be an object');
  }
  if (!Array.isArray(session.transactions)) {
    fail('SessionJSON.transactions[] missing or not an array');
  }

  // 1. Correlations — page-response-driven, session cookies, dynamic redirects.
  let correlations = [];
  try {
    correlations = detectCorrelations(session) || [];
    session.correlations = correlations;
  } catch (e) {
    fail('detectCorrelations failed', String(e));
  }

  // 2. Field classification — must run AFTER correlations so it can reference them.
  let dataRequirements = [];
  try {
    dataRequirements = classifyFields(session) || [];
    session.dataRequirements = dataRequirements;
  } catch (e) {
    fail('classifyFields failed', String(e));
  }

  // 3. Assertions — optional, may be a no-op if generator export shape differs.
  let assertions = [];
  try {
    if (typeof generateAssertions === 'function') {
      assertions = generateAssertions(session) || [];
      session.assertions = assertions;
    }
  } catch (e) {
    // Don't fail the whole enrichment for an assertion-generator hiccup;
    // log the problem in the output for the caller to inspect.
    session.assertionsError = String(e);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    counts: {
      transactions: session.transactions.length,
      correlations: correlations.length,
      dataRequirements: dataRequirements.length,
      assertions: assertions.length,
    },
    session,
  }) + '\n');
})();
