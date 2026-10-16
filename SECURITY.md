# FormDitto — threat model

What is protected, from whom, and how each threat is handled. Every threat has an id `T1…T14`; the tests that cover it carry that id in their title (`[T3] …`). `test/unit/traceability.test.js` fails if any threat in this file has no test.

## What is protected

* **Variant values** — the operator's work data (names, phone numbers, addresses, contract numbers).
* **Templates** — the structure of an internal portal (selectors, field labels, origin).
* **Form integrity** — the extension must never submit a form or fill anything the person cannot see.

## Parties and trust boundaries

| Party | Trust | Can do |
|---|---|---|
| Operator (user) | trusted | clicks the icon, picks a variant, confirms |
| Portal page (main world) | **untrusted** | any JS, CSS, DOM, synthetic events |
| Phishing copy of the portal | hostile | the same DOM on another origin |
| Embedded cross-origin iframes | untrusted | — |
| JSON import file | **untrusted** | arbitrary content and size |
| Other extensions | untrusted | `runtime.sendMessage(ourId, …)` |
| Supply chain (npm) | partly | code in dev dependencies |

Boundaries: page ↔ the agent's isolated world; agent ↔ panel; panel ↔ storage; file ↔ schema.

## Threats and mitigations

### T1. Excessive permissions / access to all sites at install
* `permissions`: exactly `activeTab`, `scripting`, `storage`, `sidePanel`.
* No `host_permissions`, `<all_urls>`, `content_scripts` or `tabs`. Sites only through
  `optional_host_permissions`, from a button in the panel and for exactly `scheme://host/*` of the
  current site. Access can be revoked in the settings.
* Tests: `test/unit/manifest.test.js` (`[T1]`), `test/e2e/permissions.spec.js` (`[T1]`: no origin
  at install; the button requests one origin), `test/e2e/tabs.spec.js` (`[T1]`: in a new tab without
  a click on the icon the panel cannot see the page and says that a click is needed).

### T2. Filling a phishing copy of the portal
* A template is bound to the exact origin (scheme + host + port) at recording time. The panel takes
  the tab's origin from the browser (`tabs.get`), not from the page.
* On a mismatch the preview shows a red warning with both addresses; the fill button stays disabled
  until the person explicitly ticks "I understand…". Punycode (`xn--`) and look-alike names get an
  extra "looks like an imitation" note.
* Tests: `test/e2e/origin.spec.js` (`[T2]`), `test/unit/origin.test.js` (`[T2]`).

### T3. Hidden and invisible trap fields
A malicious (or compromised) page hides an "address" field so that autofill hands over data
without the person knowing.
* At recording and **again at every fill** the agent checks the real element: `type=hidden`,
  `display:none` / no boxes, `checkVisibility()` (skipped content: `content-visibility`, a closed
  `<details>`), `visibility`, combined ancestor `opacity` < 0.1, size < 4 px, clipping by an
  ancestor with `overflow` (0×0 container), `clip` / `clip-path`, placement outside the document,
  `aria-hidden` / `inert` ancestors, a hidden iframe container. Such fields are neither recorded nor
  filled, even when a template (for example an imported one) points at them.
* Exception for checkbox / radio: their own `opacity:0` is allowed (custom checkboxes), but only at
  a normal size with visible ancestors — the value there is only a boolean.
* Tests: `test/e2e/trap.spec.js` (`[T3]`).

### T4. Passwords, payment cards, one-time codes
* Never recorded or filled: `type=password`; `autocomplete` with `cc-*`, `current-password`,
  `new-password`, `one-time-code`; names / labels such as password, cvv, cvc, card number, otp
  (and their Russian equivalents).
* Import rejects templates with such locators.
* The page may react to fill events (for example to `focus`) and turn the field into a password
  field, hide it or replace it. So the element is checked again right before every write and every
  click, including during Undo.
* The value of a blocked field is never read: the preview returns only its status and reason (no
  "now on the page", no list options), and Undo checks the field before comparing its value. In a
  radio group a hidden checked member is not read and gets into neither the values, nor the options,
  nor the template selector (the group is represented by its first visible button).
