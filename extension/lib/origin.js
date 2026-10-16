// Origin helpers. Pure module: used by the side panel and by Node unit tests.

/** Returns a URL object for http(s) URLs, otherwise null. */
export function parseHttpUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/** "https://portal.example.com:8443" for an http(s) URL, otherwise null. */
export function originOf(url) {
  const u = parseHttpUrl(url);
  return u ? u.origin : null;
}

/**
 * Host permission pattern for exactly one site. Match patterns cannot carry a port, so the
 * pattern covers the host on any port; templates still compare the full origin (with port).
 */
export function permissionPattern(origin) {
  const u = parseHttpUrl(origin);
  return u ? `${u.protocol}//${u.hostname}/*` : null;
}

export function hostOf(origin) {
  const u = parseHttpUrl(origin);
  return u ? u.host : '';
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Compares the origin a template was recorded on with the origin of the current page.
 * same      — exact origin match (scheme, host and port).
 * lookalike — 'punycode' for internationalised host names, 'similar' for near-identical names.
 * downgrade — same host, but the page uses http while the template was recorded on https.
 */
export function compareOrigins(expected, actual) {
  const a = parseHttpUrl(expected);
  const b = parseHttpUrl(actual);
  if (!a || !b) return { same: false, lookalike: null, downgrade: false };
  if (a.origin === b.origin) return { same: true, lookalike: null, downgrade: false };
  const downgrade = a.hostname === b.hostname && a.protocol === 'https:' && b.protocol === 'http:';
  let lookalike = null;
  const ha = a.hostname.replace(/^www\./, '');
  const hb = b.hostname.replace(/^www\./, '');
  if (hb.split('.').some((label) => label.startsWith('xn--'))) lookalike = 'punycode';
  else if (ha !== hb && (levenshtein(ha, hb) <= 2 || hb.startsWith(`${ha}.`) || hb.includes(`${ha.split('.')[0]}-`) || ha.split('.')[0] === hb.split('.')[0])) {
    lookalike = 'similar';
  }
  return { same: false, lookalike, downgrade };
}
