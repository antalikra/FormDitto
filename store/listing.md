# Chrome Web Store listing — FormDitto

Copy these fields into the Developer Dashboard → **Store listing**.

| Field | Value |
|---|---|
| Name (from manifest) | FormDitto: Form Filler & Autofill Templates |
| Summary (≤ 132 chars, from manifest) | Fill repetitive web forms in one click from saved templates. Local-only form filler: no account, no subscription. |
| Category | Workflow & Planning |
| Language | English. The UI is localized into 14 languages; add the other languages as described below |
| Icon | `store/icon-128.png` |
| Screenshots (1280×800) | `store/screenshot-1.png` … `store/screenshot-5.png` (in this order) |
| Small promo tile (440×280) | `store/tile-440x280.png` |
| Marquee promo tile (1400×560) | `store/marquee-1400x560.png` |
| Promo video | YouTube link only (the field does not accept files or other hosts). Leave empty, or upload `store/demo.mp4` to YouTube as Unlisted and paste the link |
| Homepage / support URL | your project page or support e-mail |

## Description

FormDitto is a form filler for people who submit the same kind of web form every day: service requests, orders, tickets, registrations. Save the form once as a template, keep a variant for every case ("Pump type B", "Pump type C"…), and fill the whole form in one click.

HOW IT WORKS
1. Open your form and click the FormDitto icon. The side panel opens next to the page.
2. Click "New template", click the fields you need (or "Add all visible fields") and type their values.
3. Those values become your first variant. Add more variants, copy and edit them in the panel.
4. Next time: pick a variant, check the preview, click "Fill". Changed fields are highlighted, and "Undo" restores the previous values.

WHAT IT FILLS
• Text, e-mail, phone and number fields, text areas
• Drop-down lists, checkboxes, radio buttons, dates
• React and Vue forms (controlled inputs receive real input and change events)
• Lists and fields that load later: FormDitto waits for them, with a timeout
• Same-site iframes and web components (open shadow DOM)

PRIVATE AND CAREFUL BY DESIGN
• Templates stay in your browser on this device. No account, no server, no analytics, no network requests.
• Access is requested for one site at a time, only when you allow it.
• Each template is tied to the site where you recorded it. On any other site, for example a look-alike copy of your portal, FormDitto shows a clear warning before anything is filled.
• Never records or fills passwords, payment card fields or hidden fields.
• Never submits a form. You review it and click Submit yourself.

IMPORT AND EXPORT
Move templates to another computer or share them with colleagues as a JSON file. Imported files are checked strictly.

FREE
The autofill templates, variants, preview and undo are free. No subscription.

Available in 14 languages. Works in Google Chrome and Microsoft Edge 116 or newer.

## Other languages

The package ships 14 locales (`extension/_locales`): en, ru, uk, de, fr, es, pt_BR, it, pl, nl, tr, ja, zh_CN, ko. The store takes the **name** and **summary** for each language from the package automatically. The **description** is entered per language:

- Chrome Web Store: Store listing → language selector next to the title → add a language → paste `store/descriptions/<locale>.txt`. Screenshots and tiles can stay the same (English UI) for all languages.
- Edge Add-ons: Store listings → each language from the package gets its own row → paste the same file; the description must be at least 250 characters (all of them are), and the logo (`store/logo-300.png`) can be duplicated to all languages with one click.

The English description above is the same text as `store/descriptions/en.txt`.
