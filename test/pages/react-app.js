// React 18 form with controlled inputs. <pre id="state"> shows React state, not DOM values.
const e = React.createElement;

function App() {
  const [s, set] = React.useState({ fullName: '', email: '', plan: '', tier: '', agree: false, startDate: '', notes: '' });
  const upd = (k) => (ev) => {
    const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    set((p) => ({ ...p, [k]: v }));
  };
  const field = (label, input) => e('div', { className: 'f' }, e('label', { htmlFor: input.props.id }, label), input);
  return e('form', { className: 'card', onSubmit: (ev) => ev.preventDefault() },
    e('h1', null, 'React controlled form'),
    e('div', { className: 'grid' },
      field('Full name', e('input', { id: 'fullName', name: 'fullName', type: 'text', value: s.fullName, onChange: upd('fullName') })),
      field('Email', e('input', { id: 'remail', name: 'email', type: 'email', value: s.email, onChange: upd('email') })),
      field('Plan', e('select', { id: 'plan', name: 'plan', value: s.plan, onChange: upd('plan') },
        e('option', { value: '' }, 'Choose…'), e('option', { value: 'basic' }, 'Basic'), e('option', { value: 'team' }, 'Team'), e('option', { value: 'enterprise' }, 'Enterprise'))),
      field('Start date', e('input', { id: 'startDate', name: 'startDate', type: 'date', value: s.startDate, onChange: upd('startDate') })),
      e('div', { className: 'f' }, e('span', { className: 'lbl', id: 'tierLbl' }, 'Support tier'),
        e('div', { className: 'opts', role: 'radiogroup', 'aria-labelledby': 'tierLbl' },
          ['standard', 'priority'].map((v) => e('label', { key: v }, e('input', { type: 'radio', name: 'tier', value: v, checked: s.tier === v, onChange: upd('tier') }), ' ', v)))),
      e('div', { className: 'f checks' }, e('label', null, e('input', { id: 'agree', name: 'agree', type: 'checkbox', checked: s.agree, onChange: upd('agree') }), ' I accept the service terms')),
      e('div', { className: 'f wide' }, e('label', { htmlFor: 'notes' }, 'Notes'), e('textarea', { id: 'notes', name: 'notes', value: s.notes, onChange: upd('notes') }))),
    e('div', { className: 'bar' }, e('button', { type: 'submit', className: 'primary' }, 'Send')),
    e('pre', { id: 'state' }, JSON.stringify(s)));
}

ReactDOM.createRoot(document.getElementById('root')).render(e(App));
