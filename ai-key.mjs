/**
 * API key storage.
 *
 * The published userscript must never ship a secret, so the key lives only in
 * this browser's localStorage. localStorage is scoped to the Moodle origin, not
 * to the userscript, so it survives every script update the user installs.
 */
const STORAGE = 'moodle-workspace:v5:api-key';

export function getKey() {
  try { return localStorage.getItem(STORAGE) || ''; } catch { return ''; }
}

export function setKey(value) {
  const key = String(value == null ? '' : value).trim();
  try { if (key) localStorage.setItem(STORAGE, key); else localStorage.removeItem(STORAGE); } catch {}
  return key;
}

export function hasKey() { return !!getKey(); }

/** Never render a full key back into the page. */
export function maskKey(value) {
  const key = String(value == null ? '' : value);
  if (!key) return '';
  if (key.length <= 12) return key.slice(0, 2) + '…';
  return key.slice(0, 6) + '…' + key.slice(-4);
}
