// Persistence. Everything lives in chrome.storage.local on this device: one key per template
// ("tpl:<id>") plus "settings". Nothing is synced or sent anywhere.

import { validateTemplate, LIMITS } from './schema.js';

const TPL = 'tpl:';
export const DEFAULT_SETTINGS = Object.freeze({ waitTimeoutMs: 5000, language: 'auto', theme: 'auto', recSync: 'both' });

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object' && Number.isInteger(raw.waitTimeoutMs)) {
    s.waitTimeoutMs = Math.min(30000, Math.max(500, raw.waitTimeoutMs));
  }
  // 'auto' follows the browser; otherwise a locale code such as "de" or "pt_BR".
  if (raw && typeof raw === 'object' && typeof raw.language === 'string' && /^(auto|[a-z]{2}(_[A-Z]{2})?)$/.test(raw.language)) {
    s.language = raw.language;
  }
  if (raw && typeof raw === 'object' && ['auto', 'light', 'dark'].includes(raw.theme)) s.theme = raw.theme;
  // While recording: 'both' = page and panel fill each other; 'page' = only the page fills the panel.
  if (raw && typeof raw === 'object' && ['both', 'page'].includes(raw.recSync)) s.recSync = raw.recSync;
  return s;
}

export async function loadAll() {
  const all = await chrome.storage.local.get(null);
  const templates = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(TPL)) continue;
    const r = validateTemplate(value);
    if (r.ok && key === TPL + r.value.id) templates.push(r.value);
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return { templates, settings: normalizeSettings(all.settings) };
}

export async function saveTemplate(template) {
  const r = validateTemplate(template);
  if (!r.ok) throw new Error(r.error);
  await chrome.storage.local.set({ [TPL + r.value.id]: r.value });
  return r.value;
}

export async function saveTemplates(templates) {
  const items = {};
  for (const t of templates) {
    const r = validateTemplate(t);
    if (!r.ok) throw new Error(r.error);
    items[TPL + r.value.id] = r.value;
  }
  await chrome.storage.local.set(items);
}

export async function deleteTemplate(id) {
  await chrome.storage.local.remove(TPL + id);
}

export async function saveSettings(settings) {
  const s = normalizeSettings(settings);
  await chrome.storage.local.set({ settings: s });
  return s;
}

export function canAddTemplates(currentCount, extra = 1) {
  return currentCount + extra <= LIMITS.templatesTotal;
}

/** Short random id for templates and variants: 16 chars of [a-z0-9]. */
export function newId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
}
