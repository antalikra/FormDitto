// Strict schema for FormDitto templates and export files.
// Pure module (no chrome.* APIs): used by the side panel and by Node unit tests.
// Every accepted object is rebuilt from scratch with allow-listed keys only, so unknown keys,
// "__proto__" or "constructor" entries never reach storage.

export const EXPORT_FORMAT = 'formditto-templates';
export const EXPORT_VERSION = 1;

export const LIMITS = Object.freeze({
  importBytes: 2 * 1024 * 1024,
  templatesPerImport: 200,
  templatesTotal: 500,
  fields: 150,
  variants: 500,
  name: 120,
  label: 200,
  value: 5000,
  selector: 500,
  pathDepth: 6,
  options: 300,
  optionText: 200,
  attr: 200,
  index: 100000,
  origin: 300,
});

export const KINDS = Object.freeze(['text', 'textarea', 'select', 'checkbox', 'radio', 'date']);

export const INPUT_TYPES = Object.freeze({
  text: ['text', 'email', 'tel', 'url', 'number', 'search'],
  date: ['date', 'time', 'datetime-local', 'month', 'week'],
  checkbox: ['checkbox'],
  radio: ['radio'],
});

const KIND_TAG = { text: 'input', date: 'input', checkbox: 'input', radio: 'input', textarea: 'textarea', select: 'select' };

// Kept byte-for-byte identical to content/agent.js (checked by test/unit/static-audit.test.js).
export const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;
export const SENSITIVE_PASSWORD = /(pass(word|wd|code)|(?<![a-z])pwd(?![a-z])|парол|one.?time.?(code|password)|(?<![a-z])otp(?![a-z]))/i;
export const SENSITIVE_PAYMENT = /((?<![a-z])(cvv2?|cvc2?|csc|cvn)(?![a-z])|card.?(number|num|no)(?![a-z])|(?<![a-z])cc.?(number|num)|номер.?карт|security.?code)/i;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export class SchemaError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'SchemaError';
    this.path = path;
  }
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function obj(v, path, required, optional = []) {
  if (!isPlainObject(v)) throw new SchemaError(path, 'expected an object');
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) throw new SchemaError(path, `unknown key "${k}"`);
  }
  for (const k of required) if (!own(v, k)) throw new SchemaError(path, `missing key "${k}"`);
  return v;
}

function str(v, path, max, { min = 0, re = null } = {}) {
  if (typeof v !== 'string') throw new SchemaError(path, 'expected a string');
  if (v.length < min) throw new SchemaError(path, 'string is too short');
  if (v.length > max) throw new SchemaError(path, `string is longer than ${max}`);
  if (re && !re.test(v)) throw new SchemaError(path, 'string has an invalid format');
  return v;
}

function optStr(o, k, path, max) {
  if (!own(o, k) || o[k] === undefined) return undefined;
  return str(o[k], `${path}.${k}`, max);
}

function int(v, path, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new SchemaError(path, `expected an integer ${min}..${max}`);
  return v;
}

function time(v, path) {
  // Milliseconds since epoch, 2000-01-01 .. 2200-01-01.
  return int(v, path, 946684800000, 7258118400000);
}

function arr(v, path, max, { min = 0 } = {}) {
  if (!Array.isArray(v)) throw new SchemaError(path, 'expected an array');
  if (v.length < min) throw new SchemaError(path, `expected at least ${min} item(s)`);
  if (v.length > max) throw new SchemaError(path, `more than ${max} items`);
  return v;
}

export function isValidOrigin(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > LIMITS.origin) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return u.origin === s;
}

/** True when the locator describes a password, payment-card, one-time-code or non-fillable field. */
export function isSensitiveLocator(loc) {
  if (loc.type && ['password', 'hidden', 'file'].includes(loc.type)) return true;
  if (loc.autocomplete && SENSITIVE_AUTOCOMPLETE.test(loc.autocomplete)) return true;
  const hay = [loc.name, loc.id, loc.label, loc.placeholder, loc.ariaLabel].filter(Boolean).join(' ');
  return SENSITIVE_PASSWORD.test(hay) || SENSITIVE_PAYMENT.test(hay);
}

