// Options and fields that appear after a delay, like lists loaded from a server.
const CITIES = { north: ['Northfield', 'Lakeview', 'Pinecrest'], south: ['Southport', 'Riverbend', 'Sunvale'] };
const delay = Number(new URLSearchParams(location.search).get('delay') || 900);

function setOptions(select, items, placeholder) {
  select.replaceChildren(new Option(placeholder, ''), ...items.map(([v, t]) => new Option(t, v)));
}

const region = document.getElementById('region');
const city = document.getElementById('city');
region.addEventListener('change', () => {
  city.disabled = true;
  setOptions(city, [], 'Loading…');
  const list = CITIES[region.value] || [];
  setTimeout(() => {
    setOptions(city, list.map((c) => [c.toLowerCase(), c]), 'Choose…');
    city.disabled = !list.length;
  }, delay);
});

setTimeout(() => {
  setOptions(document.getElementById('product'), [['p-100', 'Pump P-100'], ['p-200', 'Pump P-200'], ['v-10', 'Valve V-10']], 'Choose…');
}, delay + 300);

document.getElementById('express').addEventListener('change', (e) => {
  document.getElementById('courierBox').classList.toggle('hidden-section', !e.target.checked);
});

setTimeout(() => {
  const slot = document.getElementById('lateSlot');
  const label = document.createElement('label');
  label.htmlFor = 'batch';
  label.textContent = 'Batch number';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'batch';
  input.name = 'batch';
  slot.append(label, input);
}, delay + 600);
