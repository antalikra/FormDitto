// Counts submit attempts so tests can prove the extension never submits a form.
window.__submits = 0;
document.addEventListener('submit', (e) => {
  e.preventDefault();
  window.__submits += 1;
  const s = document.getElementById('submits');
  if (s) s.textContent = `Submitted ${window.__submits} time(s)`;
}, true);
