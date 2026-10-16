// Vue 3 form with v-model directives applied through render functions (no runtime template
// compiler, so the page works under a CSP without 'unsafe-eval').
const { createApp, reactive, h, vModelText, vModelSelect, vModelCheckbox, vModelRadio, withDirectives } = Vue;

createApp({
  setup() {
    const s = reactive({ company: '', city: '', size: '', billing: '', newsletter: false, visit: '', comment: '' });
    const model = (key) => ({ 'onUpdate:modelValue': (v) => { s[key] = v; } });
    return () => h('form', { class: 'card', onSubmit: (ev) => ev.preventDefault() }, [
      h('h1', 'Vue v-model form'),
      h('div', { class: 'grid' }, [
        h('div', { class: 'f' }, [h('label', { for: 'company' }, 'Company'), withDirectives(h('input', { id: 'company', name: 'company', type: 'text', ...model('company') }), [[vModelText, s.company]])]),
        h('div', { class: 'f' }, [h('label', { for: 'vcity' }, 'City'), withDirectives(h('input', { id: 'vcity', name: 'city', type: 'text', ...model('city') }), [[vModelText, s.city, undefined, { lazy: true }]])]),
        h('div', { class: 'f' }, [h('label', { for: 'size' }, 'Company size'), withDirectives(h('select', { id: 'size', name: 'size', ...model('size') }, [
          h('option', { value: '' }, 'Choose…'), h('option', { value: 's' }, '1–10'), h('option', { value: 'm' }, '11–200'), h('option', { value: 'l' }, '200+'),
        ]), [[vModelSelect, s.size]])]),
        h('div', { class: 'f' }, [h('label', { for: 'visit' }, 'Visit date'), withDirectives(h('input', { id: 'visit', name: 'visit', type: 'date', ...model('visit') }), [[vModelText, s.visit]])]),
        h('div', { class: 'f' }, [h('span', { class: 'lbl', id: 'billLbl' }, 'Billing'), h('div', { class: 'opts', role: 'radiogroup', 'aria-labelledby': 'billLbl' },
          ['monthly', 'yearly'].map((v) => h('label', [withDirectives(h('input', { type: 'radio', name: 'billing', value: v, ...model('billing') }), [[vModelRadio, s.billing]]), ` ${v}`])))]),
        h('div', { class: 'f checks' }, [h('label', [withDirectives(h('input', { id: 'newsletter', name: 'newsletter', type: 'checkbox', ...model('newsletter') }), [[vModelCheckbox, s.newsletter]]), ' Subscribe to newsletter'])]),
        h('div', { class: 'f wide' }, [h('label', { for: 'comment' }, 'Comment'), withDirectives(h('textarea', { id: 'comment', name: 'comment', ...model('comment') }), [[vModelText, s.comment]])]),
      ]),
      h('div', { class: 'bar' }, [h('button', { type: 'submit', class: 'primary' }, 'Send')]),
      h('pre', { id: 'state' }, JSON.stringify(s)),
    ]);
  },
}).mount('#app');
