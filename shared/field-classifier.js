/**
 * Form field classification engine.
 *
 * Classifies every captured form field into categories that drive JMX generation:
 * - csrf: anti-forgery tokens (auto-correlated)
 * - hidden: dynamic hidden fields (correlation candidates)
 * - input: user text inputs (parameterised from CSV)
 * - radio: decision points (fixed or parameterised)
 * - select: dropdown selections (fixed or parameterised)
 * - checkbox: toggles (fixed value)
 * - static: unchanging values (hardcoded in JMX)
 *
 * Also suggests data column types for parameterisation.
 */
import { CSRF_FIELD_NAMES, FIELD_TYPE_HINTS } from './constants.js';

/**
 * Classify all form fields in a session and return dataRequirements array.
 */
export function classifyFields(session) {
  const dataRequirements = [];

  for (const tx of session.transactions) {
    for (const req of tx.requests) {
      if (!req.formFields || req.formFields.length === 0) continue;

      for (const field of req.formFields) {
        const classification = classifyField(field, session.correlations || []);
        field.classification = classification;

        // Only fields that need parameterisation go into dataRequirements
        if (classification === 'input' || classification === 'radio' || classification === 'select') {
          const columnType = suggestColumnType(field);
          dataRequirements.push({
            fieldName: field.name,
            fieldType: field.type,
            classification,
            transaction: tx.name,
            requestSeq: req.seq,
            sampleValue: field.value || '',
            label: field.label || '',
            suggestedCsvColumn: suggestCsvColumn(field),
            columnType,
            datafileSpecId: null,
            datafileColumn: null,
          });
        }
      }
    }
  }

  return deduplicateRequirements(dataRequirements);
}

/**
 * Classify a single form field.
 */
export function classifyField(field, correlations) {
  const name = field.name || '';
  const nameLower = name.toLowerCase();
  const type = (field.type || '').toLowerCase();

  // CSRF tokens
  if (CSRF_FIELD_NAMES.has(nameLower)) return 'csrf';
  if (field.isHidden && isCsrfLike(name)) return 'csrf';

  // Check if this field is already detected as a correlation
  if (correlations.some(c => c.name === name || c.name === sanitiseName(name))) {
    return 'csrf';
  }

  // Hidden fields that aren't CSRF are dynamic correlation candidates
  if (field.isHidden || type === 'hidden') return 'hidden';

  // Radio buttons — decision points
  if (type === 'radio') return 'radio';

  // Checkboxes
  if (type === 'checkbox') return 'checkbox';

  // Select dropdowns
  if (type === 'select' || type === 'select-one' || type === 'select-multiple') return 'select';

  // Submit/button — always static, not recorded as data
  if (type === 'submit' || type === 'button' || type === 'image') return 'static';

  // Remaining inputs — classify by content heuristics
  if (isStaticField(field)) return 'static';

  return 'input';
}

/**
 * Suggest a data column type based on field characteristics.
 */
export function suggestColumnType(field) {
  const name = (field.name || '').toLowerCase();
  const type = (field.type || '').toLowerCase();
  const label = (field.label || '').toLowerCase();
  const combined = `${name} ${label}`;

  // Direct type matches
  if (type === 'email' || matchesAny(combined, FIELD_TYPE_HINTS.email)) return 'email';
  if (type === 'tel' || matchesAny(combined, FIELD_TYPE_HINTS.phone)) return 'phone_uk';
  if (type === 'date' || matchesAny(combined, FIELD_TYPE_HINTS.dob)) return 'date';

  if (matchesAny(combined, FIELD_TYPE_HINTS.nhs)) return 'nhs_number';
  if (matchesAny(combined, FIELD_TYPE_HINTS.postcode)) return 'postcode';
  if (matchesAny(combined, FIELD_TYPE_HINTS.name)) return 'first_name';
  if (matchesAny(combined, FIELD_TYPE_HINTS.password)) return 'password';
  if (matchesAny(combined, FIELD_TYPE_HINTS.address)) return 'lorem';

  // Select/radio with defined options → choice
  if ((field.type === 'radio' || field.type === 'select') && field.options?.length > 0) {
    return 'choice';
  }

  // Numeric input
  if (type === 'number') return 'int_random';

  // Default to lorem for text-like fields
  return 'lorem';
}

/**
 * Suggest a CSV column name from the field.
 */
export function suggestCsvColumn(field) {
  const name = field.name || '';
  // Clean up common prefixes/suffixes
  let col = name
    .replace(/^(form_|input_|field_|txt_|ddl_|rdo_)/i, '')
    .replace(/\[\]$/, '')
    .replace(/\[.*\]/, '');

  // Convert to snake_case
  col = col
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();

  return col || 'field';
}


// ── Internal helpers ─────────────────────────────────────────

function isCsrfLike(name) {
  const lower = name.toLowerCase();
  return lower.includes('csrf') ||
    lower.includes('antiforgery') ||
    lower.includes('verification_token') ||
    lower.includes('__requestverification') ||
    lower.includes('authenticity_token');
}

function isStaticField(field) {
  // Fields with no value or very short unchanging values
  if (!field.value) return false;
  // Submit button values
  if (field.type === 'submit') return true;
  // Fields named with patterns suggesting static behaviour
  const staticPatterns = ['action', 'submit', 'button', 'redirect', 'return_url', 'next'];
  return staticPatterns.some(p => field.name.toLowerCase().includes(p));
}

function matchesAny(text, patterns) {
  return patterns.some(p => text.includes(p));
}

function sanitiseName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Deduplicate data requirements — same field appearing in multiple requests
 * should only appear once, keeping the first occurrence.
 */
function deduplicateRequirements(requirements) {
  const seen = new Set();
  return requirements.filter(r => {
    const key = `${r.fieldName}:${r.classification}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
