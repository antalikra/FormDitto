// FormDitto side panel: templates, variants, recording, preview, fill and undo.
// All page work goes through content/agent.js via chrome.scripting.executeScript on the active tab.

import { h, append, clear, icon } from './lib/dom.js';
import { t, applyI18n, setLanguage, resolveLanguage, languageName, LANGUAGES } from './lib/i18n.js';
import * as store from './lib/store.js';
import { parseImport, buildExport, LIMITS, KINDS } from './lib/schema.js';
import { originOf, permissionPattern, compareOrigins, hostOf } from './lib/origin.js';
import { isFromServiceWorker, isRecordingSender, parseRecPing, isActionClicked, randomToken, BLOCK_REASONS } from './lib/messages.js';

const RUNTIME_ID = chrome.runtime.id;
const SW_URL = chrome.runtime.getURL('background.js');
// Test hook: the e2e suite opens this page in a normal tab and points it at the tab under test.
// Extension pages are not web-accessible, so websites cannot open the panel with this parameter.
const params = new URLSearchParams(location.search);
const TAB_OVERRIDE = params.has('tab') ? Number(params.get('tab')) : null;
// Same, but follows the active tab of the given window, like the real side panel does.
const WINDOW_OVERRIDE = params.has('window') ? Number(params.get('window')) : null;

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.dataset.theme = darkQuery.matches ? 'dark' : 'light';

const state = {
  view: 'home',
  site: null,
  templates: [],
  settings: { ...store.DEFAULT_SETTINGS },
  query: '',
  variantQuery: '',
  templateId: null,
  variantId: null,
  openVariant: null, // variant whose values are drawn as a form in the template view
  confirm: null, // id of the item waiting for a delete confirmation
  rec: null,
  preview: null,
  result: null,
  importDraft: null,
  notice: null,
  busy: false,
};

const $site = document.getElementById('site');
const $notice = document.getElementById('notice');
const $view = document.getElementById('view');
const $importFile = document.getElementById('importFile');
// Element.append() would turn null into the text "null"; this skips empty slots.
const mount = (...nodes) => append($view, nodes);

// ---------------------------------------------------------------------------------------------
// Helpers

const kindText = (kind) => (KINDS.includes(kind) ? t(`kind_${kind}`) : kind);
const reasonText = (code) => (code && BLOCK_REASONS.includes(code) ? t(`reason_${code.replace(/-/g, '_')}`) : t('reason_unsupported'));
const byId = (list, id) => list.find((x) => x.id === id) || null;
const currentTemplate = () => byId(state.templates, state.templateId);

let noticeTimer = 0;
function notice(kind, text) {
  clearTimeout(noticeTimer);
  state.notice = text ? { kind, text } : null;
  renderNotice();
  if (text && kind !== 'error') noticeTimer = setTimeout(() => { if (state.notice && state.notice.text === text) notice(null); }, 3500);
}

function setBusy(on) {
  state.busy = on;
  document.body.classList.toggle('busy', on);
  for (const b of $view.querySelectorAll('button')) if (on) b.disabled = true;
}

function btn(label, onClick, { kind = '', ico = null, title = null, disabled = false, testid = null } = {}) {
  return h(
    'button',
    { type: 'button', class: `btn ${kind}`.trim(), onClick, title, disabled, dataset: testid ? { testid } : undefined },
    ico ? icon(ico) : null,
    label ? h('span', { text: label }) : null,
  );
}

function iconBtn(ico, title, onClick, testid) {
  return h('button', { type: 'button', class: 'icon-btn', title, aria: { label: title }, onClick, dataset: testid ? { testid } : undefined }, icon(ico));
}

function displayValue(field, value, options) {
  if (field.kind === 'checkbox') return value === true ? t('checked') : value === false ? t('unchecked') : '';
  if (value === undefined || value === null || value === '') return '';
  if (field.kind === 'select' || field.kind === 'radio') {
    // Options on the page first, then the ones recorded with the template (the page list may still be loading).
    const find = (opts) => (opts || []).find((x) => x.v === value) || (opts || []).find((x) => x.t.toLowerCase() === String(value).toLowerCase());
    const o = find(options) || find(field.options);
    return o ? o.t || o.v : String(value);
  }
  return String(value);
}

function optionExists(options, value) {
  if (!options) return true;
  const v = String(value).toLowerCase();
  return options.some((o) => o.v === value || o.t.toLowerCase() === v);
}

function hasValue(field, values) {
  if (!Object.prototype.hasOwnProperty.call(values, field.id)) return false;
  const v = values[field.id];
  return field.kind === 'checkbox' ? typeof v === 'boolean' : typeof v === 'string' && v !== '';
}

function variantSummary(tpl, variant) {
  const parts = [];
  for (const f of tpl.fields) {
    if (!hasValue(f, variant.values) || f.kind === 'checkbox') continue;
    parts.push(displayValue(f, variant.values[f.id]));
    if (parts.length === 3) break;
  }
  return parts.join(' · ');
}

function matchesQuery(text, q) {
  return String(text).toLowerCase().includes(q);
}

function templateMatches(tpl, q) {
  if (!q) return true;
  if (matchesQuery(tpl.name, q)) return true;
  return tpl.variants.some((v) => variantMatches(tpl, v, q));
}

function variantMatches(tpl, v, q) {
  if (!q) return true;
  if (matchesQuery(v.name, q)) return true;
  return tpl.fields.some((f) => hasValue(f, v.values) && matchesQuery(displayValue(f, v.values[f.id]), q));
}

