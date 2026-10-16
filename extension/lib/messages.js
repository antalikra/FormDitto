// Validation of runtime messages received by the side panel. Pure module (unit-tested in Node).
//
// The panel accepts exactly two message types:
//   ff:action-clicked — from this extension's own service worker (no tab, exact worker URL);
//   ff:rec            — from this extension's content script in the top frame of the tab being
//                       recorded, with that tab's origin and the session's random token.
// Messages carry no template data and cannot trigger a fill or a storage read.

// changed: the person picked, removed or edited a field; refresh: the page re-rendered selected fields.
export const REC_EVENTS = Object.freeze(['changed', 'refresh', 'blocked', 'stop', 'ping']);
export const BLOCK_REASONS = Object.freeze([
  'password', 'payment', 'otp', 'hidden-type', 'not-rendered', 'too-small', 'invisible', 'transparent',
  'clipped', 'offscreen', 'aria-hidden', 'inert', 'detached', 'disabled', 'readonly', 'unsupported', 'submit',
]);

export function isOwnExtension(sender, runtimeId) {
  return !!sender && typeof runtimeId === 'string' && sender.id === runtimeId;
}

export function isFromServiceWorker(sender, runtimeId, workerUrl) {
  return isOwnExtension(sender, runtimeId) && !sender.tab && sender.url === workerUrl;
}

export function isRecordingSender(sender, runtimeId, session) {
  return (
    isOwnExtension(sender, runtimeId) &&
    !!session &&
    !!sender.tab &&
    sender.tab.id === session.tabId &&
    sender.frameId === 0 &&
    sender.origin === session.origin
  );
}

/** Validates an ff:rec ping. Returns the normalised event or null. */
export function parseRecPing(msg, session) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const keys = Object.keys(msg);
  if (keys.some((k) => !['type', 'token', 'event', 'reason'].includes(k))) return null;
  if (msg.type !== 'ff:rec' || !session || typeof msg.token !== 'string') return null;
  if (msg.token.length !== session.token.length || msg.token !== session.token) return null;
  if (!REC_EVENTS.includes(msg.event)) return null;
  if (msg.reason !== undefined && !BLOCK_REASONS.includes(msg.reason)) return null;
  return { event: msg.event, reason: msg.reason };
}

export function isActionClicked(msg) {
  return !!msg && typeof msg === 'object' && msg.type === 'ff:action-clicked';
}

/** 128-bit random token, hex. */
export function randomToken(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