* Tests: `test/e2e/edge.spec.js` (`[T3][T4]`: a field that became hidden or a card field after
  recording; `[T3]`: a hidden checked radio).
* Tests: `test/e2e/trap.spec.js` (`[T4]`), `test/unit/schema.test.js` (`[T4]`),
  `test/e2e/hostile.spec.js` (`[T4]`: a field turns into a password field on focus — nothing is
  written into it).

### T5. Automatic form submission
* The code never calls `submit()` / `requestSubmit()`, never clicks buttons and never sends keys
  (Enter). Checkboxes and radios are toggled with `click()` on the field itself — that does not
  submit the form.
* Undo clicks a checkbox or radio only if it is still a visible checkbox or radio: the page cannot
  swap it for a submit button.
* An abandoned recording (panel closed, reloaded or moved to another tab) stops by itself: every two
  seconds the agent asks the panel whether the session is still its own, and without an answer it
  removes its listeners.
* Tests: `test/unit/static-audit.test.js` (`[T5]`), e2e tests on every form check that the submit
  counter is 0 after fill and undo (`[T5]`), `test/e2e/hostile.spec.js` (`[T5]`: a checkbox turned
  into a submit button is not clicked by Undo).

### T6. Data leaving the device
* Data lives only in `chrome.storage.local`. No server, analytics, telemetry or `storage.sync`.
* The code has no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` or external
  URLs; the CSP of extension pages is `connect-src 'none'`.
* Tests: `test/unit/static-audit.test.js` (`[T6]`), `test/e2e/network.spec.js` (`[T6]`: over the
  whole scenario not a single request from extension contexts, and no page requests to hosts other
  than the test ones).

### T7. Code injection into the extension (XSS, eval, remote code)
* No `eval`, `new Function`, string `setTimeout` or remote scripts. Data (field labels from the
  page, names, imports) is rendered only through `textContent` / properties; `innerHTML`,
  `outerHTML`, `insertAdjacentHTML` and `document.write` are banned.
* Translations for the language switch are a static module, `lib/locales.js`, generated from
  `scripts/i18n/`; strings are rendered only through `textContent`. No network is needed for this
  (`connect-src 'none'` stays).
* CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  The HTML has no inline scripts, `on*=` handlers or `style=` attributes.
* Tests: `test/unit/static-audit.test.js` (`[T7]`), `test/unit/manifest.test.js` (`[T7]` CSP),
  `test/e2e/xss.spec.js` (`[T7]`: an HTML payload in labels, names and imports is shown as text,
  no dialogs).

### T8. The page reads saved templates
* No `web_accessible_resources` and no `externally_connectable` — the page can neither load the
  extension's resources nor message it.
* `chrome.storage.local.setAccessLevel('TRUSTED_CONTEXTS')`: not even a content script can read the
  storage.
* The agent lives in an isolated world with no message listeners; it receives template data only as
  an argument at fill time and never writes it into the DOM. The overlay (a closed shadow root)
  contains only numbers, check marks, field labels from the page and fixed UI words — no values and
  no variant names.
* After an extension update, the previous version's agent can stay in a tab without an extension
  context. It notices (`chrome.runtime.id` is gone), removes its listeners and highlights, and the
  new version takes its place; a live agent is never replaced.
* Tests: `test/e2e/isolation.spec.js` (`[T8]`).

### T9. Forged messages between parts of the extension
* No `externally_connectable`; no `onMessageExternal` / `onConnectExternal`.
* The panel accepts exactly two message types: `ff:action-clicked` — only from its own service
  worker; `ff:rec` — only from its own content script in the top frame of the tab being recorded,
  with that tab's origin and a one-time 128-bit recording session token; the payload is
  shape-checked. A message from the content script can neither read the storage nor start a fill.
* Tests: `test/unit/messages.test.js` (`[T9]`), `test/e2e/isolation.spec.js` (`[T9]`).

### T10. A malicious or huge import file
* A 2 MB limit before reading; `JSON.parse` inside `try`; a strict allow-list schema (unknown keys →
  rejected), limits on counts and string lengths, origin checks (http/https only, no path or
  credentials), ids matching `[A-Za-z0-9_-]`, value references checked against fields. Objects are
  rebuilt from scratch — `__proto__` / `constructor` do not get through.
* Selectors are data only: used solely in `querySelectorAll` inside `try`, length ≤ 500.
* Before importing, a summary is shown (how many templates, which origins); an id conflict creates
  a copy instead of overwriting.
* Tests: `test/unit/schema.test.js` (`[T10]`), `test/e2e/import-export.spec.js` (`[T10]`).

### T11. The page injects events during recording
* Recording counts only `event.isTrusted` clicks. A synthetic `click()` by the page on a hidden
  field does not add it to the template.
* A click on a field that is already in the template reaches the page as a normal click (so the
  person can type a value); a field is removed only with the × button in the panel. Submit buttons
  stay blocked during recording.
* A value entered in the panel during recording is written into the page by the agent
  (`recordSet`) only into a field selected in this recording (by `sid`), with the same checks as a
  fill (`entryBlockReason`, `stillFillable` after focus events); passwords, cards and hidden fields
  are never written, and the form is never submitted. If the page swapped the element while the
  value was being written, the agent reports `replaced` and does not move the selection to the new
  element without the person's click.
* Every recording call (`recordGet/AddAll/Remove/Set/Stop`) carries its recording's token: a late
  call from an earlier recording or from another panel changes nothing (`other-recording`).
* "Last edit wins" is decided by time: the agent stamps the person's edits (`isTrusted` events,
  except those the browser itself fires from our `click()`), the panel stamps its own. A panel write
  older than an edit on the page is rejected (`superseded`).
* Tests: `test/e2e/trap.spec.js` (`[T11]`), `test/e2e/recording.spec.js` (`[T11]`, sync).

### T12. Filling foreign iframes
* The agent walks only iframes with the same origin as the tab (`contentDocument` is accessible and
  `origin` matches); injection goes into the top frame only.
* Tests: `test/e2e/frames.spec.js` (`[T12]`).

### T13. The page changes between preview and fill
* The panel checks the tab's origin again before filling; the agent compares `window.origin` with
  the expected one and refuses on a mismatch. Undo works only on the same page.
* The preview is also bound to the page address: an SPA route change (`history.pushState`) cancels
  it, and a fill started at one address writes nothing after a move to another.
* The fill uses the same field matching the preview showed: a field missing from the page cannot
  take another field's element; a label or name that contradicts the template outweighs a match by
  position (the site reordered its fields). Unavailable list options (`disabled`, including through
  `optgroup`) are never chosen.
* The result is judged on the live field after the page has reacted: a recreated element, a mask or
  a refusal shows up in the report; Undo restores everything the fill actually changed, in fill
  order (dependent lists wait for their options), and counts only what was really restored.
* Tests: `test/e2e/origin.spec.js` (`[T13]`), `test/e2e/edge.spec.js`, `test/e2e/realworld.spec.js`.

### T14. Supply chain and package contents
* Zero runtime dependencies; dev dependencies (Playwright, React, Vue — for tests only) pinned to
  exact versions with `package-lock.json`; `npm audit` is clean (`npm run check`).
* The zip is built from `extension/` deterministically, contains only extension files, and the
  manifest is the release one (without the test overlay).
* Tests: `test/unit/supply-chain.test.js` (`[T14]`).

## Residual risks (outside the extension's control)

* The portal itself (same origin) sees the filled values — that is the point of filling.
* The user can knowingly confirm a fill on another site after the warning.
* A compromised browser or renderer, other extensions with broad permissions, malware.
* Visual tricks that keep the geometry (text colour = background colour, covering by another layer)
  are not fully detected; the main techniques (size, opacity, clipping, off-screen placement) are.
* Closed shadow DOM and cross-origin iframes are not supported (a limitation and a protection).
* Exported JSON is not encrypted: keep it like any other work document.

## Reporting a vulnerability

Open an issue at https://github.com/antalikra/FormDitto/issues asking for a private contact, without technical details. Please do not publish details until a fix is released.
