// FormDitto page agent.
//
// Injected on demand by the side panel into the top frame of the active tab (isolated world, so the
// page's own scripts cannot see or call it). It walks the document, open shadow roots and iframes of
// the same origin; it never submits forms, never presses keys and never touches password, payment or
// invisible fields. The panel calls it via chrome.scripting.executeScript:
//   globalThis.__formditto.call(method, args)
// Template values are passed in as arguments only for the duration of a fill.

(() => {
  'use strict';
  // After an extension update the agent of the previous version can stay in an open tab with its
  // extension context gone. It is replaced; a live agent is reused.
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  const prior = globalThis.__formditto;
  if (prior) {
    if (typeof prior.alive !== 'function' || prior.alive()) return;
    try {
      prior.retire();
    } catch {
      /* already gone */
    }
  }

  const AGENT_VERSION = 1;
  const MIN_SIZE = 4;
  const MIN_SCORE = 5;
  const MAX_SCOPE_DEPTH = 6;
  const MAX_OPTIONS = 300;
  const OVERLAY_TAG = 'formditto-overlay';

  const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'search']);
  const DATE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
  // Kept byte-for-byte identical to lib/schema.js (checked by test/unit/static-audit.test.js).
  const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;
  const SENSITIVE_PASSWORD = /(pass(word|wd|code)|(?<![a-z])pwd(?![a-z])|парол|one.?time.?(code|password)|(?<![a-z])otp(?![a-z]))/i;
  const SENSITIVE_PAYMENT = /((?<![a-z])(cvv2?|cvc2?|csc|cvn)(?![a-z])|card.?(number|num|no)(?![a-z])|(?<![a-z])cc.?(number|num)|номер.?карт|security.?code)/i;

  // ---------------------------------------------------------------------------------------------
  // Field classification

  const viewOf = (node) => (node.ownerDocument || node).defaultView;

  function inputType(el) {
    return String(el.type || 'text').toLowerCase();
  }

  function fieldKind(el) {
    if (!el || el.nodeType !== 1) return null;
    switch (el.localName) {
      case 'textarea':
        return 'textarea';
      case 'select':
        return el.multiple ? null : 'select';
      case 'input': {
        const t = inputType(el);
        if (TEXT_TYPES.has(t)) return 'text';
        if (DATE_TYPES.has(t)) return 'date';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return null;
      }
      default:
        return null;
    }
  }

  function clean(s, max = 200) {
    return String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s:*]+$/, '').slice(0, max);
  }
  const norm = (s) => clean(s).toLowerCase();

  // Text of a node without the text of form controls inside it (no cloning: cloning could run
  // custom element constructors of the page).
  function ownText(node) {
    let out = '';
    const walk = (n, depth) => {
      if (depth > 12) return;
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeType === 1 && !/^(input|select|textarea|button|script|style|option|optgroup|datalist|template)$/.test(c.localName)) walk(c, depth + 1);
        if (out.length > 400) return;
      }
    };
    walk(node, 0);
    return out;
  }

  function sectionOf(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.localName === 'fieldset') {
        const legend = Array.from(n.children).find((c) => c.localName === 'legend');
        const text = legend ? clean(ownText(legend), 120) : '';
        if (text) return text;
      }
    }
    const root = el.getRootNode();
    const doc = el.ownerDocument;
    if (!doc || !root) return '';
    const walker = doc.createTreeWalker(root, 1);
    walker.currentNode = el;
    for (let steps = 0; steps < 800; steps++) {
      const n = walker.previousNode();
      if (!n) break;
      if (/^h[2-6]$/.test(n.localName) || n.getAttribute('role') === 'heading') {
        const text = clean(ownText(n), 120);
        if (text) return text;
      }
    }
    return '';
  }

  function labelOf(el) {
    const root = el.getRootNode();
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (ids.length && root.getElementById) {
      const text = clean(ids.map((id) => { const n = root.getElementById(id); return n ? ownText(n) : ''; }).join(' '));
      if (text) return text;
    }
    if (el.labels && el.labels.length) {
      const text = clean(ownText(el.labels[0]));
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const cell = el.closest('td, th');
    if (cell && cell.previousElementSibling) {
      const text = clean(ownText(cell.previousElementSibling));
      if (text && text.length <= 80) return text;
    }
    const prev = el.previousElementSibling;
    if (prev && !fieldKind(prev) && prev.localName !== 'br') {
      const text = clean(ownText(prev));
      if (text && text.length <= 80) return text;
    }
    return rowLabelOf(el, 1) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name') || el.id || '');
  }

  const countFields = (n) => n.querySelectorAll('input:not([type="hidden"]), select, textarea').length;

  /**
   * Grid layouts (Bootstrap rows and the like) put the label in the previous column of the same row,
   * not linked to the field. Climb the wrappers of this field (or radio group) and take the text of the
   * column before it, but only while the row holds nothing but this field.
   */
  function rowLabelOf(el, size) {
    let node = el;
    for (let depth = 0; depth < 4 && node.parentElement; depth++) {
      const parent = node.parentElement;
      if (countFields(parent) > size) break;
      const prev = parent.previousElementSibling;
      if (prev && parent.parentElement && countFields(parent.parentElement) <= size && !countFields(prev)) {
        const text = clean(ownText(prev));
        if (text && text.length <= 80) return text;
      }
      node = parent;
    }
    return '';
  }

  function radioGroup(radio) {
    if (!radio.name) return [radio];
    const root = radio.getRootNode();
    return Array.from(root.querySelectorAll('input[type="radio"]')).filter(
      (r) => inputType(r) === 'radio' && r.name === radio.name && r.form === radio.form,
    );
  }

  function groupLabelOf(radio) {
    const group = radio.closest('[role="radiogroup"]');
    if (group) {
      const ids = (group.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      const root = group.getRootNode();
      const byId = clean(ids.map((id) => { const n = root.getElementById ? root.getElementById(id) : null; return n ? ownText(n) : ''; }).join(' '));
      if (byId) return byId;
      const aria = clean(group.getAttribute('aria-label'));
      if (aria) return aria;
    }
    const fieldset = radio.closest('fieldset');
    const legend = fieldset && fieldset.querySelector('legend');
    if (legend) {
      const text = clean(ownText(legend));
      if (text) return text;
    }
    const cell = radio.closest('td, th');
    if (cell && cell.previousElementSibling) {
      const text = clean(ownText(cell.previousElementSibling));
      if (text && text.length <= 80) return text;
    }
    return rowLabelOf(radio, radioGroup(radio).length) || clean(radio.name) || labelOf(radio);
  }

  function radioValue(r) {
    const v = r.getAttribute('value');
    return v !== null && v !== 'on' ? v : clean(labelOf(r));
  }

  function sensitiveReason(el, label) {
    if (el.localName === 'input') {
      const declared = String(el.getAttribute('type') || '').toLowerCase();
      if (inputType(el) === 'password' || declared === 'password') return 'password';
    }
    const ac = String(el.getAttribute('autocomplete') || '');
    if (SENSITIVE_AUTOCOMPLETE.test(ac)) return /cc-/i.test(ac) ? 'payment' : (/one-time-code/i.test(ac) ? 'otp' : 'password');
    const hay = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), label].filter(Boolean).join(' ');
    if (SENSITIVE_PAYMENT.test(hay)) return 'payment';
    if (SENSITIVE_PASSWORD.test(hay)) return 'password';
    return null;
  }

  // Parent across shadow roots (to the host) and same-origin frames (to the <iframe>).
  function parentAcross(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    if (root && root.host) return root.host;
    try {
      const win = viewOf(node);
      if (win && win.frameElement) return win.frameElement;
    } catch {
      /* cross-origin parent: stop */
    }
    return null;
  }

  function isClippedStyle(cs) {
    if ((cs.position === 'absolute' || cs.position === 'fixed') && cs.clip && cs.clip.startsWith('rect(')) {
      const n = cs.clip.match(/-?[\d.]+/g);
      if (n && n.length === 4) {
        const [top, right, bottom, left] = n.map(Number);
        if (right - left < MIN_SIZE || bottom - top < MIN_SIZE) return true;
      }
    }
    const cp = cs.clipPath || '';
    if (/inset\(\s*(4[5-9]|[5-9]\d|100)(\.\d+)?%/.test(cp) || /circle\(\s*0(px|%)?\s*[ )a]/.test(cp)) return true;
    return false;
  }

  /** Why a field is not visible to a person, or null. Checks the element and all its ancestors. */
  function hiddenReason(el, kind) {
    if (!el.isConnected) return 'detached';
    if (el.localName === 'input' && inputType(el) === 'hidden') return 'hidden-type';
    if (el.getClientRects().length === 0) return 'not-rendered';
    // Catches display:none ancestors and skipped content (content-visibility:hidden, closed <details>).
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return 'not-rendered';
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return 'too-small';
    const ownStyle = viewOf(el).getComputedStyle(el);
    if (ownStyle.visibility !== 'visible') return 'invisible';
    if (isClippedStyle(ownStyle)) return 'clipped';
    if (el.hasAttribute('inert')) return 'inert';
    if (el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    // Custom checkboxes/radios often hide the native input with opacity:0 over a styled proxy.
    let opacity = kind === 'checkbox' || kind === 'radio' ? 1 : parseFloat(ownStyle.opacity);
    if (opacity < 0.1) return 'transparent';
    let vis = { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
    let fixed = ownStyle.position === 'fixed';
    let doc = el.ownerDocument;
    let node = el;
    while ((node = parentAcross(node))) {
      const s = viewOf(node).getComputedStyle(node);
      if (node.hasAttribute('inert')) return 'inert';
      if (node.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
      opacity *= parseFloat(s.opacity);
      if (opacity < 0.1) return 'transparent';
      if (isClippedStyle(s)) return 'clipped';
      if (s.position === 'fixed' && node.ownerDocument === document) fixed = true;
      if (node.ownerDocument !== doc) {
        // Crossed from a frame into its <iframe> element: move to the parent frame's coordinates.
        if (s.visibility !== 'visible' || node.getClientRects().length === 0) return 'invisible';
        const fr = node.getBoundingClientRect();
        const ox = fr.left + node.clientLeft;
        const oy = fr.top + node.clientTop;
        vis = { l: vis.l + ox, t: vis.t + oy, r: vis.r + ox, b: vis.b + oy };
        vis = { l: Math.max(vis.l, ox), t: Math.max(vis.t, oy), r: Math.min(vis.r, ox + node.clientWidth), b: Math.min(vis.b, oy + node.clientHeight) };
        doc = node.ownerDocument;
      } else if (node !== doc.documentElement && node !== doc.body) {
        const ox = s.overflowX;
        const oy = s.overflowY;
        const clipX = ox === 'hidden' || ox === 'clip' || ((ox === 'auto' || ox === 'scroll') && node.clientWidth < MIN_SIZE);
        const clipY = oy === 'hidden' || oy === 'clip' || ((oy === 'auto' || oy === 'scroll') && node.clientHeight < MIN_SIZE);
        if (clipX || clipY) {
          const nr = node.getBoundingClientRect();
          const l = nr.left + node.clientLeft;
          const t = nr.top + node.clientTop;
          if (clipX) vis = { ...vis, l: Math.max(vis.l, l), r: Math.min(vis.r, l + node.clientWidth) };
          if (clipY) vis = { ...vis, t: Math.max(vis.t, t), b: Math.min(vis.b, t + node.clientHeight) };
        }
      }
      if (vis.r - vis.l < MIN_SIZE || vis.b - vis.t < MIN_SIZE) return 'clipped';
    }
    // Outside the top document where scrolling can never bring it into view (fixed elements do
    // not move with scrolling at all).
    const de = document.documentElement;
    const sx = fixed ? 0 : window.scrollX;
    const sy = fixed ? 0 : window.scrollY;
    const maxX = fixed ? window.innerWidth : Math.max(de.scrollWidth, window.innerWidth);
    const maxY = fixed ? window.innerHeight : Math.max(de.scrollHeight, window.innerHeight);
    if (vis.r + sx <= 0 || vis.b + sy <= 0) return 'offscreen';
    if (vis.l + sx >= maxX || vis.t + sy >= maxY) return 'offscreen';
    return null;
  }

  function stateReason(el, kind) {
    if (el.disabled || el.matches(':disabled')) return 'disabled';
    if ((kind === 'text' || kind === 'textarea' || kind === 'date') && el.readOnly) return 'readonly';
    return null;
  }

  /** Reason a field must not be recorded or filled, or null. */
  function blockReason(el, kind, label) {
    return sensitiveReason(el, label) || hiddenReason(el, kind) || stateReason(el, kind);
  }

  // ---------------------------------------------------------------------------------------------
  // Selectors and page enumeration

  function looksGenerated(id) {
    return /^[:«]|^(ember|ext-gen|gwt-|mui-|radix-|headlessui-|react-select-|uid-|j_id)|\d{4,}|[0-9a-f]{8,}/i.test(id);
  }

  function uniqueIn(root, sel, el) {
    try {
      const m = root.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch {
      return false;
    }
  }

  function selectorFor(el, root) {
    const tag = el.localName;
    if (el.id && !looksGenerated(el.id)) {
      const s = `#${CSS.escape(el.id)}`;
      if (uniqueIn(root, s, el)) return s;
    }
    const name = el.getAttribute('name');
    if (name) {
      let s = `${tag}[name="${CSS.escape(name)}"]`;
      if (uniqueIn(root, s, el)) return s;
      const value = el.getAttribute('value');
      if (value !== null && tag === 'input') {
        s += `[value="${CSS.escape(value)}"]`;
        if (uniqueIn(root, s, el)) return s;
      }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node !== el && node.id && !looksGenerated(node.id) && uniqueIn(root, `#${CSS.escape(node.id)}`, node)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children) : Array.from(node.parentNode ? node.parentNode.children : []);
      const same = siblings.filter((c) => c.localName === node.localName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
      if (!parent) break;
      node = parent;
    }
    return parts.join(' > ').slice(0, 500);
  }

  const scopeKey = (scope) => scope.map((s) => `${s.t}:${s.sel}`).join('|');

  /** Documents and open shadow roots of the page (same origin only), with their scope path. */
  function collectRoots(origin) {
    const out = [];
    const visit = (root, scope) => {
      out.push({ root, scope });
      if (scope.length >= MAX_SCOPE_DEPTH) return;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot, scope.concat({ t: 'shadow', sel: selectorFor(el, root) }));
        if (el.localName === 'iframe' || el.localName === 'frame') {
          let doc = null;
          try {
            doc = el.contentDocument;
            if (doc && (!doc.defaultView || doc.defaultView.origin !== origin)) doc = null;
          } catch {
            doc = null;
          }
          if (doc && doc.documentElement) visit(doc, scope.concat({ t: 'frame', sel: selectorFor(el, root) }));
        }
      }
    };
    visit(document, []);
    return out;
  }

  /** All supported fields; radio buttons are grouped (one entry per group). */
  function collectFields(origin) {
    const entries = [];
    for (const { root, scope } of collectRoots(origin)) {
      const seenGroups = new Set();
      const key = scopeKey(scope);
      for (const el of root.querySelectorAll('input, select, textarea')) {
        const kind = fieldKind(el);
        if (!kind) {
          if (el.localName === 'input' && ['password', 'hidden'].includes(inputType(el))) {
            entries.push({ el, kind: null, scope, scopeKey: key, index: entries.length, label: labelOf(el) });
          }
          continue;
        }
        if (kind === 'radio') {
          const radios = radioGroup(el);
          if (seenGroups.has(radios[0])) continue;
          seenGroups.add(radios[0]);
          entries.push({ el: radios[0], kind, radios, scope, scopeKey: key, index: entries.length, label: groupLabelOf(radios[0]) });
        } else {
          entries.push({ el, kind, scope, scopeKey: key, index: entries.length, label: labelOf(el) });
        }
      }
    }
    return entries;
  }

  function entryBlockReason(entry) {
    if (!entry.kind) return sensitiveReason(entry.el, entry.label) || 'hidden-type';
    if (entry.kind === 'radio') {
      // A group is usable when at least one of its radios is; individual radios are checked on fill.
      const reasons = entry.radios.map((r) => blockReason(r, 'radio', entry.label));
      return reasons.every(Boolean) ? reasons[0] : null;
    }
    return blockReason(entry.el, entry.kind, entry.label);
  }

  function locatorOf(entry) {
    // A radio group is located by its first usable button: a hidden member (and its value) never ends up
    // in a template, not even inside a selector.
    const el = entry.kind === 'radio' ? entry.radios.find((r) => !blockReason(r, 'radio', entry.label)) || entry.el : entry.el;
    const loc = {
      sel: selectorFor(el, el.getRootNode()),
      path: entry.scope.map((s) => ({ t: s.t, sel: s.sel })),
      tag: el.localName,
      index: entry.index,
    };
    if (el.localName === 'input') loc.type = inputType(el);
    const attrs = { id: el.id, name: el.getAttribute('name'), placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'), autocomplete: el.getAttribute('autocomplete') };
    for (const [k, v] of Object.entries(attrs)) if (v) loc[k] = String(v).slice(0, 200);
    if (entry.label) loc.label = entry.label.slice(0, 200);
    return loc;
  }

  function optionsOf(entry) {
    if (entry.kind === 'select') return Array.from(entry.el.options).slice(0, MAX_OPTIONS).map((o) => ({ v: o.value.slice(0, 5000), t: clean(o.textContent) }));
    if (entry.kind === 'radio') return entry.radios.filter((r) => !blockReason(r, 'radio', entry.label)).slice(0, MAX_OPTIONS).map((r) => ({ v: radioValue(r).slice(0, 5000), t: clean(labelOf(r)) || radioValue(r).slice(0, 200) }));
    return undefined;
  }

  function readValue(entry) {
    switch (entry.kind) {
      case 'checkbox':
        return !!entry.el.checked;
      case 'radio': {
        // Only usable buttons count: a hidden checked member (an old choice kept by the site) is not read.
        const c = entry.radios.find((r) => r.checked && !blockReason(r, 'radio', entry.label));
        return c ? radioValue(c) : '';
      }
      case 'select':
        return entry.el.value;
      default:
        return entry.el.value;
    }
  }

  function displayOf(entry, value) {
    if (entry.kind === 'checkbox') return !!value;
    if (entry.kind === 'select') {
      const o = Array.from(entry.el.options).find((x) => x.value === value);
      return o ? clean(o.textContent) : String(value);
    }
    if (entry.kind === 'radio') {
      const r = entry.radios.find((x) => radioValue(x) === value);
      return r ? clean(labelOf(r)) || value : String(value);
    }
    return String(value).slice(0, 300);
  }

  // ---------------------------------------------------------------------------------------------
  // Matching template fields to page fields

  function rootForPath(path) {
    let root = document;
    for (const step of path || []) {
      let host = null;
      try { host = root.querySelector(step.sel); } catch { return null; }
      if (!host) return null;
      if (step.t === 'shadow') {
        root = host.shadowRoot;
      } else {
        try {
          const doc = host.contentDocument;
          root = doc && doc.defaultView && doc.defaultView.origin === window.origin ? doc : null;
        } catch {
          root = null;
        }
      }
      if (!root) return null;
    }
    return root;
  }

  function selectorHits(field) {
    const loc = field.locator;
    const root = rootForPath(loc.path);
    if (!root || typeof loc.sel !== 'string' || loc.sel.length > 500) return null;
    try {
      return Array.from(root.querySelectorAll(loc.sel));
    } catch {
      return null;
    }
  }

  function score(field, cand, key, hits) {
    if (cand.kind !== field.kind) return -1;
    const loc = field.locator;
    const el = cand.el;
    let s = 0;
    // The site may have reordered its fields: a selector that points at a field with another label or
    // name must not win, or a value would silently go into the wrong field.
    const labelClash = !!(loc.label && cand.label && norm(cand.label) !== norm(loc.label));
    const name = el.getAttribute('name');
    const nameClash = !!(loc.name && name && name !== loc.name);
    if (labelClash) s -= 3;
    if (nameClash) s -= 3;
    if (cand.scopeKey === key) {
      s += 2;
      if (hits && !labelClash && !nameClash) {
        const members = cand.kind === 'radio' ? cand.radios : [el];
        if (members.some((m) => hits.includes(m))) s += hits.length === 1 || cand.kind === 'radio' ? 6 : 3;
      }
    }
    if (loc.id && el.id === loc.id) s += 5;
    if (loc.name && el.getAttribute('name') === loc.name) s += 4;
    if (loc.label && norm(cand.label) === norm(loc.label)) s += 4;
    if (loc.placeholder && el.getAttribute('placeholder') === loc.placeholder) s += 2;
    if (loc.ariaLabel && el.getAttribute('aria-label') === loc.ariaLabel) s += 2;
    if (loc.autocomplete && el.getAttribute('autocomplete') === loc.autocomplete) s += 1;
    if (loc.index === cand.index) s += 1;
    return s;
  }

  /** Maps template fields to page entries. Returns Map(fieldId -> {entry} | {ambiguous:true}). */
  function resolveAll(fields, entries, taken = new Set()) {
    const pairs = [];
    const perField = new Map();
    for (const f of fields) {
      const key = scopeKey(f.locator.path || []);
      const hits = selectorHits(f);
      const list = [];
      for (const c of entries) {
        if (!c.kind) continue;
        const s = score(f, c, key, hits);
        if (s >= MIN_SCORE) {
          pairs.push({ f, c, s });
          list.push({ c, s });
        }
      }
      perField.set(f.id, list);
    }
    pairs.sort((a, b) => b.s - a.s || a.f.locator.index - b.f.locator.index);
    const out = new Map();
    const used = new Set(taken);
    for (const { f, c, s } of pairs) {
      if (out.has(f.id) || used.has(c.el)) continue;
      const rivals = perField.get(f.id).filter((x) => x.s === s && x.c !== c && !used.has(x.c.el));
      if (rivals.length) {
        out.set(f.id, { ambiguous: true });
        continue;
      }
      out.set(f.id, { entry: c });
      used.add(c.el);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Setting values like a person would, so React/Vue/Angular notice the change.

  function setNativeValue(el, value) {
    let proto = Object.getPrototypeOf(el);
    let desc = null;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type, init = {}) {
    const W = viewOf(el);
    let ev;
    if (type === 'focus' || type === 'blur') ev = new W.FocusEvent(type, { bubbles: false, composed: true });
    else if (type === 'focusin' || type === 'focusout') ev = new W.FocusEvent(type, { bubbles: true, composed: true });
    else if (type === 'input' && init.text) ev = new W.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: null });
    else ev = new W.Event(type, { bubbles: true, composed: type === 'input' });
    el.dispatchEvent(ev);
  }

  // The page may react to our events (or to anything) by hiding the field, turning it into a
  // password or submit input, or replacing it: the element is checked again right before each write.
  function stillFillable(el, kind) {
    return !!el && el.isConnected && fieldKind(el) === kind && !blockReason(el, kind, kind === 'radio' ? groupLabelOf(el) : labelOf(el));
  }

  /** Returns false (and writes nothing) when the field stopped being fillable after focus events. */
  function setTextLike(el, value, kind) {
    fire(el, 'focus');
    fire(el, 'focusin');
    if (!stillFillable(el, kind)) return false;
    setNativeValue(el, value);
    fire(el, 'input', { text: true });
    fire(el, 'change');
    fire(el, 'blur');
    fire(el, 'focusout');
    return true;
  }

  function setSelect(el, option) {
    fire(el, 'focus');
    fire(el, 'focusin');
    if (!stillFillable(el, 'select') || !el.contains(option) || !optionUsable(option)) return false;
    setNativeValue(el, option.value);
    if (el.value !== option.value) option.selected = true;
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    fire(el, 'focusout');
    return true;
  }

  /** An option a person could pick: not disabled itself or through its group. */
  function optionUsable(o) {
    return !o.disabled && !(o.parentElement && o.parentElement.localName === 'optgroup' && o.parentElement.disabled);
  }

  function findOption(select, value) {
    const opts = Array.from(select.options).filter(optionUsable);
    return opts.find((o) => o.value === value) || opts.find((o) => norm(o.textContent) === norm(value)) || null;
  }

  function findRadio(entry, value) {
    return entry.radios.find((r) => radioValue(r) === value) || entry.radios.find((r) => norm(labelOf(r)) === norm(value)) || null;
  }

  function snapshot(entry) {
    const el = entry.el;
    if (entry.kind === 'checkbox') return { kind: 'checkbox', el, checked: el.checked };
    if (entry.kind === 'radio') return { kind: 'radio', radios: entry.radios.slice(), checked: entry.radios.find((r) => r.checked) || null };
    return { kind: entry.kind, el, value: el.value };
  }

  /** Whether a field differs from its "before" snapshot; read only while the field is still fillable. */
  function changedSince(snap) {
    if (snap.kind === 'checkbox') return stillFillable(snap.el, 'checkbox') && snap.el.checked !== snap.checked;
    if (snap.kind === 'radio') return (snap.radios.find((r) => r.checked && stillFillable(r, 'radio')) || null) !== snap.checked;
    return stillFillable(snap.el, snap.kind) && snap.el.value !== snap.value;
  }

  /** Puts a "before" value back; true only when it really is back. Nothing is read before the check. */
  async function restore(snap, waitMs) {
    // Undo never clicks or writes into something that is no longer the same kind of visible field.
    if (snap.kind === 'checkbox') {
      if (!stillFillable(snap.el, 'checkbox') || snap.el.checked === snap.checked) return false;
      snap.el.click();
      return snap.el.checked === snap.checked;
    }
    if (snap.kind === 'radio') {
      // A radio group with nothing selected cannot be restored: a person cannot unselect a radio
      // either, and forcing checked=false would desync React/Vue state. Keep the selection then.
      if (!snap.checked || !stillFillable(snap.checked, 'radio') || snap.checked.checked) return false;
      snap.checked.click();
      return snap.checked.checked;
    }
    if (snap.kind === 'select') {
      // A dependent list may be disabled or reloading after its parent was restored: wait for it.
      const find = () => (stillFillable(snap.el, 'select') ? Array.from(snap.el.options).find((x) => x.value === snap.value && optionUsable(x)) || null : null);
      const o = find() || (snap.el.isConnected ? await waitFor(find, waitMs, Date.now() + waitMs) : null);
      if (!o || snap.el.value === snap.value || !setSelect(snap.el, o)) return false;
      return snap.el.value === snap.value;
    }
    if (!stillFillable(snap.el, snap.kind) || snap.el.value === snap.value) return false;
    return setTextLike(snap.el, snap.value, snap.kind) && snap.el.value === snap.value;
  }

  /**
   * The result of a fill write, judged on the live field after the page had a moment to react: a
   * framework may have replaced the element, a mask reformatted the value, or a handler refused it.
   */
  function settledStatus(f, e, shown, want, snap, resolveOne) {
    let el = f.kind === 'radio' ? shown : e.el;
    if (!el.isConnected) {
      // Replaced while handling our events (a re-rendered component): judge the replacement found by
      // the same locator, if it is there and fillable.
      const m = resolveOne(f);
      if (!m || !m.entry || entryBlockReason(m.entry)) return 'failed';
      el = f.kind === 'radio' ? findRadio(m.entry, want) : m.entry.el;
      if (!el) return 'failed';
    }
    if (!stillFillable(el, f.kind)) return 'blocked';
    if (f.kind === 'checkbox') return el.checked === want ? 'filled' : 'failed';
    if (f.kind === 'radio') return el.checked ? 'filled' : 'failed';
    if (f.kind === 'select') {
      const o = findOption(el, want);
      return o && el.value === o.value ? 'filled' : 'failed';
    }
    if (el.value === want) return 'filled';
    if (f.kind === 'date') {
      // An invalid date: put the previous value back.
      if (el === snap.el) setTextLike(el, snap.value, 'date');
      return 'invalid';
    }
    // Masks, upper case, trimming: the page took the value in its own format. A refusal leaves the old
    // value or nothing.
    return el === snap.el && el.value !== snap.value && el.value !== '' ? 'filled' : 'failed';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------------------------
  // Overlay: small numbered marks, a soft tint and short tags drawn above the page in a closed shadow
  // root. No outlines around fields. Field elements themselves are never restyled, and the overlay
  // never contains template or variant data (only page labels, numbers and fixed UI words).

  const TONES = { accent: '#5c60db', ok: '#1f9d55', warn: '#c98a00', bad: '#d12d3a' };
  const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
  const FLASH_MS = 900;

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`;
  }

  const overlay = {
    host: null,
    root: null,
    banner: null,
    items: [], // { el, tone, mark?, tag?, tint?, ring?, ringAlpha?, flash?, born?, radius? }
    raf: 0,
    timer: 0,
    op: 0, // id of the preview/fill that drew the current items
    ensure() {
      if (this.host && this.host.isConnected) return;
      const host = document.createElement(OVERLAY_TAG);
      const hs = host.style;
      hs.setProperty('position', 'fixed', 'important');
      hs.setProperty('inset', '0', 'important');
      hs.setProperty('pointer-events', 'none', 'important');
      hs.setProperty('z-index', '2147483647', 'important');
      hs.setProperty('display', 'block', 'important');
      this.root = host.attachShadow({ mode: 'closed' });
      document.documentElement.append(host);
      this.host = host;
      // In the top layer (a manual popover), so the marks stay above the page's modal dialogs too.
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
        for (const [k, v] of [['margin', '0'], ['padding', '0'], ['border', '0'], ['background', 'transparent'], ['width', '100%'], ['height', '100%'], ['max-width', 'none'], ['max-height', 'none'], ['overflow', 'visible'], ['color', 'inherit']]) hs.setProperty(k, v, 'important');
        this.raise();
      }
    },
    // A dialog or popover the page opens after us lies above us in the top layer: step back on top.
    raise() {
      const host = this.host;
      if (!host || !host.hasAttribute('popover')) return;
      try {
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      } catch {
        /* not possible right now (e.g. the document is being torn down): stay in place */
      }
    },
    onToggle(e) {
      if (e.target === overlay.host || !overlay.host) return;
      overlay.checked = 0; // look at modal dialogs again on the next frame
      if (e.newState === 'open') requestAnimationFrame(() => overlay.raise());
    },
    set(items) {
      const now = performance.now();
      for (const it of items) if (it.flash && !it.born) it.born = now;
      this.items = items;
      this.ensure();
      if (!this.watching) {
        // Popovers and (in current Chrome) dialogs fire "toggle" when they open; modal dialogs of older
        // versions are caught by a light check twice a second in the drawing loop.
        document.addEventListener('toggle', this.onToggle, true);
        this.watching = true;
      }
      this.draw();
      if (!this.raf) {
        const loop = () => {
          this.draw();
          this.raf = this.items.length || this.banner ? requestAnimationFrame(loop) : 0;
        };
        this.raf = requestAnimationFrame(loop);
      }
    },
    setBanner(text) {
      this.ensure();
      if (!text) {
        if (this.banner) this.banner.remove();
        this.banner = null;
        return;
      }
      if (!this.banner) {
        const b = document.createElement('div');
        Object.assign(b.style, {
          position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '7px 14px 7px 11px', borderRadius: '999px', background: 'rgba(22, 22, 26, 0.92)', color: 'rgba(255, 255, 255, 0.92)',
          border: '1px solid rgba(255, 255, 255, 0.12)', boxShadow: '0 10px 30px -8px rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(16px)',
          font: `500 13px/1.3 ${FONT}`, letterSpacing: '-0.005em', whiteSpace: 'nowrap', maxWidth: '90vw',
        });
        const dot = document.createElement('span');
        Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', background: '#e5484d', boxShadow: '0 0 0 3px rgba(229, 72, 77, 0.25)', flex: 'none' });
        const label = document.createElement('span');
        Object.assign(label.style, { overflow: 'hidden', textOverflow: 'ellipsis' });
        b.append(dot, label);
        this.root.append(b);
        this.banner = b;
      }
      this.banner.lastChild.textContent = text;
    },
    draw() {
      if (!this.root) return;
      const now = performance.now();
      if (this.host && this.host.hasAttribute('popover') && now - (this.checked || 0) > 500) {
        this.checked = now;
        const modal = document.querySelector('dialog:modal');
        if (modal !== this.modal) {
          this.modal = modal;
          if (modal) this.raise();
        }
      }
      const boxes = Array.from(this.root.querySelectorAll('div[data-box]'));
      let i = 0;
      for (const item of this.items) {
        // Under an open modal dialog the rest of the page is covered and inert: only its own fields get marks.
        if (this.modal && !insideOf(item.el, this.modal)) continue;
        const r = item.el.isConnected ? rectInTop(item.el) : null;
        if (!r || r.width === 0) continue;
        let box = boxes[i++];
        if (!box) {
          box = document.createElement('div');
          box.dataset.box = '1';
          box.append(document.createElement('div'), document.createElement('span'), document.createElement('span'));
          this.root.append(box);
        }
        const tone = TONES[item.tone] || TONES.accent;
        if (item.radius === undefined) {
          try {
            item.radius = getComputedStyle(item.el).borderRadius || '6px';
          } catch {
            item.radius = '6px';
          }
        }
        Object.assign(box.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

        const boost = item.flash ? 0.24 * Math.max(0, 1 - (now - item.born) / FLASH_MS) : 0;
        const alpha = (item.tint ? 0.07 : 0) + boost;
        // A thin ring that follows the field's own shape, plus a faint halo: visible, not a frame.
        const ring = item.ring ? Math.min(0.9, (item.ringAlpha || 0.5) + boost) : 0;
        Object.assign(box.children[0].style, {
          position: 'absolute', inset: '0', borderRadius: item.radius, background: alpha ? rgba(tone, alpha) : 'transparent',
          boxShadow: ring ? `0 0 0 1.5px ${rgba(tone, ring)}, 0 0 0 5px ${rgba(tone, 0.09)}` : 'none',
        });

        // Fields get the mark on their left edge; small controls (checkboxes, radios) a smaller
        // badge on their top-right corner, clear of the labels next to them.
        const small = r.width < 28 || r.height < 18;
        const size = small ? 16 : 18;
        const mark = box.children[1];
        mark.textContent = item.mark || '';
        Object.assign(mark.style, {
          display: item.mark ? 'block' : 'none', position: 'absolute', boxSizing: 'border-box',
          // Just outside the left edge, like list numbering: clear of the label above and of the text
          // inside (kept on screen for fields that touch the left side of the window).
          left: small ? `${Math.round(Math.min(r.width - 7, innerWidth - size - 2 - r.left))}px` : `${Math.round(Math.max(-(size + 5), 2 - r.left))}px`,
          top: small ? `${Math.round(Math.max(-11, 2 - r.top))}px` : `${Math.round(Math.min(r.height, 40) / 2 - size / 2)}px`,
          minWidth: `${size}px`, height: `${size}px`, padding: '0 4px', borderRadius: `${size / 2}px`, background: tone, color: '#fff',
          font: `700 ${small ? 10 : 11}px/${size}px ${FONT}`, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
          boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.95), 0 2px 6px rgba(0, 0, 0, 0.22)',
        });

        const tag = box.children[2];
        tag.textContent = item.tag || '';
        const below = r.top < 34;
        Object.assign(tag.style, {
          // Above the field's right end: labels usually sit on the left.
          display: item.tag ? 'block' : 'none', position: 'absolute', left: 'auto', right: small ? 'auto' : '0',
          top: below ? 'calc(100% + 6px)' : 'auto', bottom: below ? 'auto' : 'calc(100% + 6px)',
          padding: '4px 10px', borderRadius: '999px', background: 'rgba(22, 22, 26, 0.92)', color: '#fff',
          borderLeft: `3px solid ${tone}`, boxShadow: '0 8px 20px -6px rgba(0, 0, 0, 0.4)',
          font: `500 12px/1.35 ${FONT}`, whiteSpace: 'nowrap', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis',
        });
      }
      for (; i < boxes.length; i++) boxes[i].remove();
    },
    clear() {
      this.items = [];
      if (this.watching) document.removeEventListener('toggle', this.onToggle, true);
      this.watching = false;
      this.modal = null;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.timer);
      if (this.host) this.host.remove();
      this.host = null;
      this.root = null;
      this.banner = null;
    },
  };

  /** Whether el is inside container, also through shadow roots. */
  function insideOf(el, container) {
    for (let n = el; n; n = n.parentNode || n.host) if (n === container) return true;
    return false;
  }

  function rectInTop(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let win = viewOf(el);
    while (win && win !== window) {
      let fe = null;
      try { fe = win.frameElement; } catch { fe = null; }
      if (!fe) return null;
      const fr = fe.getBoundingClientRect();
      left += fr.left + fe.clientLeft;
      top += fr.top + fe.clientTop;
      win = viewOf(fe);
    }
    return { left, top, width: r.width, height: r.height };
  }

  // ---------------------------------------------------------------------------------------------
  // Recording

  let rec = null;

  // Stops recording and removes highlights; used when the extension was updated or removed.
  function retire() {
    if (rec) API.recordStop();
    overlay.clear();
  }

  // True when the event should be handled; an orphaned agent cleans up instead.
  function live(e) {
    if (!rec || !e.isTrusted) return false;
    if (alive()) return true;
    retire();
    return false;
  }

  function notify(event, reason) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'ff:rec', token: rec.token, event, ...(reason ? { reason } : {}) });
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* panel closed */
    }
  }

  // Identity of a field for following it when the page re-renders it (same field, new element).
  // Without an id, a name or a label there is nothing reliable to follow.
  function fingerprint(e) {
    const id = e.el.id || '';
    const name = e.el.getAttribute('name') || '';
    const label = norm(e.label || '');
    if (!id && !name && !label) return null;
    return [e.kind, e.el.localName, e.el.localName === 'input' ? inputType(e.el) : '', id, name, label, e.scopeKey].join('\u0001');
  }

  /**
   * Selected fields whose element left the page are moved to their replacement when exactly one
   * unselected field has the same identity (keyed components, sections rendered again). Returns
   * whether anything moved. The replacement passes the same checks as any field.
   */
  function reattach(entries) {
    const gone = [...rec.selected].filter(([el, info]) => !el.isConnected && info.fp);
    if (!gone.length) return false;
    let moved = false;
    for (const [el, info] of gone) {
      const same = entries.filter((e) => e.kind && !rec.selected.has(e.el) && fingerprint(e) === info.fp);
      if (same.length !== 1 || entryBlockReason(same[0])) continue;
      rec.selected.delete(el);
      info.radios = same[0].radios || null;
      rec.selected.set(same[0].el, info);
      moved = true;
    }
    return moved;
  }

  // Numbers of the selected fields in page order (the panel lists them in the same order).
  function renumber() {
    const order = new Map();
    let n = 0;
    for (const e of collectFields(rec.origin)) if (e.kind && rec.selected.has(e.el) && !entryBlockReason(e)) order.set(e.el, ++n);
    rec.order = order;
  }

  function recordItems() {
    const items = [];
    for (const [el, info] of rec.selected) {
      const n = rec.order && rec.order.get(el);
      if (!n) continue;
      // Text-like fields get a soft tint; checkboxes and radio groups only the number beside them.
      // A radio group is shown on each of its buttons; the number goes on the first one.
      // A value just set from the panel makes the field blink once, so the person sees where it went.
      const flash = !!info.flashAt && performance.now() - info.flashAt < FLASH_MS;
      for (const [i, m] of (info.radios || [el]).entries()) items.push({ el: m, tone: 'accent', mark: i === 0 ? String(n) : '', tint: !info.radios && fieldKind(el) !== 'checkbox', ring: true, flash, born: flash ? info.flashAt : undefined });
    }
    if (rec.hover && !rec.selected.has(rec.hover.key)) {
      items.push({ el: rec.hover.el, tone: rec.hover.reason ? 'bad' : 'accent', tag: rec.hover.text, tint: !rec.hover.reason, ring: true, ringAlpha: 0.32 });
    }
    return items;
  }

  function redrawRecording() {
    overlay.set(recordItems());
    overlay.setBanner(rec.strings.banner.replace('{n}', String(rec.order ? rec.order.size : rec.selected.size)));
  }

  function targetField(e) {
    for (const n of e.composedPath()) {
      if (!n || n.nodeType !== 1) continue;
      if (n.localName === 'input' || n.localName === 'select' || n.localName === 'textarea') return n;
      if (n.localName === 'button') return n;
      if (n.localName === 'label' && n.control) return n.control;
      if (n.localName === 'form' || n.localName === 'body') break;
    }
    return null;
  }

  function isSubmitControl(el) {
    if (el.localName === 'button') return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    return el.localName === 'input' && ['submit', 'image'].includes(inputType(el));
  }

  function hoverInfo(el) {
    const kind = fieldKind(el);
    const key = kind === 'radio' ? radioGroup(el)[0] : el;
    const label = kind === 'radio' ? groupLabelOf(el) : labelOf(el);
    const reason = kind ? blockReason(el, kind, label) : (el.localName === 'input' && inputType(el) === 'password' ? 'password' : 'unsupported');
    const text = reason ? `${rec.strings.blocked} · ${rec.strings.reasons[reason] || reason}` : rec.selected.has(key) ? `${label} · ${rec.strings.added}` : `${label ? `${label} · ` : ''}${rec.strings.add}`;
    return { el, key, kind, label, reason, text };
  }

  // A radio group is stored under its first button.
  function selectionKey(el) {
    return fieldKind(el) === 'radio' ? radioGroup(el)[0] : el;
  }

  function onPointerDown(e) {
    if (!live(e)) return;
    const el = targetField(e);
    if (!el || el.localName === 'button' || isSubmitControl(el)) return;
    // A field already in the template behaves normally, so the person can type its value.
    if (rec.selected.has(selectionKey(el))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    // Only real clicks by the person count; synthetic events from the page are ignored.
    if (!live(e)) return;
    const el = targetField(e);
    if (!el) return;
    if (isSubmitControl(el)) {
      // Prevent accidental submission while recording.
      e.preventDefault();
      e.stopImmediatePropagation();
      notify('blocked', 'submit');
      return;
    }
    if (el.localName === 'button') return;
    const info = hoverInfo(el);
    // Clicks on a selected field go through (focus, open the list, tick the box); the field is
    // removed with the × in the panel.
    if (!info.reason && rec.selected.has(info.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (info.reason) {
      rec.hover = info;
      redrawRecording();
      notify('blocked', info.reason);
      return;
    }
    rec.selected.set(info.key, { label: info.label, radios: info.kind === 'radio' ? radioGroup(el) : null, sid: ++rec.seq });
    renumber();
    rec.hover = hoverInfo(el);
    redrawRecording();
    notify('changed');
  }

  // Values typed into selected fields show up in the panel while recording. The time of the person's
  // last edit tells the panel which side changed last (same machine clock as the panel).
  function onEdit(e) {
    if (!live(e)) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1 || !fieldKind(el)) return;
    const info = rec.selected.get(selectionKey(el));
    // click() on a box or radio makes the browser fire *trusted* input/change: those are our writes.
    if (!info || rec.selfWrite) return;
    info.editedAt = Date.now();
    clearTimeout(rec.editTimer);
    rec.editTimer = setTimeout(() => rec && notify('changed'), 150);
  }

  function onOver(e) {
    if (!live(e)) return;
    const el = targetField(e);
    if (!el || el.localName === 'button') {
      if (rec.hover) {
        rec.hover = null;
        redrawRecording();
      }
      return;
    }
    rec.hover = hoverInfo(el);
    redrawRecording();
  }

  // Every second: watch new frames/shadow roots; every other second ask the panel whether this
  // recording is still its own. No answer (panel closed) or a different session → stop.
  function tick() {
    attachDocs();
    if (rec) {
      if ([...rec.selected.keys()].some((k) => !k.isConnected) && reattach(collectFields(rec.origin))) renumber();
      const live = [...rec.selected.keys()].filter((k) => k.isConnected).length;
      if (live !== rec.live) {
        rec.live = live;
        redrawRecording();
        // Not the person's doing: the panel refreshes but keeps a note about their last click.
        notify('refresh');
      }
    }
    if (!rec || ++rec.beats % 2) return;
    const token = rec.token;
    const stale = () => { if (rec && rec.token === token) retire(); };
    try {
      chrome.runtime.sendMessage({ type: 'ff:rec', token, event: 'ping' }).then((ok) => { if (ok !== true) stale(); }, stale);
    } catch {
      stale();
    }
  }

  function attachDocs() {
    if (!rec) return;
    for (const { root } of collectRoots(rec.origin)) {
      if (root.nodeType !== 9 || rec.docs.has(root)) continue;
      root.addEventListener('pointerdown', onPointerDown, true);
      root.addEventListener('mousedown', onPointerDown, true);
      root.addEventListener('click', onClick, true);
      root.addEventListener('mouseover', onOver, true);
      root.addEventListener('input', onEdit, true);
      root.addEventListener('change', onEdit, true);
      rec.docs.add(root);
    }
  }

  function detachDocs() {
    for (const d of rec.docs) {
      d.removeEventListener('pointerdown', onPointerDown, true);
      d.removeEventListener('mousedown', onPointerDown, true);
      d.removeEventListener('click', onClick, true);
      d.removeEventListener('mouseover', onOver, true);
      d.removeEventListener('input', onEdit, true);
      d.removeEventListener('change', onEdit, true);
    }
    rec.docs.clear();
  }

  function describe(entry) {
    const value = readValue(entry);
    const d = { kind: entry.kind, label: entry.label, value, display: displayOf(entry, value), locator: locatorOf(entry) };
    const section = sectionOf(entry.el);
    if (section) d.section = section;
    if (entry.el.localName === 'input' && entry.kind !== 'checkbox' && entry.kind !== 'radio') d.inputType = inputType(entry.el);
    const options = optionsOf(entry);
    if (options) d.options = options;
    return d;
  }

  // ---------------------------------------------------------------------------------------------
  // Fill state

  let lastFill = null; // { id, snaps: [], items: [] }

  function newFillId() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function originOk(args) {
    return !!args && typeof args.origin === 'string' && window.origin === args.origin;
  }

  // A recording operation must come from the panel that started this recording (a late call from an
  // earlier recording, or from another panel, must not touch this one).
  function recordingCheck(args) {
    if (!rec) return { ok: false, error: 'not-recording' };
    if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
    if (args.token !== rec.token) return { ok: false, error: 'other-recording' };
    return null;
  }

  function cleanFields(fields) {
    if (!Array.isArray(fields)) return [];
    return fields
      .filter((f) => f && typeof f.id === 'string' && typeof f.kind === 'string' && f.locator && typeof f.locator === 'object')
      .map((f) => ({ id: f.id, kind: f.kind, locator: { ...f.locator, path: Array.isArray(f.locator.path) ? f.locator.path : [], index: Number(f.locator.index) || 0 } }));
  }

  /** Writes a value from the panel into a recorded field, like a fill would; 'ok' or why not. */
  function writeRecorded(e, want) {
    if (e.kind === 'checkbox') {
      if (e.el.checked !== want) e.el.click();
      return e.el.checked === want ? 'ok' : 'failed';
    }
    if (e.kind === 'radio') {
      const r = findRadio(e, want);
      if (!r) return 'no-option';
      if (blockReason(r, 'radio', e.label)) return 'blocked';
      if (!r.checked) r.click();
      return r.checked ? 'ok' : 'failed';
    }
    if (e.kind === 'select') {
      const o = findOption(e.el, want);
      if (!o) return 'no-option';
      if (e.el.value !== o.value && !setSelect(e.el, o)) return 'blocked';
      return e.el.value === o.value ? 'ok' : 'failed';
    }
    // The page may reformat what it accepts (masks): that still counts, the panel shows the result.
    if (e.el.value !== want && !setTextLike(e.el, want, e.kind)) return 'blocked';
    return 'ok';
  }

  async function waitFor(fn, ms, deadline) {
    const end = Math.min(Date.now() + ms, deadline);
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // API (called by the side panel)

  const API = {
    ping() {
      return { ok: true, version: AGENT_VERSION, origin: window.origin };
    },

    /** Lists every field the agent sees, with the reason it is blocked (if any). */
    scan(args) {
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      const fields = collectFields(args.origin).map((e) => ({
        kind: e.kind,
        label: e.label,
        name: e.el.getAttribute('name') || '',
        id: e.el.id || '',
        scope: scopeKey(e.scope),
        blocked: entryBlockReason(e),
      }));
      return { ok: true, fields };
    },

    recordStart(args) {
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      if (typeof args.token !== 'string' || args.token.length < 16) return { ok: false, error: 'bad-token' };
      if (rec) API.recordStop();
      const s = args.strings || {};
      rec = {
        token: args.token,
        origin: args.origin,
        selected: new Map(),
        docs: new Set(),
        hover: null,
        order: new Map(),
        seq: 0, // ids of selected fields, stable while the page changes around them
        beats: 0,
        timer: setInterval(tick, 1000),
        strings: {
          banner: String(s.banner || 'FormDitto: click fields to add them ({n})'),
          add: String(s.add || 'click to add'),
          added: String(s.added || 'added'),
          blocked: String(s.blocked || 'Not allowed'),
          reasons: s.reasons && typeof s.reasons === 'object' ? s.reasons : {},
        },
      };
      attachDocs();
      redrawRecording();
      return { ok: true };
    },

    recordGet(args) {
      const bad = recordingCheck(args);
      if (bad) return bad;
      const all = collectFields(rec.origin);
      reattach(all);
      const entries = all.filter((e) => e.kind && rec.selected.has(e.el));
      const fields = [];
      const order = new Map();
      for (const e of entries) {
        // Re-check at save time: the page may have hidden or changed the field since the click.
        if (entryBlockReason(e)) continue;
        const d = describe(e);
        const info = rec.selected.get(e.el);
        info.fp = fingerprint(e);
        d.sid = info.sid;
        d.edited = info.editedAt || 0;
        fields.push(d);
        order.set(e.el, fields.length);
      }
      // The page marks use exactly the numbers the panel is about to show.
      rec.order = order;
      redrawRecording();
      return { ok: true, fields };
    },

    recordAddAll(args) {
      const bad = recordingCheck(args);
      if (bad) return bad;
      let added = 0;
      let blocked = 0;
      for (const e of collectFields(rec.origin)) {
        if (!e.kind || entryBlockReason(e)) {
          blocked++;
          continue;
        }
        if (!rec.selected.has(e.el)) {
          rec.selected.set(e.el, { label: e.label, radios: e.radios || null, sid: ++rec.seq });
          added++;
        }
      }
      renumber();
      redrawRecording();
      return { ok: true, added, blocked };
    },

    recordRemove(args) {
      const bad = recordingCheck(args);
      if (bad) return bad;
      // By the id given at selection; the page index is only a fallback (it shifts when the page changes).
      let key = null;
      if (Number.isInteger(args.sid)) {
        for (const [k, info] of rec.selected) if (info.sid === args.sid) key = k;
      } else {
        const entry = collectFields(rec.origin).find((e) => e.index === args.index && rec.selected.has(e.el));
        if (entry) key = entry.el;
      }
      if (key) rec.selected.delete(key);
      renumber();
      redrawRecording();
      return { ok: true, removed: !!key };
    },

    // A value entered in the panel goes into the page field as well, so both always show the same.
    // Only into a field the person selected in this recording, and re-checked like any fill.
    recordSet(args) {
      const bad = recordingCheck(args);
      if (bad) return bad;
      if (!Number.isInteger(args.sid) || !Number.isFinite(args.at)) return { ok: false, error: 'bad-args' };
      const e = collectFields(rec.origin).find((x) => x.kind && rec.selected.has(x.el) && rec.selected.get(x.el).sid === args.sid);
      if (!e) return { ok: false, error: 'not-found' };
      const info = rec.selected.get(e.el);
      // The person changed this field on the page after the panel edit: the page value stays.
      if ((info.editedAt || 0) > args.at) return { ok: false, error: 'superseded' };
      const reason = entryBlockReason(e);
      if (reason) return { ok: false, error: 'blocked', reason };
      const want = args.value;
      if (e.kind === 'checkbox' ? typeof want !== 'boolean' : typeof want !== 'string' || want.length > 5000) return { ok: false, error: 'bad-args' };
      let status;
      rec.selfWrite = true;
      try {
        status = writeRecorded(e, want);
      } finally {
        rec.selfWrite = false;
      }
      if (status !== 'ok') return { ok: false, error: status, reason: status === 'blocked' ? entryBlockReason(e) || 'unsupported' : undefined };
      // The page may swap the element for a new one while handling our events. A replacement with the
      // same identity stays in the recording (judged by its own value); any other is not taken over
      // silently: the panel asks to click it again.
      if (!e.el.isConnected || rec.selected.get(e.el) !== info) {
        const all = collectFields(rec.origin);
        reattach(all);
        const now = all.find((x) => x.kind && rec.selected.get(x.el) === info);
        if (!now || entryBlockReason(now)) return { ok: false, error: 'replaced' };
        const got = readValue(now);
        if (e.kind === 'radio' || e.kind === 'checkbox' ? got !== want : got !== want && got === '') return { ok: false, error: 'failed' };
        return { ok: true, value: got };
      }
      info.flashAt = performance.now();
      redrawRecording();
      return { ok: true, value: readValue(e) };
    },

    recordStop(args) {
      // Only the panel that owns the recording stops it (internal calls pass no arguments).
      if (rec && args && args.token !== rec.token) return { ok: true, stopped: false };
      if (rec) {
        clearInterval(rec.timer);
        clearTimeout(rec.editTimer);
        detachDocs();
        rec = null;
      }
      overlay.clear();
      return { ok: true };
    },

    /** Locates template fields on the page. Receives locators only, never variant values. */
    preview(args) {
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      const fields = cleanFields(args.fields);
      const entries = collectFields(args.origin);
      const map = resolveAll(fields, entries);
      const rows = fields.map((f) => {
        const m = map.get(f.id);
        if (!m) return { fieldId: f.id, status: 'not-found' };
        if (m.ambiguous) return { fieldId: f.id, status: 'ambiguous' };
        const e = m.entry;
        const reason = entryBlockReason(e);
        // Hidden, password and card fields are never read, not even to show what is there now.
        if (reason) return { fieldId: f.id, status: 'blocked', reason, label: e.label };
        const value = readValue(e);
        const row = { fieldId: f.id, status: 'ready', label: e.label, current: value, currentDisplay: displayOf(e, value) };
        const options = optionsOf(e);
        if (options) row.options = options;
        return row;
      });
      const items = [];
      fields.forEach((f, i) => {
        const m = map.get(f.id);
        if (!m || !m.entry) return;
        const blocked = !!entryBlockReason(m.entry);
        const small = m.entry.radios || m.entry.kind === 'checkbox';
        items.push({ el: m.entry.el, tone: blocked ? 'bad' : 'accent', mark: String(i + 1), tint: !blocked && !small, ring: true, ringAlpha: 0.45 });
      });
      overlay.set(items);
      const op = ++overlay.op;
      clearTimeout(overlay.timer);
      overlay.timer = setTimeout(() => { if (!rec && overlay.op === op) overlay.clear(); }, 15000);
      return { ok: true, rows };
    },

    /** Current values of template fields (used for "new variant from this page"). */
    capture(args) {
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      const fields = cleanFields(args.fields);
      const map = resolveAll(fields, collectFields(args.origin));
      const values = {};
      for (const f of fields) {
        const m = map.get(f.id);
        if (!m || !m.entry || entryBlockReason(m.entry)) continue;
        values[f.id] = readValue(m.entry);
      }
      return { ok: true, values };
    },

    async fill(args) {
      // The panel already compared origins; re-check here in case the tab navigated meanwhile.
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      // Same-origin navigation (an SPA route change) since the preview counts as another page too.
      const href = location.href;
      if (typeof args.url === 'string' && args.url !== href) return { ok: false, error: 'origin-mismatch' };
      if (rec) API.recordStop();
      overlay.clear();
      const numbers = new Map(cleanFields(args.fields).map((f, i) => [f.id, i + 1]));
      const fields = cleanFields(args.fields).sort((a, b) => a.locator.index - b.locator.index);
      const values = args.values && typeof args.values === 'object' ? args.values : {};
      const timeoutMs = Math.min(30000, Math.max(0, Number(args.timeoutMs) || 0));
      const deadline = Date.now() + Math.max(timeoutMs * 6, 1000);
      const fillId = newFillId();
      const snaps = [];
      const items = [];
      const report = [];
      const used = new Set();

      // The same assignment the preview showed: all fields matched together, so a missing field cannot
      // take an element that clearly belongs to another one. Fields not on the page yet (or replaced)
      // are matched later on their own, never against another field's element.
      const plan = resolveAll(fields, collectFields(args.origin));
      const planned = new Map();
      for (const [id, m] of plan) if (m.entry) planned.set(m.entry.el, id);
      // "Before" values of everything already on the page, taken before the first write: filling a
      // parent list may clear its dependents, and undo must bring their original values back.
      const before = new Map();
      for (const m of plan.values()) if (m.entry && !entryBlockReason(m.entry)) before.set(m.entry.el, snapshot(m.entry));
      const resolveOne = (f) => {
        const entries = collectFields(args.origin);
        const p = plan.get(f.id);
        if (p && p.entry && !used.has(p.entry.el)) {
          const fresh = entries.find((e) => e.el === p.entry.el);
          if (fresh) return { entry: fresh };
        }
        const others = new Set(used);
        for (const [el, id] of planned) if (id !== f.id) others.add(el);
        return resolveAll([f], entries, others).get(f.id) || null;
      };

      for (const f of fields) {
        const has = Object.prototype.hasOwnProperty.call(values, f.id);
        const want = has ? values[f.id] : undefined;
        if (window.origin !== args.origin || location.href !== href) {
          // The page navigated away while we were filling: nothing more is written.
          report.push({ fieldId: f.id, status: 'skipped' });
          continue;
        }
        if (!has || want === '' || want === null || (f.kind === 'checkbox' ? typeof want !== 'boolean' : typeof want !== 'string')) {
          report.push({ fieldId: f.id, status: 'skipped' });
          continue;
        }
        // Wait for late fields, late options and fields that become visible/enabled after earlier answers.
        let m = resolveOne(f);
        const ready = (x) => {
          if (!x || x.ambiguous) return false;
          const e = x.entry;
          if (entryBlockReason(e)) return false;
          if (f.kind === 'select') return !!findOption(e.el, want);
          if (f.kind === 'radio') return !!findRadio(e, want);
          return true;
        };
        if (!ready(m) && !(m && m.entry && sensitiveReason(m.entry.el, m.entry.label))) {
          const r = await waitFor(() => {
            if (location.href !== href) return null;
            const x = resolveOne(f);
            return ready(x) ? x : null;
          }, timeoutMs, deadline);
          if (r) m = r;
          else m = resolveOne(f);
        }
        if (location.href !== href) {
          report.push({ fieldId: f.id, status: 'skipped' });
          continue;
        }
        if (!m) {
          report.push({ fieldId: f.id, status: 'not-found' });
          continue;
        }
        if (m.ambiguous) {
          report.push({ fieldId: f.id, status: 'ambiguous' });
          continue;
        }
        const e = m.entry;
        const reason = entryBlockReason(e);
        if (reason) {
          report.push({ fieldId: f.id, status: 'blocked', reason });
          continue;
        }
        used.add(e.el);
        const snap = before.get(e.el) || snapshot(e);
        let status = 'filled';
        let shown = e.el;
        if (f.kind === 'checkbox') {
          if (e.el.checked === want) status = 'unchanged';
          else e.el.click();
        } else if (f.kind === 'radio') {
          const r = findRadio(e, want);
          if (r) shown = r;
          if (!r) status = 'no-option';
          else if (blockReason(r, 'radio', e.label)) status = 'blocked';
          else if (r.checked) status = 'unchanged';
          else r.click();
        } else if (f.kind === 'select') {
          const o = findOption(e.el, want);
          if (!o) status = 'no-option';
          else if (e.el.value === o.value) status = 'unchanged';
          else if (!setSelect(e.el, o)) status = 'blocked';
        } else if (e.el.value === want) {
          status = 'unchanged';
        } else if (!setTextLike(e.el, want, f.kind)) {
          status = 'blocked';
        }
        if (status === 'filled') {
          // Let the page react (frameworks re-render, masks reformat, a microtask may reset the value),
          // then judge the live field, not the element we wrote into.
          await sleep(0);
          status = settledStatus(f, e, shown, want, snap, resolveOne);
        }
        // Anything the fill actually changed can be undone, even if the page reformatted or refused part.
        if (e.el.isConnected && changedSince(snap)) snaps.push(snap);
        const done = status === 'filled' || status === 'unchanged';
        const small = f.kind === 'checkbox' || f.kind === 'radio';
        items.push({ el: shown.isConnected ? shown : e.el, tone: done ? 'ok' : 'warn', mark: done ? '✓' : String(numbers.get(f.id)), tint: status === 'filled' && !small, ring: status !== 'unchanged', ringAlpha: 0.45, flash: status === 'filled' });
        report.push(status === 'blocked' ? { fieldId: f.id, status, reason: entryBlockReason(e) || blockReason(shown, f.kind, e.label) || 'unsupported' } : { fieldId: f.id, status });
      }

      lastFill = { id: fillId, snaps, items, timeoutMs };
      overlay.set(items.filter((i) => i.el.isConnected).map((i) => ({ ...i })));
      const op = ++overlay.op;
      clearTimeout(overlay.timer);
      overlay.timer = setTimeout(() => { if (!rec && overlay.op === op) overlay.clear(); }, 30000);
      return { ok: true, fillId, report, canUndo: snaps.length > 0 };
    },

    async undo(args) {
      if (!originOk(args)) return { ok: false, error: 'origin-mismatch' };
      if (!lastFill || lastFill.id !== args.fillId) return { ok: false, error: 'nothing-to-undo' };
      const fill = lastFill;
      lastFill = null;
      overlay.clear();
      // In fill order: a parent list first, so the options of its dependents can load before those
      // are restored. Only restorations that actually happened are counted.
      let restored = 0;
      for (const s of fill.snaps) if (await restore(s, Math.min(fill.timeoutMs || 0, 5000))) restored++;
      return { ok: true, restored };
    },

    clearHighlights() {
      if (!rec) overlay.clear();
      return { ok: true };
    },
  };

  const api = Object.freeze({
    alive,
    retire,
    async call(method, args) {
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(API, method)) return { ok: false, error: 'unknown-method' };
      try {
        return await API[method](args && typeof args === 'object' ? args : {});
      } catch (e) {
        return { ok: false, error: 'agent-error', detail: String((e && e.message) || e).slice(0, 300) };
      }
    },
  });

  // Configurable only so that a newer agent can replace an orphaned one (see the top of the file).
  Object.defineProperty(globalThis, '__formditto', { value: api, configurable: true, enumerable: false, writable: false });
})();
