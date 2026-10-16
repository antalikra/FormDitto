// Behaviours of real sites, written plainly (no framework): each one is something FormDitto meets in
// the wild. Counters on window let tests check what the page saw.

// Phone mask: keeps digits only and formats them as +7 (XXX) XXX-XX-XX while typing.
const phone = document.getElementById('phone');
phone.addEventListener('input', () => {
  let d = phone.value.replace(/\D/g, '');
  if (d.startsWith('7') || d.startsWith('8')) d = d.slice(1);
  d = d.slice(0, 10);
  const p = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
  let out = '+7';
  if (p[0]) out += ` (${p[0]}`;
  if (p[0].length === 3) out += ')';
  if (p[1]) out += ` ${p[1]}`;
  if (p[2]) out += `-${p[2]}`;
  if (p[3]) out += `-${p[3]}`;
  phone.value = d ? out : '';
});

// Upper case as you type; trimming on blur.
const plate = document.getElementById('plate');
plate.addEventListener('input', () => { plate.value = plate.value.toUpperCase(); });
plate.addEventListener('blur', () => { plate.value = plate.value.trim(); });

// Digits only: anything else is dropped.
const inn = document.getElementById('inn');
inn.addEventListener('input', () => { inn.value = inn.value.replace(/\D/g, ''); });

// A section re-rendered with new elements whenever the customer type changes (keyed component).
const section = document.getElementById('typeSection');
window.__renders = 0;
function renderType() {
  window.__renders += 1;
  const type = document.querySelector('input[name="ctype"]:checked').value;
  const f = (id, label, type2 = 'text') => {
    const wrap = document.createElement('div');
    wrap.className = 'f';
    const l = document.createElement('label');
    l.htmlFor = id;
    l.textContent = label;
    const i = document.createElement('input');
    i.type = type2;
    i.id = id;
    i.name = id;
    wrap.append(l, i);
    return wrap;
  };
  section.replaceChildren(...(type === 'company' ? [f('company', 'Company name'), f('vat', 'VAT ID')] : [f('first', 'First name'), f('last', 'Last name')]));
}
for (const r of document.querySelectorAll('input[name="ctype"]')) r.addEventListener('change', renderType);
renderType();

// The custom list keeps the hidden native select in sync (as select2 does on "change").
const manager = document.getElementById('manager');
const shown = document.getElementById('mgrShown');
const wrap = document.getElementById('mgrWrap');
manager.addEventListener('change', () => { shown.textContent = manager.selectedOptions[0].textContent; });
shown.addEventListener('click', () => {
  const old = wrap.querySelector('ul');
  if (old) return old.remove();
  const ul = document.createElement('ul');
  for (const o of manager.options) {
    if (!o.value) continue;
    const li = document.createElement('li');
    li.textContent = o.textContent;
    li.addEventListener('click', () => { manager.value = o.value; manager.dispatchEvent(new Event('change', { bubbles: true })); ul.remove(); });
    ul.append(li);
  }
  wrap.append(ul);
});

// SPA steps: no page load, only the URL and the visible step change.
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
function showStep(n, push) {
  step1.hidden = n !== 1;
  step2.hidden = n !== 2;
  if (push) history.pushState({ step: n }, '', `${location.pathname}?step=${n}`);
}
document.getElementById('next').addEventListener('click', () => showStep(2, true));
document.getElementById('prev').addEventListener('click', () => showStep(1, true));
window.addEventListener('popstate', (e) => showStep((e.state && e.state.step) || 1, false));

// A modal dialog (top layer).
const dlg = document.getElementById('billing');
document.getElementById('openDialog').addEventListener('click', () => dlg.showModal());
