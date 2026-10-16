// UI strings. The language follows the browser unless the person picks one in the panel. All
// translations are bundled in locales.js (generated from scripts/i18n/, like _locales/).

import { MESSAGES, LANGUAGES } from './locales.js';

export { LANGUAGES };

let lang = 'en';

/** 'auto' → the browser language if FormDitto has it (pt-BR → pt_BR, es-419 → es), else English. */
export function resolveLanguage(choice) {
  if (choice && choice !== 'auto' && Object.prototype.hasOwnProperty.call(MESSAGES, choice)) return choice;
  const ui = String(chrome.i18n.getUILanguage() || 'en').replace(/-/g, '_');
  if (Object.prototype.hasOwnProperty.call(MESSAGES, ui)) return ui;
  const base = ui.split('_')[0];
  return Object.prototype.hasOwnProperty.call(MESSAGES, base) ? base : 'en';
}

export function setLanguage(choice) {
  lang = resolveLanguage(choice);
  document.documentElement.lang = lang.replace('_', '-');
  return lang;
}

export const currentLanguage = () => lang;

export function languageName(code) {
  const found = LANGUAGES.find(([c]) => c === code);
  return found ? found[1] : code;
}

export function t(key, subs) {
  const own = MESSAGES[lang] && MESSAGES[lang][key];
  const msg = typeof own === 'string' ? own : MESSAGES.en[key];
  if (typeof msg !== 'string') return key;
  const list = subs === undefined ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);
  return msg.replace(/\$([1-9])/g, (_, d) => (list[d - 1] === undefined ? '' : list[d - 1]));
}

/** Fills static text in HTML: <span data-i18n="key"></span>, title and aria-label variants. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}