function sanitizeLocator(v, path, kind) {
  obj(v, path, ['sel', 'path', 'tag', 'index'], ['type', 'id', 'name', 'label', 'placeholder', 'ariaLabel', 'autocomplete']);
  const loc = {
    sel: str(v.sel, `${path}.sel`, LIMITS.selector, { min: 1 }),
    path: arr(v.path, `${path}.path`, LIMITS.pathDepth).map((step, i) => {
      const p = `${path}.path[${i}]`;
      obj(step, p, ['t', 'sel']);
      if (step.t !== 'frame' && step.t !== 'shadow') throw new SchemaError(`${p}.t`, 'expected "frame" or "shadow"');
      return { t: step.t, sel: str(step.sel, `${p}.sel`, LIMITS.selector, { min: 1 }) };
    }),
    tag: str(v.tag, `${path}.tag`, 10),
    index: int(v.index, `${path}.index`, 0, LIMITS.index),
  };
  if (loc.tag !== KIND_TAG[kind]) throw new SchemaError(`${path}.tag`, `tag "${loc.tag}" does not fit kind "${kind}"`);
  for (const k of ['type', 'id', 'name', 'label', 'placeholder', 'ariaLabel', 'autocomplete']) {
    const val = optStr(v, k, path, k === 'label' ? LIMITS.label : LIMITS.attr);
    if (val !== undefined) loc[k] = val;
  }
  if (loc.tag === 'input') {
    if (!loc.type) throw new SchemaError(`${path}.type`, 'input locator needs a type');
    if (!['password', 'hidden', 'file'].includes(loc.type) && !(INPUT_TYPES[kind] || []).includes(loc.type)) {
      throw new SchemaError(`${path}.type`, `type "${loc.type}" does not fit kind "${kind}"`);
    }
  }
  if (isSensitiveLocator(loc)) throw new SchemaError(path, 'password, payment-card and hidden fields are not allowed');
  return loc;
}

function sanitizeOptions(v, path) {
  return arr(v, path, LIMITS.options).map((o, i) => {
    const p = `${path}[${i}]`;
    obj(o, p, ['v', 't']);
    return { v: str(o.v, `${p}.v`, LIMITS.value), t: str(o.t, `${p}.t`, LIMITS.optionText) };
  });
}

function sanitizeField(v, path) {
  obj(v, path, ['id', 'kind', 'label', 'locator'], ['inputType', 'options', 'section']);
  const kind = str(v.kind, `${path}.kind`, 20);
  if (!KINDS.includes(kind)) throw new SchemaError(`${path}.kind`, `unknown kind "${kind}"`);
  const field = {
    id: str(v.id, `${path}.id`, 40, { re: ID_RE }),
    kind,
    label: str(v.label, `${path}.label`, LIMITS.label),
    locator: sanitizeLocator(v.locator, `${path}.locator`, kind),
  };
  // Heading of the part of the form the field sits in (fieldset legend or h2–h6); display only.
  if (own(v, 'section')) field.section = str(v.section, `${path}.section`, LIMITS.label);
  if (own(v, 'inputType')) {
    const it = str(v.inputType, `${path}.inputType`, 20);
    if (!(INPUT_TYPES[kind] || []).includes(it)) throw new SchemaError(`${path}.inputType`, `"${it}" does not fit kind "${kind}"`);
    field.inputType = it;
  }
  if (own(v, 'options')) {
    if (kind !== 'select' && kind !== 'radio') throw new SchemaError(`${path}.options`, 'only select and radio fields have options');
    field.options = sanitizeOptions(v.options, `${path}.options`);
  }
  return field;
}

function sanitizeVariant(v, path, fieldsById) {
  obj(v, path, ['id', 'name', 'values'], ['updatedAt']);
  const variant = {
    id: str(v.id, `${path}.id`, 40, { re: ID_RE }),
    name: str(v.name, `${path}.name`, LIMITS.name, { min: 1 }),
    values: {},
  };
  if (own(v, 'updatedAt')) variant.updatedAt = time(v.updatedAt, `${path}.updatedAt`);
  if (!isPlainObject(v.values)) throw new SchemaError(`${path}.values`, 'expected an object');
  for (const k of Object.keys(v.values)) {
    const field = own(fieldsById, k) ? fieldsById[k] : null;
    if (!field) throw new SchemaError(`${path}.values`, `value for unknown field "${k}"`);
    const val = v.values[k];
    if (field.kind === 'checkbox') {
      if (typeof val !== 'boolean') throw new SchemaError(`${path}.values.${k}`, 'expected true or false');
      variant.values[k] = val;
    } else {
      variant.values[k] = str(val, `${path}.values.${k}`, LIMITS.value);
    }
  }
  return variant;
}

