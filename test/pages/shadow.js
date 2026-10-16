// Fields inside open shadow roots (supported), nested shadow roots and a closed shadow root (ignored).
function field(root, id, label, type = 'text') {
  const wrap = document.createElement('div');
  wrap.className = 'f';
  const l = document.createElement('label');
  l.htmlFor = id;
  l.textContent = label;
  const i = document.createElement('input');
  i.type = type;
  i.id = id;
  i.name = id;
  wrap.append(l, i);
  root.append(wrap);
  return i;
}

function sheet(root) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'form.css';
  root.append(link);
}

class XZip extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    sheet(root);
    field(root, 'zip', 'ZIP code');
  }
}

class XAddress extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    sheet(root);
    const grid = document.createElement('div');
    grid.className = 'grid';
    root.append(grid);
    field(grid, 'street', 'Street');
    field(grid, 'city', 'City');
    grid.append(document.createElement('x-zip'));
  }
}

class XSecretBox extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = '1';
    const root = this.attachShadow({ mode: 'closed' });
    sheet(root);
    field(root, 'closed_note', 'Closed shadow note');
  }
}

customElements.define('x-zip', XZip);
customElements.define('x-address', XAddress);
customElements.define('x-secret-box', XSecretBox);
