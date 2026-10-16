# Privacy practices tab — answers for the review form

## Single purpose

FormDitto fills repetitive web forms from templates the user saved. The user picks a variant, sees a preview and confirms each fill; the extension never submits forms.

## Permission justifications

**activeTab**
When the user clicks the FormDitto toolbar icon, FormDitto gets temporary access to that one tab so it can read the form fields the user wants to record and fill them after the user confirms. It does not access other tabs.

**scripting**
Injects the extension's own packaged script (`content/agent.js`) into the current tab only when the user records a template, opens a preview or fills a form. The script reads field labels and sets field values. No remote code is injected or executed.

**storage**
Saves the user's templates, variants and settings (interface language, theme, recording sync mode, wait timeout) in `chrome.storage.local` on the user's device. Nothing is synced or transmitted.

**sidePanel**
The user interface (templates, variants, preview, undo) is shown in the browser side panel, so it stays open next to the form while the user works.

**Host permissions (optional: `https://*/*`, `http://*/*`)**
Not granted at install. When the user clicks "Always allow on this site", FormDitto requests access to exactly that one site (for example `https://portal.example.com/*`) so the user does not have to click the toolbar icon on every visit to the same work portal. The user can remove it in FormDitto settings or in the browser's extension settings.

## Remote code

**No, I am not using remote code.** All JavaScript ships in the package. Extension pages use the CSP `default-src 'none'; script-src 'self'; connect-src 'none'; …`; there is no `eval`, no `new Function` and no remote scripts.

## Data usage

What user data do you plan to collect? Google's User Data FAQ says data handled only locally must still be disclosed, so tick:
- **Personally identifiable information** — variant values the user types (names, e-mail addresses, phone numbers, addresses).
- **Website content** — field labels, options and current values read from the form page.

Leave the other categories unticked: passwords, payment cards and one-time codes are never read; no history, location, communications or activity logs are stored. Everything stays in `chrome.storage.local` on the device and is never transmitted.

Certify all three disclosures:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: https://github.com/antalikra/FormDitto/blob/main/store/PRIVACY.md

## Test instructions for the reviewer

Credentials: leave empty. Additional instructions (the field takes at most 500 characters):

No login needed. 1) Open https://httpbin.org/forms/post 2) Click the FormDitto toolbar icon: the side panel opens. 3) Click "New template", then "Add all visible fields", type some values in the form, click "Save template". 4) Reload the page (click the icon again if the panel asks), click "Fill" next to "Variant 1", review the preview, click "Fill fields (N)". Fields are filled and highlighted; "Undo" restores them. The extension never submits forms.
