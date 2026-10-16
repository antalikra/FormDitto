// The second iframe is loaded from the other test host, so it is a different origin.
const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
document.getElementById('foreign').src = `http://${other}:${location.port}/frame-foreign.html`;
