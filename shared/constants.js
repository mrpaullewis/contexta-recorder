/**
 * Shared constants for the Contexta Performance Recorder.
 */

// Recording states
export const State = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused',
};

// Recording modes
export const RecordingMode = {
  TRANSACTION: 'transaction',   // user marks UJ boundaries live
  AUTO: 'auto',                 // auto-split on page navigation
  FULL: 'full',                 // record everything, split later
};

// Static resource extensions — never recorded
export const STATIC_EXTENSIONS = new Set([
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.map', '.webp', '.avif',
  '.mp3', '.mp4', '.webm', '.ogg', '.pdf',
]);

// Static path segments — requests containing these are skipped
export const STATIC_PATH_SEGMENTS = [
  '/static/', '/assets/', '/dist/', '/vendor/', '/fonts/',
  '/images/', '/img/', '/media/', '/_next/static/',
];

// Content types that are never recorded
export const STATIC_CONTENT_TYPES = [
  'image/', 'font/', 'text/css', 'application/javascript',
  'application/x-javascript', 'audio/', 'video/',
];

// Third-party domains — skipped by default (user can override)
export const DEFAULT_EXCLUDED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'facebook.com', 'twitter.com', 'linkedin.com',
  'hotjar.com', 'clarity.ms', 'newrelic.com', 'datadoghq.com',
  'sentry.io', 'bugsnag.com', 'cloudflare.com', 'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com',
  'fonts.gstatic.com', 'ajax.googleapis.com',
];

// Browser-internal URL schemes — always skipped
export const INTERNAL_SCHEMES = ['chrome-extension://', 'chrome://', 'devtools://', 'about:', 'data:'];

// CSRF field name patterns (lowercase, normalised)
export const CSRF_FIELD_NAMES = new Set([
  'csrf_token', 'csrfmiddlewaretoken', '_csrf', 'csrf', 'csrftoken',
  '_token', 'authenticity_token', '__requestverificationtoken',
  'antiforgerytoken', '__antiforgerytoken', 'verification_token',
]);

// CSRF detection patterns for response body scanning
export const CSRF_PATTERNS = [
  { regex: /name=["'](?:csrf[_-]?token|_csrf|__RequestVerificationToken|authenticity_token)["']\s*(?:value|content)=["']([^"']+)["']/gi, type: 'hidden_input' },
  { regex: /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/gi, type: 'meta_tag' },
  { regex: /"csrf[_-]?token"\s*:\s*"([^"]+)"/gi, type: 'json' },
];

// Session cookie name patterns
export const SESSION_COOKIE_PATTERNS = [
  /^session/i, /^sess_/i, /^sid$/i, /^connect\.sid$/i,
  /^phpsessid$/i, /^jsessionid$/i, /^asp\.net_sessionid$/i,
  /^_session/i, /^auth[_-]?token/i, /^access[_-]?token/i,
];

// Form field type classification heuristics
export const FIELD_TYPE_HINTS = {
  csrf: ['csrf', 'token', 'verification', 'antiforgery', '__requestverification'],
  email: ['email', 'e-mail', 'emailaddress', 'user_email'],
  password: ['password', 'passwd', 'pwd', 'pass'],
  name: ['firstname', 'first_name', 'lastname', 'last_name', 'surname', 'fullname', 'full_name', 'name'],
  phone: ['phone', 'tel', 'telephone', 'mobile', 'cell'],
  postcode: ['postcode', 'post_code', 'zipcode', 'zip_code', 'zip'],
  dob: ['dob', 'date_of_birth', 'dateofbirth', 'birthdate', 'birth_date'],
  nhs: ['nhs', 'nhsnumber', 'nhs_number'],
  address: ['address', 'street', 'city', 'county', 'country'],
};

// Default think time range (ms) between transactions
export const THINK_TIME = {
  MIN: 500,
  MAX: 3000,
};

// Max response body to store for correlation scanning (bytes)
// NHS pages have large <head> sections (CSS, JS, analytics) — form content
// with hidden fields and CSRF tokens typically starts after 4-6KB.
export const MAX_BODY_SNIPPET = 65536;

// Assure API defaults
export const ASSURE_API = {
  DEFAULT_URL: 'https://dev.contexta.uk',
  MANIFEST_ENDPOINT: '/api/v1/manifests',
  CONFIGS_ENDPOINT: '/nfr-perftest/run-builder/configs',
  SPECS_ENDPOINT: '/nfr-perftest/data-generator/specs',
};

// NHS PerfTest Dashboard
export const NHS_API = {
  DEFAULT_URL: 'http://nbs-generic-mock-vm-feat.uksouth.cloudapp.azure.com:8081',
};
