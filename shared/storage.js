/**
 * Chrome storage wrapper — abstracts chrome.storage.local for recording sessions.
 */

const KEYS = {
  STATE: 'recorderState',
  SESSION: 'currentSession',
  OPTIONS: 'recorderOptions',
};

export async function getState() {
  const result = await chrome.storage.local.get(KEYS.STATE);
  return result[KEYS.STATE] || 'idle';
}

export async function setState(state) {
  await chrome.storage.local.set({ [KEYS.STATE]: state });
}

export async function getSession() {
  const result = await chrome.storage.local.get(KEYS.SESSION);
  return result[KEYS.SESSION] || null;
}

export async function saveSession(session) {
  await chrome.storage.local.set({ [KEYS.SESSION]: session });
}

export async function clearSession() {
  await chrome.storage.local.remove(KEYS.SESSION);
}

export async function getOptions() {
  const result = await chrome.storage.local.get(KEYS.OPTIONS);
  return result[KEYS.OPTIONS] || {
    studioUrl: '',
    apiKey: '',
    excludedDomains: [],
    recordStaticResources: false,
    autoTransaction: false,
    defaultJourneyCode: 'UJ01',
    namingConvention: 'slug',  // 'slug' | 'nhs' | 'plain'
    stepPadding: 2,            // 2 → S01, 3 → S001
  };
}

export async function saveOptions(options) {
  await chrome.storage.local.set({ [KEYS.OPTIONS]: options });
}
