/**
 * Chrome storage wrapper — abstracts chrome.storage.local for recording sessions.
 */

const KEYS = {
  STATE: 'recorderState',
  SESSION: 'currentSession',
  SESSIONS: 'savedSessions',
  OPTIONS: 'recorderOptions',
  AUTH: 'recorderAuth',
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

export async function getSavedSessions() {
  const result = await chrome.storage.local.get(KEYS.SESSIONS);
  return result[KEYS.SESSIONS] || [];
}

export async function addSavedSession(session) {
  const sessions = await getSavedSessions();
  sessions.unshift({
    ...session,
    savedAt: new Date().toISOString(),
  });
  // Keep last 20 sessions
  if (sessions.length > 20) sessions.length = 20;
  await chrome.storage.local.set({ [KEYS.SESSIONS]: sessions });
}

export async function deleteSavedSession(sessionId) {
  const sessions = await getSavedSessions();
  const filtered = sessions.filter(s => s.session.id !== sessionId);
  await chrome.storage.local.set({ [KEYS.SESSIONS]: filtered });
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

// ── Auth ──────────────────────────────────────────────────────

export async function getAuth() {
  const result = await chrome.storage.local.get(KEYS.AUTH);
  return result[KEYS.AUTH] || null;
}

export async function saveAuth(auth) {
  await chrome.storage.local.set({ [KEYS.AUTH]: auth });
}

export async function clearAuth() {
  await chrome.storage.local.remove(KEYS.AUTH);
}
