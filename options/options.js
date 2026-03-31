import { getOptions, saveOptions } from '../shared/storage.js';
import { DEFAULT_EXCLUDED_DOMAINS } from '../shared/constants.js';

const $ = id => document.getElementById(id);

async function load() {
  const opts = await getOptions();
  $('opt-assure-url').value = opts.assureUrl || '';
  $('opt-api-key').value = opts.apiKey || '';
  $('opt-journey-code').value = opts.defaultJourneyCode || 'UJ01';
  $('opt-naming').value = opts.namingConvention || 'slug';
  $('opt-padding').value = String(opts.stepPadding || 2);
  $('opt-excluded').value = (opts.excludedDomains && opts.excludedDomains.length
    ? opts.excludedDomains
    : DEFAULT_EXCLUDED_DOMAINS
  ).join('\n');
  updateNamingPreview();
}

function updateNamingPreview() {
  const code = $('opt-journey-code').value.trim() || 'UJ01';
  const convention = $('opt-naming').value;
  const pad = parseInt($('opt-padding').value) || 2;
  const step = String(1).padStart(pad, '0');
  let preview = '';
  if (convention === 'slug') preview = `${code}_S${step}_login-page`;
  else if (convention === 'nhs') preview = `${code}_S${step}_proxy-booking-question`;
  else preview = `${code}_S${step}`;
  $('opt-naming-preview').textContent = preview;
}

$('opt-naming').addEventListener('change', updateNamingPreview);
$('opt-padding').addEventListener('change', updateNamingPreview);
$('opt-journey-code').addEventListener('input', updateNamingPreview);

$('opt-save').addEventListener('click', async () => {
  await saveOptions({
    assureUrl: $('opt-assure-url').value.trim().replace(/\/$/, ''),
    apiKey: $('opt-api-key').value.trim(),
    defaultJourneyCode: $('opt-journey-code').value.trim() || 'UJ01',
    namingConvention: $('opt-naming').value,
    stepPadding: parseInt($('opt-padding').value) || 2,
    excludedDomains: $('opt-excluded').value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  $('opt-status').textContent = 'Saved.';
  setTimeout(() => { $('opt-status').textContent = ''; }, 2000);
});

$('opt-test').addEventListener('click', async () => {
  const url = $('opt-assure-url').value.trim();
  const key = $('opt-api-key').value.trim();
  if (!url) { $('opt-status').textContent = 'Enter Assure URL first'; return; }
  $('opt-status').textContent = 'Testing...';
  try {
    const resp = await fetch(url + '/health', {
      headers: key ? { 'X-API-Key': key } : {},
    });
    $('opt-status').textContent = resp.ok ? 'Connected (' + resp.status + ')' : 'Failed: HTTP ' + resp.status;
  } catch (err) {
    $('opt-status').textContent = 'Failed: ' + err.message;
  }
});

load();