function fieldsForAgent(tpl) {
  return tpl.fields.map((f) => ({ id: f.id, kind: f.kind, locator: f.locator }));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'hidden' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Two letters for a template badge: "Service request" → "SR", "Pumps" → "PU". */
function initials(name) {
  const words = String(name).match(/[\p{L}\p{N}]+/gu) || ['?'];
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Form sketch: a template drawn as a small form, grouped by the sections of the page. Each row is
// { field, value?, display?, n?, action?, control?, testid? }; `control` turns it into an editor.

function sketch(rows, { editor = false } = {}) {
  const wrap = h('div', { class: `sketch${editor ? ' editor' : ''}` });
  let grid = null;
  let section = null;
  for (const row of rows) {
    const s = row.field.section || '';
    if (grid === null || s !== section) {
      section = s;
      grid = h('div', { class: 'sk-grid' });
      wrap.append(h('div', { class: 'sk-section' }, s ? h('div', { class: 'sk-title', text: s }) : null, grid));
    }
    grid.append(sketchField(row));
  }
  return wrap;
}

function sketchField({ field, value, display, placeholder, n, action, control, testid, index }) {
  const kind = field.kind;
  const name = field.label || t('unnamedField');
  const label = h('span', { class: 'sk-label', text: name, title: name });
  const num = n ? h('span', { class: 'sk-n', text: String(n) }) : null;
  const data = {};
  if (testid) data.testid = testid;
  if (index !== undefined) data.index = String(index);
  const el = h('div', { class: `sk-field k-${kind}`, dataset: data });
  if (control) {
    if (kind === 'checkbox') return append(el, [h('div', { class: 'sk-check-row' }, num, control.el, action)]);
    return append(el, [h('div', { class: 'sk-head' }, num, label, action), control.el]);
  }
  const text = display !== undefined ? display : displayValue(field, value);
  if (kind === 'checkbox') {
    const on = value === true;
    const unset = value !== true && value !== false;
    // Checked, unchecked or (dashed) not set: the box says it, no words needed.
    return append(el, [h('div', { class: `sk-check${on ? ' on' : ''}${unset ? ' unset' : ''}`, title: text || undefined },
      num, h('span', { class: 'box' }, on ? icon('check', 12) : null), label, action)]);
  }
  el.append(h('div', { class: 'sk-head' }, num, label, action));
  const options = (field.options || []).filter((o) => o.v !== '');
  if (kind === 'radio' && options.length) {
    const shown = options.slice(0, 8);
    const chosen = options.find((o) => o.v === value);
    if (chosen && !shown.includes(chosen)) shown.push(chosen);
    const radios = h('div', { class: 'sk-radios', role: 'radiogroup', aria: { label: name } }, shown.map((o) => h('span', { class: `sk-opt${o === chosen ? ' on' : ''}`, role: 'radio', aria: { checked: String(o === chosen), disabled: 'true' }, text: o.t || o.v })));
    if (options.length > shown.length) radios.append(h('span', { class: 'sk-opt', text: `+${options.length - shown.length}` }));
    return append(el, [radios]);
  }
  const ico = kind === 'select' ? icon('chevronDown', 14) : kind === 'date' ? icon('calendar', 14) : null;
  return append(el, [h('div', { class: 'sk-box' }, h('span', { class: `sk-value${text ? '' : ' empty-v'}`, text: text || placeholder || '—' }), ico)]);
}

/** Groups rows by field.section for lists that are not sketches (preview, results). */
function bySection(rows, getField) {
  const groups = [];
  for (const row of rows) {
    const s = getField(row).section || '';
    if (!groups.length || groups[groups.length - 1].section !== s) groups.push({ section: s, rows: [] });
    groups[groups.length - 1].rows.push(row);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Controls. The native <select> list cannot be styled (and turns unreadable on dark panels), so the
// panel has its own dropdown: a button plus a popover list with full keyboard support. Field editors
// are { el, get(), set(value) }; get() gives the variant value ('' = not set, checkbox true/false/undefined).

let ddSeq = 0;

function dropdown({ options, value, onChange = () => {}, label, testid, field }) {
  const id = `dd-${++ddSeq}`;
  let current = value;
  const text = h('span', { class: 'dd-value' });
  const data = {};
  if (testid) data.testid = testid;
  if (field) data.field = field;
  const button = h('button', { type: 'button', class: 'dd-btn', title: label, aria: { haspopup: 'listbox', expanded: 'false', controls: id, label }, dataset: data },
    text, icon('chevronDown', 14));
  const menu = h('div', { class: 'dd-menu', id, role: 'listbox', popover: 'auto', aria: { label } });
  const items = options.map((o) => h('div', { class: `dd-opt${o.muted ? ' muted' : ''}`, role: 'option', tabIndex: -1, title: o.label, dataset: { value: o.value }, aria: { selected: 'false' }, onClick: () => choose(o.value) },
    h('span', { class: 'dd-check' }, icon('check', 14)), h('span', { class: 'dd-text', text: o.label })));
  append(menu, items);
  // The button toggles the popover natively, so a click on it while open closes instead of reopening.
  button.popoverTargetElement = menu;
  const el = h('div', { class: 'dd' }, button, menu);

  const paint = () => {
    const o = options.find((x) => x.value === current);
    text.textContent = o ? o.label : '';
    text.classList.toggle('placeholder', !o || !!o.muted);
    button.setAttribute('aria-label', o ? `${label}: ${o.label}` : label);
    for (const it of items) it.setAttribute('aria-selected', String(it.dataset.value === current));
  };
  const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); };
  const choose = (v) => {
    close();
    button.focus();
    if (v === current) return;
    current = v;
    paint();
    onChange(v);
  };
  const place = (height) => {
    const r = button.getBoundingClientRect();
    menu.style.minWidth = `${Math.min(innerWidth - 16, Math.max(160, Math.round(r.width)))}px`;
    const below = innerHeight - r.bottom - 10;
    const above = r.top - 10;
    const down = below >= Math.min(height, 220) || below >= above;
    const max = Math.max(120, Math.min(340, down ? below : above));
    menu.style.maxHeight = `${max}px`;
    const h2 = Math.min(height, max);
    menu.style.top = `${Math.round(down ? r.bottom + 6 : r.top - 6 - h2)}px`;
    const width = Math.max(menu.offsetWidth || 0, 160, r.width);
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - width - 8)))}px`;
  };
  const onScroll = () => close();
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState === 'open') place(items.length * 36 + 10);
  });
  menu.addEventListener('toggle', (e) => {
    const open = e.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    el.classList.toggle('open', open);
    if (open) {
      place(menu.scrollHeight);
      (items.find((it) => it.dataset.value === current) || items[0]).focus();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
    } else {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (menu.contains(document.activeElement)) button.focus();
    }
  });
  button.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menu.matches(':popover-open')) {
      e.preventDefault();
      menu.showPopover();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    const move = (j) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, j))].focus();
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault();
      choose(items[i].dataset.value);
    } else if (e.key === 'Tab') close();
  });
  paint();
  return { el, button, get: () => current, set: (v) => { current = v; paint(); } };
}

function makeControl(field, value, onChange = () => {}, { allowUnset = false } = {}) {
  const kind = field.kind;
  const name = field.label || t('unnamedField');
  const data = { field: field.id, testid: 'edit-value' };
  const options = (field.options || []).filter((o) => o.v !== '');

  if (kind === 'checkbox') {
    // A click toggles checked/unchecked. In a variant the box can also be "not set" (the fill then
    // leaves it alone): shown dashed, and reachable with the small reset button.
    let v = value === true ? true : value === false ? false : undefined;
    const box = h('span', { class: 'box' });
    // The box itself shows checked/unchecked; words only for "not set", which a box cannot show.
    const stateText = h('span', { class: 'sk-value' });
    const toggle = h('button', { type: 'button', class: 'sk-check', role: 'checkbox', aria: { label: name }, dataset: data, onClick: () => {
      v = v !== true;
      paint();
      onChange();
    } }, box, h('span', { class: 'sk-label', text: name, title: name }), stateText);
    const reset = allowUnset ? iconBtn('undo', t('notSet'), () => { v = undefined; paint(); onChange(); toggle.focus(); }, 'check-reset') : null;
    const el = h('div', { class: 'sk-check-ctl' }, toggle, reset);
    const paint = () => {
      toggle.classList.toggle('on', v === true);
      toggle.classList.toggle('unset', v === undefined);
      toggle.setAttribute('aria-checked', v === undefined ? 'mixed' : String(v));
      clear(box);
      if (v === true) box.append(icon('check', 13));
      stateText.textContent = v === undefined ? t('notSet') : '';
      if (reset) reset.hidden = v === undefined;
    };
    paint();
    return { el, get: () => v, set: (x) => { v = x === true ? true : x === false ? false : undefined; paint(); } };
  }

  if (kind === 'radio' && options.length && options.length <= 8) {
    let v = typeof value === 'string' ? value : '';
    const list = options.slice();
    if (v && !list.some((o) => o.v === v)) list.push({ v, t: v });
    const group = h('div', { class: 'sk-radios', role: 'radiogroup', aria: { label: name }, dataset: { field: field.id } });
    const buttons = list.map((o) => h('button', { type: 'button', class: 'sk-opt', role: 'radio', title: o.t || o.v, dataset: { value: o.v }, text: o.t || o.v, onClick: () => {
      v = v === o.v ? '' : o.v;
      paint(true);
      onChange();
    } }));
    append(group, buttons);
    roving(buttons, (b) => b.click());
    const place = slidingPill(group);
    const paint = (animate) => {
      for (const b of buttons) {
        const on = b.dataset.value === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      const tab = buttons.find((b) => b.dataset.value === v) || buttons[0];
      for (const b of buttons) b.tabIndex = b === tab ? 0 : -1;
      place(animate);
    };
    paint(false);
    return { el: group, get: () => v, set: (x) => { v = typeof x === 'string' ? x : ''; paint(true); } };
  }

  if ((kind === 'select' || kind === 'radio') && options.length) {
    const list = [{ value: '', label: t('notSet'), muted: true }, ...options.map((o) => ({ value: o.v, label: o.t || o.v }))];
    if (typeof value === 'string' && value && !options.some((o) => o.v === value)) list.push({ value, label: value });
    return dropdown({ options: list, value: typeof value === 'string' ? value : '', label: name, testid: 'edit-value', field: field.id, onChange: () => onChange() });
  }

  const type = kind === 'date' ? field.inputType || 'date' : ['email', 'tel', 'url', 'number'].includes(field.inputType) ? field.inputType : 'text';
  const input = kind === 'textarea'
    ? h('textarea', { rows: 3, maxLength: LIMITS.value, dataset: data, aria: { label: name }, onInput: () => onChange() })
    : h('input', { type, maxLength: LIMITS.value, dataset: data, aria: { label: name }, onInput: () => onChange() });
  input.value = typeof value === 'string' ? value : '';
  return { el: input, get: () => input.value, set: (x) => { input.value = typeof x === 'string' ? x : ''; } };
}

/** Normalised variant value of an editor (undefined = leave the field alone). */
function controlValue(field, ctl) {
  const v = ctl.get();
  if (field.kind === 'checkbox') return typeof v === 'boolean' ? v : undefined;
  return typeof v === 'string' && v !== '' ? v.slice(0, LIMITS.value) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Tab, site access and the page agent

async function targetTab() {
  if (TAB_OVERRIDE !== null) {
    try {
      return await chrome.tabs.get(TAB_OVERRIDE);
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query(WINDOW_OVERRIDE !== null ? { active: true, windowId: WINDOW_OVERRIDE } : { active: true, currentWindow: true });
  return tab || null;
}

// Without a URL the tab is either not a web page or FormDitto has no access to it yet: a toolbar
// click grants access to the current tab only, so a newly opened tab needs another click.
function noSiteError(site) {
  return site && site.access === 'unsupported' ? t('siteUnsupported') : t('errNoTabAccess');
}

async function refreshSite() {
  const tab = await targetTab();
  if (!tab) {
    state.site = { access: 'unknown' };
    return state.site;
  }
  // The address is kept only to notice navigation (SPA route changes included); it is never shown.
  const site = { tabId: tab.id, access: 'unknown', url: tab.url || '' };
  if (tab.url) {
    const origin = originOf(tab.url);
    if (!origin) site.access = 'unsupported';
    else {
      site.origin = origin;
      site.pattern = permissionPattern(origin);
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: [site.pattern] });
      } catch {
        granted = false;
      }
      site.access = granted ? 'granted' : 'temporary';
    }
  }
  state.site = site;
  return site;
}

async function agentCall(tabId, method, args) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/agent.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, a) => globalThis.__formditto.call(m, a),
      args: [method, args || {}],
    });
    return res && res.result ? res.result : { ok: false, error: 'no-result' };
  } catch (e) {
    return { ok: false, error: 'no-access', detail: String((e && e.message) || e) };
  }
}

function agentError(res) {
  if (!res) return t('errAgent', ['?']);
  if (res.error === 'no-access') return t('errNoAccess');
  if (res.error === 'origin-mismatch') return t('errPageChanged');
  if (res.error === 'nothing-to-undo') return t('errNothingToUndo');
  return t('errAgent', [res.detail || res.error || '?']);
}

function requestAccess() {
  const pattern = state.site && state.site.pattern;
  if (!pattern) return;
  // Must be called synchronously from the click (user gesture). One site only.
  chrome.permissions
    .request({ origins: [pattern] })
    .catch(() => false)
    .then(async () => {
      await refreshSite();
      render();
    });
}

// ---------------------------------------------------------------------------------------------
// Rendering: site card and notice

function renderSite() {
  clear($site);
  const s = state.site || { access: 'unknown' };
  const card = h('div', { class: 'site-card' });
  $site.append(card);
  if (s.access === 'unknown') {
    card.append(h('div', { class: 'site-row muted' }, icon('lock'), h('div', {}, h('strong', { text: t('siteUnknownTitle') }), h('p', { text: t('siteUnknownBody') }))));
    return;
  }
  if (s.access === 'unsupported') {
    card.append(h('div', { class: 'site-row muted' }, icon('lock'), h('span', { text: t('siteUnsupported') })));
    return;
  }
  // The usual case (access granted) is one slim line; temporary access also offers the permanent one.
  const status = t(s.access === 'granted' ? 'accessGranted' : 'accessTemporary');
  card.classList.toggle('compact', s.access === 'granted');
  card.append(h('div', { class: 'site-row' }, h('span', { class: `dot ${s.access}` }), h('div', { class: 'site-main' }, h('strong', { class: 'site-host', text: hostOf(s.origin), title: s.origin }), h('span', { class: 'site-access', text: status, title: status }))));
  if (s.access === 'temporary') {
    card.append(h('div', { class: 'site-allow' }, btn(t('alwaysAllow'), requestAccess, { kind: 'secondary small', ico: 'shield', testid: 'allow-site' }), h('p', { class: 'hint', text: t('accessNote') })));
  }
}

function renderNotice() {
  clear($notice);
  if (!state.notice) return;
  $notice.append(h('div', { class: `notice ${state.notice.kind}` }, icon(state.notice.kind === 'error' ? 'warn' : 'check'), h('span', { text: state.notice.text }), iconBtn('x', t('close'), () => notice(null), 'notice-close')));
}

function render() {
  renderSite();
  renderNotice();
  clear($view);
  const views = { home: renderHome, record: renderRecord, template: renderTemplate, edit: renderEdit, preview: renderPreview, result: renderResult, import: renderImport, settings: renderSettings };
  (views[state.view] || renderHome)();
  // Toasts sit above a sticky action bar when the view has one.
  document.body.classList.toggle('with-actions', !!$view.querySelector('.actions.sticky'));
  if (state.busy) setBusy(true);
}

function go(view, patch = {}) {
  Object.assign(state, { confirm: null }, patch, { view });
  render();
  $view.scrollTop = 0;
}

// ---------------------------------------------------------------------------------------------
// Home: templates for this site

function renderHome() {
  const site = state.site || {};
  const canWork = !!site.origin;
  const cta = btn(t('newTemplate'), startRecording, { kind: 'primary block', ico: 'plus', disabled: !canWork, testid: 'new-template' });
  const search = h('label', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: t('searchTemplates'), value: state.query, dataset: { testid: 'search-templates' }, onInput: (e) => { state.query = e.target.value; renderList(); } }));
  const list = h('div', { class: 'home-lists' });
  const renderList = () => {
    clear(list);
    const q = state.query.trim().toLowerCase();
    const here = state.templates.filter((tp) => canWork && tp.origin === site.origin && templateMatches(tp, q));
    const others = state.templates.filter((tp) => !(canWork && tp.origin === site.origin) && templateMatches(tp, q));
    if (canWork) {
      const group = h('div', { class: 'group' }, h('h2', { text: t('templatesHere') }));
      if (!here.length) group.append(h('p', { class: 'empty', text: state.templates.some((tp) => tp.origin === site.origin) ? t('nothingFound') : t('noTemplatesHere') }));
      else group.append(h('div', { class: 'list' }, here.map((tp) => templateCard(tp, q))));
      list.append(group);
    }
    if (others.length) {
      list.append(h('details', { class: 'others group', open: !canWork || !!q }, h('summary', { text: t(canWork ? 'otherSites' : 'allTemplates', [String(others.length)]) }), h('div', { class: 'list' }, others.map((tp) => templateCard(tp, q)))));
    }
  };
  renderList();
  const footer = h('div', { class: 'footer' },
    btn(t('importBtn'), () => $importFile.click(), { kind: 'ghost small', ico: 'upload', testid: 'import' }),
    btn(t('exportAll'), exportAll, { kind: 'ghost small', ico: 'download', disabled: !state.templates.length, testid: 'export-all' }),
    h('p', { class: 'hint' }, icon('lock', 13), h('span', { text: t('localNote') })));
  mount(cta, state.templates.length ? search : null, list, footer);
}

function templateCard(tp, q) {
  const matching = q ? tp.variants.filter((v) => variantMatches(tp, v, q)) : [];
  return h(
    'button',
    { type: 'button', class: 'card', dataset: { testid: 'template-card' }, onClick: () => go('template', { templateId: tp.id, openVariant: null, variantQuery: q && !matchesQuery(tp.name, q) ? state.query : '' }) },
    h('span', { class: 'bubble', text: initials(tp.name) }),
    h('span', { class: 'card-title', text: tp.name }),
    h('span', { class: 'card-meta', text: `${t('fieldsLabel', [String(tp.fields.length)])} · ${t('variantsLabel', [String(tp.variants.length)])}` }),
    state.site && tp.origin !== state.site.origin ? h('span', { class: 'card-origin', text: hostOf(tp.origin) }) : null,
    matching.length ? h('span', { class: 'card-match', text: matching.slice(0, 3).map((v) => v.name).join(', ') }) : null,
    icon('chevron'),
  );
}

// ---------------------------------------------------------------------------------------------
// Recording

const recStrings = () => ({
  banner: t('recBanner'),
  add: t('recHoverAdd'),
  added: t('recHoverAdded'),
  blocked: t('recHoverBlocked'),
  reasons: Object.fromEntries(BLOCK_REASONS.map((r) => [r, reasonText(r)])),
});

async function startRecording() {
  notice(null);
  const site = await refreshSite();
  if (!site.origin) {
    render();
    return notice('error', noSiteError(site));
  }
  if (!store.canAddTemplates(state.templates.length)) return notice('error', t('errLimit', [String(LIMITS.templatesTotal)]));
  const token = randomToken();
  const res = await agentCall(site.tabId, 'recordStart', { origin: site.origin, token, strings: recStrings() });
  if (!res.ok) return notice('error', agentError(res));
  if (!state.site || state.site.tabId !== site.tabId || state.site.origin !== site.origin) {
    await agentCall(site.tabId, 'recordStop', { token });
    return;
  }
  state.rec = { tabId: site.tabId, origin: site.origin, token, fields: [], lastBlocked: null, failed: new Set(), pulling: false, again: false, values: new Map(), writing: new Map(), timers: new Map(), edits: 0, saving: false, controls: new Map(), sig: null };
  go('record');
}

async function pullRecording() {
  const rec = state.rec;
  if (!rec) return;
  if (rec.pulling) {
    rec.again = true;
    return;
  }
  rec.pulling = true;
  const res = await agentCall(rec.tabId, 'recordGet', recArgs(rec));
  rec.pulling = false;
  if (state.rec !== rec) return;
  if (res.ok) rec.fields = res.fields;
  if (rec.fields.length && state.notice && state.notice.text === t('errNoFields')) notice(null);
  if (state.view === 'record') renderRecordList();
  if (rec.again) {
    rec.again = false;
    pullRecording();
  }
}

// Every recording call names its recording, so a late call never reaches a newer one.
const recArgs = (rec, more = {}) => ({ origin: rec.origin, token: rec.token, ...more });

/** Stops this recording (by default the current one) and only it. */
async function stopRecording(rec = state.rec) {
  if (!rec) return;
  if (state.rec === rec) state.rec = null;
  for (const timer of rec.timers.values()) clearTimeout(timer);
  rec.timers.clear();
  await agentCall(rec.tabId, 'recordStop', { token: rec.token });
}

let recList = null;
let recFields = null;
let recBlocked = null;

const recPageValue = (f) => (f.kind === 'checkbox' ? !!f.value : typeof f.value === 'string' ? f.value : '');

// The page and the panel show the same value: what is entered in one goes to the other, and the
// last edit wins. Both sides stamp edits with the time (same machine clock): the agent the person's
// own edits on the page (`edited`), the panel its own (`at`). A panel value the page has not taken
// yet, or refused, is kept as an override until a later edit of that field on the page.
const TEXT_WRITE_DELAY = 200;

const recBusy = (rec, sid) => rec.writing.has(sid) || rec.timers.has(sid);

// Text being typed in the panel is never overwritten; a focused list, radio or box button still updates.
function typingIn(el, focused = document.activeElement) {
  return !!focused && el.contains(focused) && (focused.localName === 'input' || focused.localName === 'textarea');
}

function recOverride(rec, f) {
  const entry = rec.values.get(f.sid);
  if (!entry) return null;
  if ((f.edited || 0) > entry.at) {
    rec.values.delete(f.sid);
    rec.failed.delete(f.sid);
    return null;
  }
  return entry;
}

function recShown(rec, f) {
  const o = recOverride(rec, f);
  return o ? o.value : recPageValue(f);
}

function panelEdit(rec, sid, kind, value) {
  rec.values.set(sid, { value, at: Date.now(), sent: false });
  rec.edits++;
  clearTimeout(rec.timers.get(sid));
  rec.timers.delete(sid);
  // "Page → panel" setting: the panel keeps its own value until the field is edited on the page again.
  if (state.settings.recSync === 'page') return;
  // Lists, radios and boxes go to the page at once; typing waits for a short pause.
  if (kind === 'checkbox' || kind === 'radio' || kind === 'select') writeToPage(rec, sid);
  else rec.timers.set(sid, setTimeout(() => writeToPage(rec, sid), TEXT_WRITE_DELAY));
}

function writeToPage(rec, sid) {
  clearTimeout(rec.timers.get(sid));
  rec.timers.delete(sid);
  // One write per field at a time; the running one sends the newest value when it is done.
  if (rec.writing.has(sid)) return rec.writing.get(sid);
  // Registered before it can finish, and cleaned up only afterwards (finally runs asynchronously).
  const run = sendToPage(rec, sid).finally(() => {
    rec.writing.delete(sid);
    pullRecording();
  });
  rec.writing.set(sid, run);
  return run;
}

async function sendToPage(rec, sid) {
  let entry;
  while (state.rec === rec && (entry = rec.values.get(sid)) && !entry.sent) {
    // This sends the newest value, so a pause timer waiting for it has nothing left to do.
    clearTimeout(rec.timers.get(sid));
    rec.timers.delete(sid);
    entry.sent = true;
    const res = await agentCall(rec.tabId, 'recordSet', recArgs(rec, { sid, value: entry.value, at: entry.at }));
    if (rec.values.get(sid) !== entry) continue;
    if (res.ok || res.error === 'superseded') {
      // The page has it now (perhaps reformatted: the panel then shows the page's version), or the
      // person changed the field on the page after this edit, and the later edit wins.
      rec.values.delete(sid);
      rec.failed.delete(sid);
    } else if (res.error === 'replaced') {
      // The page swapped the element; the new one is not taken over without the person's click.
      rec.values.delete(sid);
      rec.failed.delete(sid);
      const f = rec.fields.find((x) => x.sid === sid);
      notice('error', t('recFieldReplaced', [(f && (f.label || f.locator.name)) || t('unnamedField')]));
    } else if (!(res.error === 'no-option' && entry.value === '')) {
      // "Not set" for a list the page cannot clear is simply kept in the template.
      rec.failed.add(sid);
    }
  }
}

/** Sends pending panel values to the page and waits for them (before saving). */
async function flushWrites(rec) {
  for (const sid of [...rec.timers.keys()]) writeToPage(rec, sid);
  await Promise.all([...rec.writing.values()]);
}

function renderRecordList() {
  if (!recList || !state.rec) return;
  const rec = state.rec;
  // Same fields as last time: update values in place (never the one being edited), so typing on the
  // page or in the panel is not interrupted. Otherwise rebuild and keep the focus where it was.
  const fieldSig = (f) => `${f.kind}|${f.inputType || ''}|${(f.options || []).map((o) => `${o.v}\u0001${o.t}`).join('\u0002')}`;
  const sig = rec.fields.map((f) => `${f.sid}:${fieldSig(f)}`).join('\n');
  if (sig === rec.sig) {
    for (const f of rec.fields) {
      const entry = rec.controls.get(f.sid);
      if (!entry || recBusy(rec, f.sid) || typingIn(entry.ctl.el)) continue;
      entry.ctl.set(recShown(rec, f));
    }
  } else {
    // Remember exactly what had focus (and the caret) to put it back after the rebuild.
    const focused = document.activeElement;
    const caret = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const old = rec.controls;
    clear(recList);
    rec.sig = sig;
    rec.controls = new Map();
    if (recFields) recFields.classList.toggle('is-empty', !rec.fields.length);
    if (!rec.fields.length) recList.append(h('div', { class: 'rec-empty' }, h('span', { class: 'rec-empty-icon' }, icon('pointer', 22)), h('p', { text: t('recEmpty') })));
    else {
      // Numbers match the marks on the page (both in page order).
      recList.append(sketch(rec.fields.map((f, i) => {
        const sid = f.sid;
        const field = { id: `r${sid}`, kind: f.kind, label: f.label || f.locator.name || t('unnamedField'), options: f.options, section: f.section, inputType: f.inputType };
        // An unchanged field keeps its editor (same element, so focus and caret can come back).
        const kept = old.get(sid);
        const reuse = !!kept && kept.sig === fieldSig(f);
        const ctl = reuse ? kept.ctl : makeControl(field, recShown(rec, f), () => panelEdit(rec, sid, f.kind, ctl.get()));
        if (reuse && !recBusy(rec, sid) && !typingIn(ctl.el, focused)) ctl.set(recShown(rec, f));
        rec.controls.set(sid, { ctl, sig: fieldSig(f) });
        return {
          field,
          control: ctl,
          n: i + 1,
          index: sid,
          testid: 'rec-field',
          action: iconBtn('x', `${t('remove')} · ${kindText(f.kind)}`, async () => {
            clearTimeout(rec.timers.get(sid));
            rec.timers.delete(sid);
            rec.values.delete(sid);
            await agentCall(rec.tabId, 'recordRemove', recArgs(rec, { sid }));
            pullRecording();
          }, 'rec-remove'),
        };
      }), { editor: true }));
      if (focused && focused !== document.body && recList.contains(focused) && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
        if (caret) try { focused.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      }
    }
  }
  clear(recBlocked);
  // One note per field whose panel value the page refused, until the page side changes it.
  for (const sid of [...rec.failed]) {
    const f = rec.fields.find((x) => x.sid === sid);
    if (!f || !recOverride(rec, f)) {
      rec.failed.delete(sid);
      continue;
    }
    recBlocked.append(h('div', { class: 'inline-warn', dataset: { testid: 'rec-set-failed' } }, icon('warn'), h('span', { text: t('recSetFailed', [f.label || f.locator.name || t('unnamedField')]) })));
  }
  if (rec.lastBlocked) recBlocked.append(h('div', { class: 'inline-warn', dataset: { testid: 'rec-blocked' } }, icon('shield'), h('span', { text: rec.lastBlocked === 'submit' ? t('recSubmitBlocked') : t('recBlocked', [reasonText(rec.lastBlocked)]) })));
  const count = document.querySelector('[data-testid="rec-count"]');
  if (count) count.textContent = String(rec.fields.length);
}

function renderRecord() {
  const rec = state.rec;
  if (!rec) return go('home');
  recList = h('div', { class: 'rec-list', onFocusout: () => setTimeout(pullRecording, 0) });
  recFields = h('div', { class: 'group rec-fields' }, recList);
  recBlocked = h('div', {});
  rec.sig = null;
  const host = hostOf(rec.origin);
  const nameInput = h('input', { type: 'text', maxLength: LIMITS.name, value: rec.name !== undefined ? rec.name : t('recNameDefault', [host]), dataset: { testid: 'tpl-name' }, onInput: (e) => { rec.name = e.target.value; } });
  const variantInput = h('input', { type: 'text', maxLength: LIMITS.name, value: rec.variantName !== undefined ? rec.variantName : t('firstVariantName'), dataset: { testid: 'variant-name' }, onInput: (e) => { rec.variantName = e.target.value; } });
  mount(
    h('div', { class: 'view-head' }, h('span', { class: 'live' }), h('h1', { class: 'grow' }, h('span', { text: t('recTitle') })), h('span', { class: 'badge', dataset: { testid: 'rec-count' }, text: String(rec.fields.length) })),
    h('p', { class: 'hint', text: t(state.settings.recSync === 'page' ? 'recHelpPage' : 'recHelp') }),
    btn(t('recAddAll'), async () => { const r = await agentCall(rec.tabId, 'recordAddAll', recArgs(rec)); if (!r.ok) notice('error', agentError(r)); pullRecording(); }, { kind: 'secondary block', ico: 'plus', testid: 'rec-add-all' }),
    recBlocked,
    recFields,
    h('div', { class: 'group form' },
      h('label', {}, h('span', { text: t('recName') }), nameInput),
      h('label', {}, h('span', { text: t('recFirstVariant') }), variantInput)),
    h('div', { class: 'actions sticky' },
      btn(t('recSave'), () => saveRecording(nameInput.value, variantInput.value), { kind: 'primary', ico: 'check', testid: 'rec-save' }),
      btn(t('cancel'), async () => { await stopRecording(); go('home'); }, { kind: 'ghost', testid: 'rec-cancel' })),
  );
  renderRecordList();
  pullRecording();
}

async function saveRecording(name, variantName) {
  const rec = state.rec;
  if (!rec || rec.saving) return;
  rec.saving = true;
  try {
    await saveRecordingOf(rec, name, variantName);
  } finally {
    rec.saving = false;
  }
}

async function saveRecordingOf(rec, name, variantName) {
  let res;
  // Values entered while saving still go to the page before the final read (a few rounds at most).
  for (let round = 0; ; round++) {
    const edits = rec.edits;
    await flushWrites(rec);
    if (state.rec !== rec) return;
    res = await agentCall(rec.tabId, 'recordGet', recArgs(rec));
    // Cancelled (or another recording started) meanwhile: nothing is saved.
    if (state.rec !== rec) return;
    if (rec.edits === edits || round >= 2) break;
  }
  if (!res.ok) return notice('error', agentError(res));
  if (!res.fields.length) return notice('error', t('errNoFields'));
  if (res.fields.length > LIMITS.fields) return notice('error', t('errTooManyFields', [String(LIMITS.fields)]));
  const now = Date.now();
  const values = {};
  const fields = res.fields.map((f, i) => {
    const field = { id: `f${i + 1}`, kind: f.kind, label: (f.label || f.locator.name || t('unnamedField')).slice(0, LIMITS.label), locator: f.locator };
    if (f.inputType) field.inputType = f.inputType;
    if (typeof f.section === 'string' && f.section) field.section = f.section.slice(0, LIMITS.label);
    if (f.options) field.options = f.options.map((o) => ({ v: o.v.slice(0, LIMITS.value), t: o.t.slice(0, LIMITS.optionText) }));
    // Normally the page has the panel's value by now; one the page refused is kept from the panel.
    const v = recShown(rec, f);
    if (f.kind === 'checkbox') {
      if (typeof v === 'boolean') values[field.id] = v;
    } else if (typeof v === 'string' && v !== '') values[field.id] = v.slice(0, LIMITS.value);
    return field;
  });
  const tpl = {
    id: store.newId(),
    name: name.trim().slice(0, LIMITS.name) || t('recNameDefault', [hostOf(rec.origin)]),
    origin: rec.origin,
    createdAt: now,
    updatedAt: now,
    fields,
    variants: [{ id: store.newId(), name: variantName.trim().slice(0, LIMITS.name) || t('firstVariantName'), updatedAt: now, values }],
  };
  try {
    await store.saveTemplate(tpl);
  } catch (e) {
    return notice('error', t('errSave', [e.message]));
  }
  await stopRecording(rec);
  await reload();
  if (state.rec) return;
  // Recorded from an empty form: go straight to entering the values of the first variant.
  if (!fields.some((f) => f.kind !== 'checkbox' && hasValue(f, values))) {
    notice('info', t('savedTemplateAddValues', [tpl.name]));
    return go('edit', { templateId: tpl.id, variantId: tpl.variants[0].id, variantQuery: '' });
  }
  notice('info', t('savedTemplate', [tpl.name]));
  go('template', { templateId: tpl.id, variantQuery: '', openVariant: tpl.variants[0].id });
}

// ---------------------------------------------------------------------------------------------
// Template and variants

async function updateTemplate(tpl, mutate) {
  const copy = structuredClone(tpl);
  mutate(copy);
  copy.updatedAt = Date.now();
  try {
    await store.saveTemplate(copy);
  } catch (e) {
    notice('error', t('errSave', [e.message]));
    return null;
  }
  await reload();
  return copy;
}

function renderTemplate() {
  const tpl = currentTemplate();
  if (!tpl) return go('home');
  const site = state.site || {};
  const foreign = site.origin && site.origin !== tpl.origin;
  const originRow = h('p', { class: `origin ${foreign ? 'foreign' : ''}`, title: tpl.origin }, icon(foreign ? 'warn' : 'shield', 13), h('span', { text: t('recordedOn', [tpl.origin]) }));
  const head = h('div', { class: 'view-head' }, iconBtn('back', t('back'), () => go('home'), 'back'), h('div', { class: 'grow' }, h('h1', { text: tpl.name, dataset: { testid: 'tpl-title' } }), originRow));
  const search = h('label', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: t('searchVariants'), value: state.variantQuery, dataset: { testid: 'search-variants' }, onInput: (e) => { state.variantQuery = e.target.value; renderVariants(); } }));
  const list = h('div', { class: 'list variants' });
  const renderVariants = () => {
    clear(list);
    const q = state.variantQuery.trim().toLowerCase();
    const shown = tpl.variants.filter((v) => variantMatches(tpl, v, q));
    if (!tpl.variants.length) list.append(h('p', { class: 'empty', text: t('noVariants') }));
    else if (!shown.length) list.append(h('p', { class: 'empty', text: t('nothingFound') }));
    for (const v of shown) list.append(variantRow(tpl, v));
  };
  renderVariants();
  const tools = h('div', { class: 'toolbar' },
    btn(t('newVariantFromPage'), () => variantFromPage(tpl), { kind: 'secondary small', ico: 'plus', disabled: !site.origin, testid: 'variant-from-page' }),
    btn(t('newVariantEmpty'), () => go('edit', { variantId: null }), { kind: 'small ghost', ico: 'edit', testid: 'variant-new' }));
  const variants = h('div', { class: 'group' }, h('h2', { text: t('variantsLabel', [String(tpl.variants.length)]) }), tpl.variants.length > 3 ? search : null, list, tools);
  // The structure of the form, drawn without values; fields can be removed here.
  const fieldsBox = h('details', { class: 'fields group' }, h('summary', { text: t('fieldsHeading', [String(tpl.fields.length)]) }),
    sketch(tpl.fields.map((f) => ({
      field: f,
      placeholder: kindText(f.kind),
      action: tpl.fields.length > 1 ? iconBtn('trash', t('removeField'), () => updateTemplate(tpl, (c) => {
        c.fields = c.fields.filter((x) => x.id !== f.id);
        for (const v of c.variants) delete v.values[f.id];
      }).then(() => render()), 'field-remove') : null,
    }))));
  const danger = state.confirm === `tpl:${tpl.id}`
    ? h('div', { class: 'confirm' }, h('span', { text: t('confirmDeleteTemplate') }), btn(t('delete'), async () => { await store.deleteTemplate(tpl.id); await reload(); go('home'); }, { kind: 'danger small', testid: 'confirm-delete' }), btn(t('cancel'), () => go('template'), { kind: 'ghost small' }))
    : null;
  const footer = h('div', { class: 'footer' },
    btn(t('rename'), () => renameTemplate(tpl), { kind: 'ghost small', ico: 'edit', testid: 'tpl-rename' }),
    btn(t('exportOne'), () => download(`formditto-${tpl.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40)}-${today()}.json`, buildExport([tpl])), { kind: 'ghost small', ico: 'download', testid: 'tpl-export' }),
    btn(t('deleteTemplate'), () => go('template', { confirm: `tpl:${tpl.id}` }), { kind: 'ghost small danger-text', ico: 'trash', testid: 'tpl-delete' }));
  mount(head, variants, fieldsBox, danger, footer);
}

function variantRow(tpl, v) {
  const confirming = state.confirm === `var:${v.id}`;
  const open = state.openVariant === v.id;
  const row = h('div', { class: `variant${open ? ' open' : ''}`, dataset: { testid: 'variant', name: v.name, vid: v.id } },
    h('div', { class: 'variant-top' },
      // Clicking the name draws the variant as the filled-in form.
      h('button', { type: 'button', class: 'variant-main', title: t('showValues'), aria: { expanded: String(open) }, onClick: () => {
        state.openVariant = open ? null : v.id;
        render();
        const again = $view.querySelector(`[data-vid="${CSS.escape(v.id)}"] .variant-main`);
        if (again) again.focus();
      } },
        h('span', { class: 'variant-name' }, icon('chevron', 14), h('span', { text: v.name })), h('span', { class: 'variant-sum', text: variantSummary(tpl, v) || '—' })),
      // One action per row; the rarer ones live in the opened variant, so names are not cut short.
      btn(t('fillBtn'), () => openPreview(tpl.id, v.id), { kind: 'primary small', ico: 'bolt', testid: 'variant-fill' })),
    open ? h('div', { class: 'variant-tools' },
      btn(t('edit'), () => go('edit', { variantId: v.id }), { kind: 'secondary small', ico: 'edit', testid: 'variant-edit' }),
      btn(t('duplicate'), () => duplicateVariant(tpl, v), { kind: 'ghost small', ico: 'copy', testid: 'variant-duplicate' }),
      btn(t('delete'), () => go('template', { confirm: `var:${v.id}` }), { kind: 'ghost small danger-text', ico: 'trash', testid: 'variant-delete' })) : null,
    open ? sketch(tpl.fields.map((f) => ({ field: f, value: v.values[f.id] }))) : null);
  if (confirming) {
    row.append(h('div', { class: 'confirm' }, h('span', { text: t('confirmDelete') }),
      btn(t('delete'), async () => { await updateTemplate(tpl, (c) => { c.variants = c.variants.filter((x) => x.id !== v.id); }); go('template'); }, { kind: 'danger small', testid: 'confirm-delete' }),
      btn(t('cancel'), () => go('template'), { kind: 'ghost small' })));
  }
  return row;
}

async function duplicateVariant(tpl, v) {
  if (tpl.variants.length >= LIMITS.variants) return notice('error', t('errTooManyVariants', [String(LIMITS.variants)]));
  const copy = { id: store.newId(), name: t('copySuffix', [v.name]).slice(0, LIMITS.name), updatedAt: Date.now(), values: structuredClone(v.values) };
  await updateTemplate(tpl, (c) => {
    const i = c.variants.findIndex((x) => x.id === v.id);
    c.variants.splice(i + 1, 0, copy);
  });
  notice('info', t('duplicated', [copy.name]));
  go('template');
}

async function variantFromPage(tpl) {
  const site = await refreshSite();
  if (!site.origin) {
    render();
    return notice('error', noSiteError(site));
  }
  if (site.origin !== tpl.origin) return notice('error', t('errOtherSite', [tpl.origin]));
  if (tpl.variants.length >= LIMITS.variants) return notice('error', t('errTooManyVariants', [String(LIMITS.variants)]));
  const res = await agentCall(site.tabId, 'capture', { origin: site.origin, fields: fieldsForAgent(tpl) });
  if (!res.ok) return notice('error', agentError(res));
  const values = {};
  for (const f of tpl.fields) {
    const v = res.values[f.id];
    if (f.kind === 'checkbox' && typeof v === 'boolean') values[f.id] = v;
    else if (typeof v === 'string' && v !== '') values[f.id] = v.slice(0, LIMITS.value);
  }
  const variant = { id: store.newId(), name: t('variantN', [String(tpl.variants.length + 1)]), updatedAt: Date.now(), values };
  await updateTemplate(tpl, (c) => c.variants.push(variant));
  go('edit', { variantId: variant.id });
}

function renameTemplate(tpl) {
  const input = h('input', { type: 'text', value: tpl.name, maxLength: LIMITS.name, dataset: { testid: 'rename-input' } });
  const save = async () => {
    const name = input.value.trim();
    if (!name) return;
    await updateTemplate(tpl, (c) => { c.name = name; });
    go('template');
  };
  const title = $view.querySelector('[data-testid="tpl-title"]');
  const box = h('div', { class: 'rename' }, input, btn(t('save'), save, { kind: 'primary small', testid: 'rename-save' }), btn(t('cancel'), () => go('template'), { kind: 'ghost small' }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  title.replaceWith(box);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------------------------
// Variant editor

function renderEdit() {
  const tpl = currentTemplate();
  if (!tpl) return go('home');
  const variant = state.variantId ? byId(tpl.variants, state.variantId) : null;
  const values = variant ? variant.values : {};
  const nameInput = h('input', { type: 'text', maxLength: LIMITS.name, value: variant ? variant.name : t('variantN', [String(tpl.variants.length + 1)]), dataset: { testid: 'variant-name' } });
  const nameBox = h('div', { class: 'group form' }, h('label', {}, h('span', { text: t('variantName') }), nameInput));
  // The same drawing of the form as elsewhere, with real inputs.
  const controls = tpl.fields.map((f) => [f, makeControl(f, values[f.id], undefined, { allowUnset: true })]);
  const form = h('div', { class: 'group' }, sketch(controls.map(([f, control]) => ({ field: f, control })), { editor: true }));
  const save = async () => {
    const out = {};
    for (const [f, ctl] of controls) {
      const v = controlValue(f, ctl);
      if (v !== undefined) out[f.id] = v;
    }
    const name = nameInput.value.trim() || t('variantN', [String(tpl.variants.length + 1)]);
    if (!variant && tpl.variants.length >= LIMITS.variants) return notice('error', t('errTooManyVariants', [String(LIMITS.variants)]));
    const id = variant ? variant.id : store.newId();
    const saved = await updateTemplate(tpl, (c) => {
      const next = { id, name, updatedAt: Date.now(), values: out };
      const i = c.variants.findIndex((x) => x.id === id);
      if (i >= 0) c.variants[i] = next;
      else c.variants.push(next);
    });
    if (saved) {
      notice('info', t('savedVariant', [name]));
      go('template');
    }
  };
  mount(
    h('div', { class: 'view-head' }, iconBtn('back', t('back'), () => go('template'), 'back'), h('h1', { class: 'grow', text: t(variant ? 'editTitle' : 'newVariantTitle') })),
    h('p', { class: 'hint', text: t('leaveEmptyHint') }),
    nameBox,
    form,
    h('div', { class: 'actions sticky' }, btn(t('save'), save, { kind: 'primary', ico: 'check', testid: 'edit-save' }), btn(t('cancel'), () => go('template'), { kind: 'ghost' })),
  );
}

// ---------------------------------------------------------------------------------------------
// Preview → Fill → Undo

async function openPreview(templateId, variantId) {
  notice(null);
  const tpl = byId(state.templates, templateId);
  const variant = tpl && byId(tpl.variants, variantId);
  if (!variant) return;
  const site = await refreshSite();
  if (!site.origin) {
    render();
    return notice('error', noSiteError(site));
  }
  const cmp = compareOrigins(tpl.origin, site.origin);
  // Locators only: variant values stay in the panel until the person confirms the fill.
  const res = await agentCall(site.tabId, 'preview', { origin: site.origin, fields: fieldsForAgent(tpl) });
  if (!res.ok) {
    render();
    return notice('error', agentError(res));
  }
  const byField = new Map(res.rows.map((r) => [r.fieldId, r]));
  const rows = tpl.fields.map((f) => {
    const r = byField.get(f.id) || { status: 'not-found' };
    const want = variant.values[f.id];
    let status;
    if (!hasValue(f, variant.values)) status = 'skipped';
    else if (r.status === 'blocked') status = 'blocked';
    else if (r.status === 'ambiguous') status = 'ambiguous';
    else if (r.status === 'not-found') status = 'waiting';
    else if ((f.kind === 'select' || f.kind === 'radio') && !optionExists(r.options, want)) status = 'option-wait';
    else if (f.kind === 'checkbox' ? r.current === want : r.current === want || (r.options && displayValue(f, want, r.options) === r.currentDisplay && r.currentDisplay !== '')) status = 'unchanged';
    else status = 'ready';
    return {
      field: f,
      status,
      reason: r.reason,
      now: f.kind === 'checkbox' ? displayValue(f, r.current) : r.status === 'ready' || r.status === 'blocked' ? r.currentDisplay || '' : '',
      next: hasValue(f, variant.values) ? displayValue(f, want, r.options) : '',
    };
  });
  state.preview = { tabId: site.tabId, origin: site.origin, url: site.url, templateId, variantId, rows, cmp, ack: false };
  go('preview');
}

const FILLABLE = new Set(['ready', 'waiting', 'option-wait']);

function statusChip(status, reason) {
  const map = { ready: 'ok', unchanged: 'muted', skipped: 'muted', waiting: 'warn', 'option-wait': 'warn', blocked: 'bad', ambiguous: 'bad', filled: 'ok', 'not-found': 'bad', 'no-option': 'bad', failed: 'bad', invalid: 'bad' };
  const key = `st_${status.replace(/-/g, '_')}`;
  const text = status === 'blocked' ? t('st_blocked', [reasonText(reason)]) : t(key);
  return h('span', { class: `chip ${map[status] || 'muted'}`, text, dataset: { status } });
}

function renderPreview() {
  const p = state.preview;
  const tpl = p && byId(state.templates, p.templateId);
  const variant = tpl && byId(tpl.variants, p.variantId);
  if (!variant) return go('home');
  const count = p.rows.filter((r) => FILLABLE.has(r.status)).length;
  const head = h('div', { class: 'view-head' }, iconBtn('back', t('back'), async () => { await agentCall(p.tabId, 'clearHighlights', {}); go('template'); }, 'back'), h('div', { class: 'grow' }, h('h1', { text: t('previewTitle') }), h('p', { class: 'sub', text: `${tpl.name} → ${variant.name}` })));
  let warning = null;
  const fillBtn = btn(p.cmp.same ? t('fillN', [String(count)]) : t('fillAnyway'), doFill, { kind: p.cmp.same ? 'primary' : 'danger', ico: 'bolt', disabled: !count || (!p.cmp.same && !p.ack), testid: 'fill-confirm' });
  if (!p.cmp.same) {
    const ack = h('input', { type: 'checkbox', checked: p.ack, dataset: { testid: 'mismatch-ack' }, onChange: (e) => { p.ack = e.target.checked; fillBtn.disabled = !count || !p.ack; } });
    warning = h('div', { class: 'danger-box', role: 'alert', dataset: { testid: 'origin-warning' } },
      h('strong', {}, icon('warn'), h('span', { text: t('mismatchTitle') })),
      h('dl', {}, h('dt', { text: t('mismatchTemplateSite') }), h('dd', { text: tpl.origin }), h('dt', { text: t('mismatchThisPage') }), h('dd', { text: p.origin, dataset: { testid: 'mismatch-page-origin' } })),
      p.cmp.lookalike ? h('p', { class: 'strong', text: t(p.cmp.lookalike === 'punycode' ? 'lookalikePunycode' : 'lookalikeSimilar') }) : null,
      p.cmp.downgrade ? h('p', { class: 'strong', text: t('downgradeWarn') }) : null,
      h('p', { text: t('mismatchBody') }),
      h('label', { class: 'ack' }, ack, h('span', { text: t('mismatchAck') })));
  }
  // Rows are numbered like the marks the agent draws on the page. What the fill changes (or cannot
  // do) comes first; fields it leaves as they are wait behind one line, open on request.
  const rows = p.rows.map((r, i) => ({ ...r, n: i + 1 }));
  const quiet = (r) => r.status === 'unchanged' || r.status === 'skipped';
  const rowList = (list) => bySection(list, (r) => r.field).map((g) => h('div', {}, g.section ? h('div', { class: 'sk-title', text: g.section }) : null,
    h('div', { class: 'prow-list' }, g.rows.map((r) => h('div', { class: `prow ${r.status}`, dataset: { testid: 'preview-row', status: r.status } },
      h('span', { class: 'sk-n', text: String(r.n) }),
      h('div', { class: 'prow-label', text: r.field.label }),
      h('div', { class: 'prow-values' }, h('span', { class: 'now', text: r.now || '—' }), h('span', { class: 'arrow', text: '→' }), h('span', { class: 'next', text: r.next || '—' })),
      statusChip(r.status, r.reason))))));
  const main = rows.filter((r) => !quiet(r));
  const rest = rows.filter(quiet);
  const table = h('div', { class: 'preview-table group', dataset: { testid: 'preview-table' } }, rowList(main));
  if (rest.length) {
    table.append(h('details', { class: 'prow-more', open: !main.length, dataset: { testid: 'preview-unchanged' } },
      h('summary', { text: t('previewUnchanged', [String(rest.length)]) }), rowList(rest)));
  }
  mount(head, warning, table, h('p', { class: 'hint', text: t('noSubmitNote') }), h('div', { class: 'actions sticky' }, fillBtn, btn(t('cancel'), async () => { await agentCall(p.tabId, 'clearHighlights', {}); go('template'); }, { kind: 'ghost' })));
}

async function doFill() {
  const p = state.preview;
  const tpl = p && byId(state.templates, p.templateId);
  const variant = tpl && byId(tpl.variants, p.variantId);
  if (!variant) return;
  if (!p.cmp.same && !p.ack) return;
  // The tab must still show the page that was previewed.
  const site = await refreshSite();
  if (site.tabId !== p.tabId || site.origin !== p.origin || site.url !== p.url) {
    state.preview = null;
    go('template');
    return notice('error', t('errPageChanged'));
  }
  setBusy(true);
  notice('info', t('fillingProgress'));
  const res = await agentCall(p.tabId, 'fill', { origin: p.origin, url: p.url, fields: fieldsForAgent(tpl), values: variant.values, timeoutMs: state.settings.waitTimeoutMs });
  setBusy(false);
  notice(null);
  if (!res.ok) {
    go('template');
    return notice('error', agentError(res));
  }
  state.result = { tabId: p.tabId, origin: p.origin, templateId: tpl.id, variantId: variant.id, fillId: res.fillId, report: res.report, canUndo: res.canUndo, undone: false };
  go('result');
}

function renderResult() {
  const r = state.result;
  const tpl = r && byId(state.templates, r.templateId);
  if (!tpl) return go('home');
  const variant = byId(tpl.variants, r.variantId);
  const counts = { filled: 0, unchanged: 0, problems: 0 };
  for (const x of r.report) {
    if (x.status === 'filled') counts.filled++;
    else if (x.status === 'unchanged') counts.unchanged++;
    else if (x.status !== 'skipped') counts.problems++;
  }
  const problems = r.report.filter((x) => !['filled', 'unchanged', 'skipped'].includes(x.status));
  const list = h('div', { class: 'group prow-list' });
  for (const x of problems) {
    const i = tpl.fields.findIndex((fl) => fl.id === x.fieldId);
    list.append(h('div', { class: `prow ${x.status}`, dataset: { testid: 'result-problem' } },
      h('span', { class: 'sk-n', text: String(i + 1) }),
      h('div', { class: 'prow-label', text: i >= 0 ? tpl.fields[i].label : x.fieldId }),
      statusChip(x.status, x.reason)));
  }
  const undo = async () => {
    const res = await agentCall(r.tabId, 'undo', { origin: r.origin, fillId: r.fillId });
    if (!res.ok) return notice('error', agentError(res));
    r.undone = true;
    notice('info', t('undone', [String(res.restored)]));
    go('result');
  };
  mount(
    h('div', { class: 'view-head' }, h('span', { class: 'result-icon' }, icon(r.undone ? 'undo' : 'check')), h('h1', { class: 'grow' }, h('span', { text: r.undone ? t('undoneTitle') : t('resultTitle') }))),
    h('p', { class: 'sub', text: `${tpl.name} → ${variant ? variant.name : ''}` }),
    h('div', { class: 'stats', dataset: { testid: 'result-stats' } },
      h('div', { class: 'stat ok' }, h('b', { text: String(counts.filled), dataset: { testid: 'stat-filled' } }), h('span', { text: t('resultFilled') })),
      h('div', { class: 'stat' }, h('b', { text: String(counts.unchanged) }), h('span', { text: t('resultUnchanged') })),
      h('div', { class: `stat ${counts.problems ? 'bad' : ''}` }, h('b', { text: String(counts.problems), dataset: { testid: 'stat-problems' } }), h('span', { text: t('resultProblems') }))),
    problems.length ? list : null,
    h('p', { class: 'hint strong', text: t('reviewNote') }),
    h('div', { class: 'actions' },
      !r.undone && r.canUndo ? btn(t('undo'), undo, { kind: 'secondary', ico: 'undo', testid: 'undo' }) : null,
      btn(t('done'), async () => { await agentCall(r.tabId, 'clearHighlights', {}); state.result = null; go('template'); }, { kind: 'primary', testid: 'done' })),
  );
}

// ---------------------------------------------------------------------------------------------
// Import / export

async function exportAll() {
  download(`formditto-templates-${today()}.json`, buildExport(state.templates));
}

$importFile.addEventListener('change', async () => {
  const file = $importFile.files && $importFile.files[0];
  $importFile.value = '';
  if (!file) return;
  if (file.size > LIMITS.importBytes) return notice('error', t('errTooLarge'));
  const text = await file.text();
  const res = parseImport(text, file.size);
  if (!res.ok) {
    const msg = res.error === 'too-large' ? t('errTooLarge') : res.error === 'not-json' ? t('errNotJson') : t('errSchema', [res.detail || '']);
    return notice('error', msg);
  }
  if (!store.canAddTemplates(state.templates.length, res.templates.length)) return notice('error', t('errLimit', [String(LIMITS.templatesTotal)]));
  notice(null);
  go('import', { importDraft: res.templates });
});

function renderImport() {
  const draft = state.importDraft;
  if (!draft) return go('home');
  const list = h('div', { class: 'list' });
  for (const tp of draft) {
    list.append(h('div', { class: 'card static', dataset: { testid: 'import-item' } }, h('span', { class: 'card-title', text: tp.name }), h('span', { class: 'card-origin', text: tp.origin }), h('span', { class: 'card-meta', text: `${t('fieldsLabel', [String(tp.fields.length)])} · ${t('variantsLabel', [String(tp.variants.length)])}` })));
  }
  const confirm = async () => {
    const existing = new Set(state.templates.map((x) => x.id));
    const now = Date.now();
    const incoming = draft.map((tp) => (existing.has(tp.id) ? { ...tp, id: store.newId(), name: t('importedSuffix', [tp.name]).slice(0, LIMITS.name), updatedAt: now } : tp));
    try {
      await store.saveTemplates(incoming);
    } catch (e) {
      return notice('error', t('errSave', [e.message]));
    }
    await reload();
    state.importDraft = null;
    notice('info', t('importDone', [String(incoming.length)]));
    go('home');
  };
  mount(
    h('div', { class: 'view-head' }, iconBtn('back', t('back'), () => go('home', { importDraft: null }), 'back'), h('h1', { class: 'grow', text: t('importTitle') })),
    h('p', { text: t('importSummary', [String(draft.length)]) }),
    list,
    h('p', { class: 'hint', text: t('importNote') }),
    h('div', { class: 'actions' }, btn(t('importConfirm'), confirm, { kind: 'primary', ico: 'check', testid: 'import-confirm' }), btn(t('cancel'), () => go('home', { importDraft: null }), { kind: 'ghost' })),
  );
}

// ---------------------------------------------------------------------------------------------
// Settings

const WAIT_PRESETS = [2, 5, 10, 20, 30];

/** "As in browser (…)" plus every bundled language in its own name. */
function languageList() {
  return [{ value: 'auto', label: t('langAuto', [languageName(resolveLanguage('auto'))]) }, ...LANGUAGES.map(([code, name]) => ({ value: code, label: name }))];
}

/** Puts focus back on the control with the same test id (and value) after a re-render. */
function refocus(before) {
  const testid = before && before.closest && before.closest('[data-testid]') ? before.closest('[data-testid]').dataset.testid : null;
  if (!testid) return;
  const value = before.dataset ? before.dataset.value : undefined;
  const scope = document.querySelector(`[data-testid="${CSS.escape(testid)}"]`);
  if (!scope) return;
  const target = value !== undefined ? scope.querySelector(`[data-value="${CSS.escape(value)}"]`) : scope;
  if (target) target.focus({ preventScroll: true });
}

async function changeLanguage(choice) {
  const before = document.activeElement;
  state.settings = await store.saveSettings({ ...state.settings, language: choice });
  applyLanguage();
  // Views with unsaved input keep their content (and switch language on the next screen).
  if (state.view === 'edit' || state.view === 'record') {
    renderSite();
    renderNotice();
  } else {
    render();
  }
  refocus(before);
}

// What the panel currently shows, so storage events for our own changes do not rebuild it twice.
let shownLanguage = null;
let shownTheme = null;

function applyLanguage() {
  shownLanguage = state.settings.language;
  setLanguage(state.settings.language);
  applyI18n();
  applyTheme();
}

const effectiveTheme = () => (state.settings.theme === 'light' || state.settings.theme === 'dark' ? state.settings.theme : darkQuery.matches ? 'dark' : 'light');

function applyTheme() {
  shownTheme = state.settings.theme;
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  const b = document.getElementById('themeBtn');
  clear(b);
  b.append(icon(theme === 'dark' ? 'sun' : 'moon', 17));
  b.title = t('themeToggle');
  b.setAttribute('aria-label', t('themeToggle'));
}

async function setTheme(theme) {
  const before = document.activeElement;
  state.settings = { ...state.settings, theme };
  await switchTheme(() => {
    applyTheme();
    if (state.view === 'settings' && settingsTheme && settingsTheme.el.isConnected) settingsTheme.set(theme);
  });
  refocus(before);
  state.settings = await store.saveSettings(state.settings);
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Changes the theme in one step: element transitions are off meanwhile (otherwise every element eases
 * its colours at its own speed), and the whole panel cross-fades once on the compositor.
 */
async function switchTheme(update) {
  const root = document.documentElement;
  root.classList.add('theme-switch');
  const done = () => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switch')));
  if (document.startViewTransition && !reduceMotion.matches && document.visibilityState === 'visible') {
    const vt = document.startViewTransition(update);
    vt.finished.then(done, done);
    await vt.updateCallbackDone.catch(() => {});
    return;
  }
  update();
  done();
}

/**
 * Arrow keys move between the buttons of a radio group and pick the one they land on; only the
 * current one is in the tab order (the ARIA radio-group pattern).
 */
function roving(buttons, pick) {
  buttons.forEach((b, i) => b.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    pick(next);
  }));
}

/**
 * A pill that slides behind the chosen button of a group (as in Convertly). It is put in place without
 * animation whenever the group changes size (first layout, wrapping) and slides when the choice changes.
 */
function slidingPill(group) {
  const pill = h('span', { class: 'seg-pill no-anim', aria: { hidden: 'true' } });
  group.prepend(pill);
  group.classList.add('sliding');
  const place = (animate) => {
    const on = group.querySelector(':scope > .on');
    pill.classList.toggle('no-anim', !animate);
    pill.classList.toggle('off', !on);
    if (!on || !group.isConnected) return;
    pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.height = `${on.offsetHeight}px`;
  };
  new ResizeObserver(() => place(false)).observe(group);
  return place;
}

/** A segmented radio group; `set` changes the choice in place (the pill slides). */
function segmented(choices, current, onPick, label, testid) {
  const seg = h('div', { class: 'seg', role: 'radiogroup', aria: { label }, dataset: testid ? { testid } : undefined });
  const buttons = choices.map(([value, text]) => h('button', { type: 'button', role: 'radio', dataset: { value: String(value) }, text, onClick: () => {
    set(value);
    onPick(value);
  } }));
  append(seg, buttons);
  const place = slidingPill(seg);
  function set(value, animate = true) {
    for (const b of buttons) {
      const on = b.dataset.value === String(value);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!buttons.some((b) => b.tabIndex === 0)) buttons[0].tabIndex = 0;
    place(animate);
  }
  set(current, false);
  roving(buttons, (b) => b.click());
  return { el: seg, set };
}

// Settings open over whatever is on screen, and "back" returns to it: a recording keeps going, and a
// variant being edited comes back exactly as it was left (its unsaved input lives only in the DOM).
let underSettings = null;

function openSettings() {
  underSettings = { view: state.view, scroll: window.scrollY, nodes: state.view === 'edit' ? [...$view.childNodes] : null };
  go('settings');
}

function closeSettings() {
  const under = underSettings || { view: 'home' };
  underSettings = null;
  if (under.nodes && currentTemplate()) {
    state.view = under.view;
    renderSite();
    renderNotice();
    clear($view);
    $view.append(...under.nodes);
    document.body.classList.toggle('with-actions', !!$view.querySelector('.actions.sticky'));
    window.scrollTo(0, under.scroll);
    return;
  }
  const back = { record: state.rec ? 'record' : 'home', home: 'home', template: state.templateId && currentTemplate() ? 'template' : 'home' };
  const view = back[under.view] || (state.templateId && currentTemplate() ? 'template' : 'home');
  go(view);
  if (view === under.view) window.scrollTo(0, under.scroll);
}

// The theme control of the open settings, so the top-bar button can move its pill too.
let settingsTheme = null;

async function saveSetting(patch) {
  state.settings = await store.saveSettings({ ...state.settings, ...patch });
  notice('info', t('settingsSaved'));
}

function renderSettings() {
  const wait = segmented(WAIT_PRESETS.map((n) => [n, t('secondsShort', [String(n)])]), Math.round(state.settings.waitTimeoutMs / 1000), (n) => saveSetting({ waitTimeoutMs: n * 1000 }), t('waitLabel'), 'wait-seconds');
  const theme = segmented([['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')]], state.settings.theme || 'auto', (v) => setTheme(v), t('themeLabel'), 'theme');
  settingsTheme = theme;
  const sync = segmented([['both', t('syncBoth')], ['page', t('syncPage')]], state.settings.recSync || 'both', (v) => saveSetting({ recSync: v }), t('syncLabel'), 'rec-sync');
  const lang = dropdown({ options: languageList(), value: state.settings.language || 'auto', label: t('langLabel'), testid: 'language', onChange: (v) => changeLanguage(v) });
  const sites = h('div', { class: 'list' });
  chrome.permissions.getAll().then(({ origins = [] }) => {
    clear(sites);
    if (!origins.length) sites.append(h('p', { class: 'empty', text: t('noSites') }));
    for (const o of origins) {
      sites.append(h('div', { class: 'field-row', dataset: { testid: 'site-access' } }, h('span', { class: 'grow', text: o }),
        btn(t('removeAccess'), async () => { await chrome.permissions.remove({ origins: [o] }).catch(() => false); await refreshSite(); render(); }, { kind: 'ghost small danger-text' })));
    }
  });
  mount(
    h('div', { class: 'view-head' }, iconBtn('back', t('back'), closeSettings, 'back'), h('h1', { class: 'grow', text: t('settingsTitle') })),
    h('div', { class: 'group' },
      h('h2', { text: t('generalHeading') }),
      h('div', { class: 'setting' }, h('span', { class: 'setting-label', text: t('langLabel') }), lang.el),
      h('div', { class: 'setting stack' }, h('span', { class: 'setting-label', text: t('themeLabel') }), theme.el),
      h('div', { class: 'setting stack' }, h('span', { class: 'setting-label', text: t('syncLabel') }), sync.el, h('p', { class: 'hint', text: t('syncHelp') })),
      h('div', { class: 'setting stack' }, h('span', { class: 'setting-label', text: t('waitLabel') }), wait.el, h('p', { class: 'hint', text: t('waitHelp') }))),
    h('div', { class: 'group' }, h('h2', { text: t('sitesHeading') }), sites),
    h('div', { class: 'group' }, h('h2', { text: t('privacyHeading') }), h('p', { class: 'privacy', text: t('privacyText') })),
    h('p', { class: 'version', text: t('versionLabel', [chrome.runtime.getManifest().version]) }),
  );
}

// ---------------------------------------------------------------------------------------------
// Events and start-up

async function reload() {
  const data = await store.loadAll();
  state.templates = data.templates;
  state.settings = data.settings;
}

let pullTimer = 0;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (isActionClicked(msg)) {
    if (isFromServiceWorker(sender, RUNTIME_ID, SW_URL)) onTabsChanged();
    return;
  }
  if (msg && msg.type === 'ff:rec') {
    const session = state.rec;
    if (!session || !isRecordingSender(sender, RUNTIME_ID, session)) return;
    const ping = parseRecPing(msg, session);
    if (!ping) return;
    if (ping.event === 'ping') {
      sendResponse(true);
      return;
    }
    if (ping.event === 'blocked') session.lastBlocked = ping.reason;
    // A refresh (the page re-rendered fields) keeps the note about the person's last refused click.
    else if (ping.event === 'changed') session.lastBlocked = null;
    clearTimeout(pullTimer);
    pullTimer = setTimeout(pullRecording, 60);
  }
});

async function onTabsChanged() {
  const before = state.site;
  await refreshSite();
  const s = state.site;
  const moved = !before || before.tabId !== s.tabId || before.origin !== s.origin || before.url !== s.url;
  if (state.rec && (s.tabId !== state.rec.tabId || s.origin !== state.rec.origin)) {
    stopRecording(state.rec);
    if (state.view !== 'settings') state.view = 'home';
    notice('error', t('recCancelledNav'));
  }
  if (moved && (state.view === 'preview' || state.view === 'result')) {
    state.preview = null;
    state.result = null;
    state.view = state.templateId ? 'template' : 'home';
  }
  if (state.view !== 'edit' && state.view !== 'record') render();
  else renderSite();
}

chrome.tabs.onActivated.addListener(() => {
  if (TAB_OVERRIDE === null) onTabsChanged();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (state.site && tabId === state.site.tabId && (info.status === 'complete' || info.url)) {
    if (state.rec && info.status === 'loading') return;
    onTabsChanged();
  }
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await reload();
  // Only changes made elsewhere (another panel window): our own were applied already.
  if (state.settings.theme !== shownTheme) {
    switchTheme(applyTheme);
    if (state.view === 'settings' && settingsTheme && settingsTheme.el.isConnected) settingsTheme.set(state.settings.theme || 'auto');
  }
  if (state.settings.language !== shownLanguage) {
    applyLanguage();
    if (state.view !== 'edit' && state.view !== 'record') render();
    return;
  }
  if (state.view === 'home' || state.view === 'template') render();
});

document.getElementById('settingsBtn').append(icon('gear', 18));
document.getElementById('settingsBtn').addEventListener('click', () => (state.view === 'settings' ? closeSettings() : openSettings()));

document.getElementById('themeBtn').addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
darkQuery.addEventListener('change', () => switchTheme(applyTheme));
// A hairline under the top bar once the content scrolls beneath it.
window.addEventListener('scroll', () => document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });

async function init() {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  await reload();
  applyLanguage();
  await refreshSite();
  render();
  document.body.dataset.ready = '1';
}

init();
