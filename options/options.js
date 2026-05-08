import { getOptions, saveOptions } from '../shared/storage.js';
import { DEFAULT_EXCLUDED_DOMAINS } from '../shared/constants.js';

const $ = id => document.getElementById(id);

async function load() {
  const opts = await getOptions();
  $('opt-studio-url').value = opts.studioUrl || '';
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
  else preview = `${code}_S${step}`;
  $('opt-naming-preview').textContent = preview;
}

$('opt-naming').addEventListener('change', updateNamingPreview);
$('opt-padding').addEventListener('change', updateNamingPreview);
$('opt-journey-code').addEventListener('input', updateNamingPreview);

$('opt-save').addEventListener('click', async () => {
  await saveOptions({
    studioUrl: $('opt-studio-url').value.trim().replace(/\/$/, ''),
    apiKey: $('opt-api-key').value.trim(),
    defaultJourneyCode: $('opt-journey-code').value.trim() || 'UJ01',
    namingConvention: $('opt-naming').value,
    stepPadding: parseInt($('opt-padding').value) || 2,
    excludedDomains: $('opt-excluded').value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  $('opt-status').textContent = 'Saved.';
  setTimeout(() => { $('opt-status').textContent = ''; }, 2000);
});

$('opt-test-studio').addEventListener('click', async () => {
  const url = $('opt-studio-url').value.trim();
  const key = $('opt-api-key').value.trim();
  if (!url) { $('opt-status').textContent = 'Enter Contexta Performance Studio URL first'; return; }
  $('opt-status').textContent = 'Testing Studio...';
  try {
    const resp = await fetch(url + '/health', {
      headers: key ? { 'X-API-Key': key } : {},
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      const product = data?.product || 'Studio';
      const version = data?.version?.full || '';
      $('opt-status').textContent = product + ' connected' + (version ? ' (v' + version + ')' : '') + ' — ' + resp.status;
    } else {
      $('opt-status').textContent = 'Studio failed: HTTP ' + resp.status;
    }
  } catch (err) {
    $('opt-status').textContent = 'Studio failed: ' + err.message;
  }
});

load();