function sanitizeTemplate(v, path) {
  obj(v, path, ['id', 'name', 'origin', 'fields', 'variants'], ['createdAt', 'updatedAt']);
  const origin = str(v.origin, `${path}.origin`, LIMITS.origin);
  if (!isValidOrigin(origin)) throw new SchemaError(`${path}.origin`, 'expected an http(s) origin: scheme://host[:port] without a path');
  const tpl = {
    id: str(v.id, `${path}.id`, 40, { re: ID_RE }),
    name: str(v.name, `${path}.name`, LIMITS.name, { min: 1 }),
    origin,
    fields: [],
    variants: [],
  };
  if (own(v, 'createdAt')) tpl.createdAt = time(v.createdAt, `${path}.createdAt`);
  if (own(v, 'updatedAt')) tpl.updatedAt = time(v.updatedAt, `${path}.updatedAt`);
  const fieldsById = Object.create(null);
  tpl.fields = arr(v.fields, `${path}.fields`, LIMITS.fields, { min: 1 }).map((f, i) => {
    const field = sanitizeField(f, `${path}.fields[${i}]`);
    if (fieldsById[field.id]) throw new SchemaError(`${path}.fields[${i}].id`, 'duplicate field id');
    fieldsById[field.id] = field;
    return field;
  });
  const seen = new Set();
  tpl.variants = arr(v.variants, `${path}.variants`, LIMITS.variants).map((x, i) => {
    const variant = sanitizeVariant(x, `${path}.variants[${i}]`, fieldsById);
    if (seen.has(variant.id)) throw new SchemaError(`${path}.variants[${i}].id`, 'duplicate variant id');
    seen.add(variant.id);
    return variant;
  });
  return tpl;
}

function result(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof SchemaError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Validates one stored template. Returns { ok, value } with a clean copy, or { ok:false, error }. */
export function validateTemplate(raw) {
  return result(() => sanitizeTemplate(raw, 'template'));
}

/** Validates a parsed export document. */
export function validateExport(raw) {
  return result(() => {
    obj(raw, 'file', ['format', 'version', 'templates'], ['exportedAt', 'app']);
    if (raw.format !== EXPORT_FORMAT) throw new SchemaError('file.format', `expected "${EXPORT_FORMAT}"`);
    if (raw.version !== EXPORT_VERSION) throw new SchemaError('file.version', `unsupported version (expected ${EXPORT_VERSION})`);
    if (own(raw, 'exportedAt')) str(raw.exportedAt, 'file.exportedAt', 40);
    if (own(raw, 'app')) str(raw.app, 'file.app', 60);
    const ids = new Set();
    return arr(raw.templates, 'file.templates', LIMITS.templatesPerImport, { min: 1 }).map((t, i) => {
      const tpl = sanitizeTemplate(t, `file.templates[${i}]`);
      if (ids.has(tpl.id)) throw new SchemaError(`file.templates[${i}].id`, 'duplicate template id');
      ids.add(tpl.id);
      return tpl;
    });
  });
}

/**
 * Parses an import file. `byteLength` is the file size reported by the browser; the text is not
 * parsed when the file is larger than LIMITS.importBytes.
 */
export function parseImport(text, byteLength) {
  if (typeof byteLength !== 'number' || byteLength > LIMITS.importBytes) {
    return { ok: false, error: 'too-large' };
  }
  if (typeof text !== 'string' || text.length > LIMITS.importBytes) return { ok: false, error: 'too-large' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not-json' };
  }
  const r = validateExport(raw);
  return r.ok ? { ok: true, templates: r.value } : { ok: false, error: 'schema', detail: r.error };
}

/** Builds the export document for the given (already valid) templates. */
export function buildExport(templates, now = new Date()) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: 'FormDitto',
    exportedAt: now.toISOString(),
    templates: templates.map((t) => validateTemplate(t)).filter((r) => r.ok).map((r) => r.value),
  };
}
