// Builds the Chrome Web Store assets from the real extension UI running on the local test portal:
//   store/icon-128.png, store/screenshot-1..5.png (1280×800), store/tile-440x280.png,
//   store/marquee-1400x560.png, store/demo.mp4 (30 s, H.264).
// The UI is captured with Playwright (Chromium + unpacked extension). Captions and frames are laid
// out in HTML/CSS and rendered by Playwright. The video is encoded with WebCodecs (H.264) in the
// installed Google Chrome and muxed into MP4 by scripts/lib/mp4.mjs.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, extensionCopyWithHosts } from './lib/ext-copy.mjs';
import { startTestServer } from '../test/server.mjs';
import { makeIcons } from './make-icons.mjs';
import { muxH264 } from './lib/mp4.mjs';

const STORE = path.join(ROOT, 'store');
const CAP = path.join(ROOT, '.tmp', 'captures');
const PORT = 5180;
const HOST_A = 'portal.stackwell.test';
const HOST_B = 'portal-stackwell.test';
const A = `http://${HOST_A}`;
const B = `http://${HOST_B}`;
const PAGE_W = 820;
const PANEL_W = 379;
const VIEW_H = 580;
const ICON = `http://127.0.0.1:${PORT}/ext-icons/icon-128.png`;

const VARIANTS = [
  ['Pump type A — Plant 1', { requester: 'Emily Carter', site: 'p1', equipment: 'cpump', model: 'CP-32/125', qty: '1', pump_type: 'A', priority: 'normal', due: '2026-11-04', address: 'Plant 1, Gate 1\nWorkshop 2', onsite: false }],
  ['Pump type B — Plant 2', null],
  ['Pump type C — Plant 2', { model: 'CP-65/200', qty: '3', pump_type: 'C', priority: 'high', due: '2026-11-12', description: 'Bearing noise on line 3, replace seal kit' }],
  ['Diaphragm pump D-20', { equipment: 'dpump', model: 'D-20', qty: '2', pump_type: 'B', description: 'Annual service' }],
  ['Compressor K-7 service', { equipment: 'comp', model: 'K-7', qty: '1', priority: 'low', onsite: true }],
  ['Conveyor belt repair', { equipment: 'conv', model: 'BX-1200', qty: '1', priority: 'high' }],
  ['Pump type B — urgent', { priority: 'high', due: '2026-10-20', onsite: true }],
  ['Warehouse A restock', { site: 'wa', department: 'log', equipment: 'cpump', qty: '6', onsite: false }],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------------------------------------
// 1. Capture the real UI

async function captureUI() {
  rmSync(CAP, { recursive: true, force: true });
  mkdirSync(CAP, { recursive: true });
  const ext = extensionCopyWithHosts('ext-store', [`${A}/*`, `${B}/*`]);
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    deviceScaleFactor: 2,
    viewport: { width: PAGE_W, height: VIEW_H },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=MAP ${HOST_A} 127.0.0.1:${PORT}, MAP ${HOST_B} 127.0.0.1:${PORT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const meta = {};

  const tabIdOf = (page) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, page.url());
  const openPanel = async (page) => {
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: PANEL_W, height: VIEW_H });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdOf(page)}`);
    await panel.waitForSelector('body[data-ready="1"]');
    return panel;
  };
  const center = async (locator) => {
    const b = await locator.boundingBox();
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  };
  const shot = async (name, page, panel, extra = {}) => {
    await page.bringToFront();
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(250);
    writeFileSync(path.join(CAP, `${name}-page.png`), await page.screenshot());
    await panel.bringToFront();
    // No hover state left over from the last click in the panel.
    await panel.mouse.move(1, 1);
    await sleep(150);
    writeFileSync(path.join(CAP, `${name}-panel.png`), await panel.screenshot());
    meta[name] = { url: page.url(), ...extra };
  };

  const page = await ctx.newPage();
  await page.goto(`${A}/portal.html`);
  await page.fill('#requester', 'Emily Carter');
  await page.fill('#email', 'emily.carter@stackwell.test');
  await page.fill('#phone', '+1 555 0100');
  await page.selectOption('#department', 'mnt');
  await page.selectOption('#site', 'p2');
  await page.selectOption('#equipment', 'cpump');
  await page.fill('#model', 'CP-40/160');
  await page.fill('#qty', '2');
  await page.check('input[name="pump_type"][value="B"]');
  await page.check('input[name="priority"][value="normal"]');
  await page.fill('#due', '2026-11-20');
  await page.fill('#costcenter', 'CC-4410');
  await page.fill('#contact', 'Mark Lee, shift lead');
  await page.fill('#address', 'Plant 2, Gate 3\nDock 4');
  await page.fill('#description', 'Pump vibrates at full load, check impeller');
  await page.check('#onsite');

  let panel = await openPanel(page);
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-add-all').click();
  await panel.getByTestId('tpl-name').fill('Service request');
  await panel.getByTestId('variant-name').fill('Pump type B — Plant 2');
  await panel.getByTestId('rec-save').click();
  await panel.getByTestId('tpl-title').waitFor();

  // More variants, derived from the recorded one (as an operator would build them over time).
  await sw.evaluate(async (variants) => {
    const all = await chrome.storage.local.get(null);
    const [key, tpl] = Object.entries(all).find(([k]) => k.startsWith('tpl:'));
    const base = tpl.variants[0].values;
    const byName = Object.fromEntries(tpl.fields.map((f) => [f.locator.name, f.id]));
    tpl.variants = variants.map(([name, patch], i) => {
      if (!patch) return { ...tpl.variants[0], name };
      const values = { ...base };
      for (const [n, v] of Object.entries(patch)) values[byName[n]] = v;
      return { id: `v${i}x${Date.now().toString(36)}`, name, updatedAt: Date.now(), values };
    });
    await chrome.storage.local.set({ [key]: tpl });
  }, VARIANTS);

  await page.reload();
  // Radio groups usually come with a default choice; undo can put a choice back, but cannot clear a
  // group that had none (README, limitations), so the demo form starts like a real one.
  await page.check('input[name="pump_type"][value="A"]');
  await page.check('input[name="priority"][value="normal"]');
  await panel.reload();
  await panel.waitForSelector('body[data-ready="1"]');
  await panel.getByTestId('template-card').click();
  const rowC = panel.getByTestId('variant').filter({ hasText: 'Pump type C — Plant 2' });
  await shot('k2', page, panel, { cursor: { space: 'panel', at: await center(rowC.getByTestId('variant-fill')) } });

  await panel.getByTestId('search-variants').fill('pump type');
  await shot('s3', page, panel);
  await panel.getByTestId('search-variants').fill('');

  await rowC.getByTestId('variant-fill').click();
  await panel.getByTestId('preview-table').waitFor();
  await shot('k3', page, panel, { cursor: { space: 'panel', at: await center(panel.getByTestId('fill-confirm')) } });

  await panel.getByTestId('fill-confirm').click();
  await panel.getByTestId('result-stats').waitFor();
  await shot('k4', page, panel, { cursor: { space: 'panel', at: await center(panel.getByTestId('undo')) } });

  await panel.getByTestId('undo').click();
  await panel.getByTestId('done').waitFor();
  await shot('k5', page, panel);
  await panel.getByTestId('done').click();
  await panel.getByTestId('back').click();

  // Recording a new template by clicking fields.
  await page.reload();
  await panel.getByTestId('new-template').click();
  await panel.getByTestId('rec-save').waitFor();
  const recTargets = ['#requester', '#email', '#department', '#equipment', '#model'];
  const pos = [];
  for (const sel of recTargets) pos.push(await center(page.locator(sel)));
  await shot('k6', page, panel, { cursor: { space: 'page', at: pos[0] } });
  await page.click(recTargets[0]);
  await shot('k7', page, panel, { cursor: { space: 'page', at: pos[1] } });
  await page.click(recTargets[1]);
  await shot('k8', page, panel, { cursor: { space: 'page', at: pos[2] } });
  await page.click(recTargets[2]);
  await page.hover(recTargets[3]);
  await shot('k9', page, panel, { cursor: { space: 'page', at: pos[3] } });
  await page.click(recTargets[3]);
  await page.hover(recTargets[4]);
  await shot('s4', page, panel);
  await panel.getByTestId('rec-cancel').click();

  // The same portal on a look-alike host.
  const fake = await ctx.newPage();
  await fake.goto(`${B}/portal.html`);
  const fakePanel = await openPanel(fake);
  await fakePanel.locator('details.others summary').click();
  await fakePanel.getByTestId('template-card').click();
  await fakePanel.getByTestId('variant').filter({ hasText: 'Pump type B — Plant 2' }).getByTestId('variant-fill').click();
  await fakePanel.getByTestId('origin-warning').waitFor();
  await shot('k10', fake, fakePanel, { cursor: { space: 'panel', at: await center(fakePanel.getByTestId('mismatch-ack')) } });

  // Hero shot: filled form with highlights and the result panel.
  await page.reload();
  await panel.getByTestId('template-card').click();
  await panel.getByTestId('variant').filter({ hasText: 'Pump type B — Plant 2' }).getByTestId('variant-fill').click();
  await panel.getByTestId('fill-confirm').click();
  await panel.getByTestId('result-stats').waitFor();
  await shot('s1', page, panel);

  writeFileSync(path.join(CAP, 'meta.json'), JSON.stringify(meta, null, 2));
  await ctx.close();
  return meta;
}

// ---------------------------------------------------------------------------------------------
// 2. Layouts (HTML/CSS) rendered by Playwright

const FONT = "'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";

function browserWindow(name, meta, { left, top }) {
  const url = new URL(meta[name].url);
  return `
  <div class="win" style="left:${left}px;top:${top}px">
    <div class="bar">
      <span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>
      <span class="nav">&#8592;&nbsp;&nbsp;&#8594;&nbsp;&nbsp;&#8635;</span>
      <span class="url"><span class="lock">&#9432;</span>${esc(url.host)}<span class="path">${esc(url.pathname)}</span></span>
      <img class="ext" src="${ICON}" alt="">
    </div>
    <div class="body">
      <img class="page" src="/captures/${name}-page.png" alt="">
      <img class="panel" src="/captures/${name}-panel.png" alt="">
    </div>
  </div>`;
}

const WINDOW_CSS = `
  .win{position:absolute;width:1200px;height:624px;border-radius:12px;overflow:hidden;background:#fff;
       box-shadow:0 28px 70px rgba(15,23,42,.28),0 0 0 1px rgba(15,23,42,.10)}
  .bar{height:44px;display:flex;align-items:center;gap:14px;padding:0 14px;background:#e8ecf2;border-bottom:1px solid #d3d9e3}
  .dots i{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:7px}
  .nav{color:#64748b;font-size:15px;letter-spacing:1px}
  .url{flex:1;height:28px;border-radius:14px;background:#fff;display:flex;align-items:center;padding:0 14px;font-size:13.5px;color:#0f172a}
  .url .lock{color:#94a3b8;margin-right:8px}
  .url .path{color:#64748b}
  .ext{width:22px;height:22px;border-radius:5px;outline:2px solid #5c60db;outline-offset:3px}
  .body{display:flex;height:580px}
  .page{width:${PAGE_W}px;height:${VIEW_H}px;display:block}
  .panel{width:${PANEL_W}px;height:${VIEW_H}px;display:block;border-left:1px solid #d3d9e3}`;

function screenshotHtml(name, meta, title, sub) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:${FONT}}
  body{background:radial-gradient(1200px 500px at 0% 0%,#e2e1ff 0%,transparent 60%),radial-gradient(900px 500px at 100% 0%,#f1e6ff 0%,transparent 55%),#f4f3f8}
  .cap{position:absolute;left:56px;top:30px;right:56px;display:flex;align-items:flex-start;gap:24px}
  .cap .txt{flex:1}
  h1{margin:0;font-size:38px;line-height:1.12;color:#101016;letter-spacing:-.02em;font-weight:800}
  p{margin:10px 0 0;font-size:18.5px;line-height:1.4;color:#3b4658;max-width:980px}
  .badge{white-space:nowrap;margin-top:6px;padding:7px 14px;border-radius:999px;background:#101016;color:#fff;font-size:13px;font-weight:600}
  ${WINDOW_CSS}
  </style></head><body>
  <div class="cap"><div class="txt"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="badge">Free · Local-only</div></div>
  ${browserWindow(name, meta, { left: 40, top: 160 })}
  </body></html>`;
}

function stageHtml(name, meta, caption) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:${FONT};background:#eef2f8}
  ${WINDOW_CSS}
  .cap{position:absolute;left:0;right:0;bottom:0;height:72px;display:flex;align-items:center;justify-content:center;
       font-size:25px;font-weight:700;color:#101016;letter-spacing:-.01em}
  .cap b{color:#5c60db}
  </style></head><body>
  ${browserWindow(name, meta, { left: 40, top: 22 })}
  <div class="cap"><span>${caption}</span></div>
  </body></html>`;
}

function cardHtml(kind) {
  const title = kind === 'start' ? 'FormDitto' : 'FormDitto — free form filler';
  const sub = kind === 'start' ? 'Fill repetitive web forms in one click' : 'Local-only · No account · No subscription';
  const extra = kind === 'start' ? 'Templates · Variants · Preview · Undo' : 'Never fills passwords, cards or hidden fields · Never submits';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:${FONT}}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#fff;
       background:linear-gradient(135deg,#6266ef 0%,#5054d6 60%,#3b3d9e 100%)}
  img{width:128px;height:128px;background:#fff;border-radius:34px;padding:6px;box-shadow:0 14px 34px rgba(0,0,0,.3)}
  h1{margin:0;font-size:64px;font-weight:800;letter-spacing:-.03em}
  p{margin:0;font-size:30px;font-weight:600;opacity:.95}
  small{font-size:20px;opacity:.8}
  </style></head><body><img src="${ICON}" alt=""><h1>${esc(title)}</h1><p>${esc(sub)}</p><small>${esc(extra)}</small></body></html>`;
}

function tileHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:440px;height:280px;overflow:hidden;font-family:${FONT}}
  body{display:flex;align-items:center;gap:20px;padding:0 30px;box-sizing:border-box;color:#101016;
       background:radial-gradient(420px 260px at 0% 0%,#e2e1ff 0%,transparent 70%),linear-gradient(135deg,#f8f7fc 0%,#efeefe 100%)}
  img{width:112px;height:112px;flex:none;filter:drop-shadow(0 10px 18px rgba(92,96,219,.3))}
  h1{margin:0;font-size:38px;font-weight:800;letter-spacing:-.02em}
  p{margin:8px 0 0;font-size:19px;line-height:1.3;font-weight:600;color:#334155}
  </style></head><body><img src="${ICON}" alt=""><div><h1>FormDitto</h1><p>Fill repetitive forms<br>in one click</p></div></body></html>`;
}

function marqueeHtml(meta) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1400px;height:560px;overflow:hidden;font-family:${FONT}}
  body{color:#fff;background:linear-gradient(120deg,#6266ef 0%,#5054d6 55%,#34358c 100%)}
  .left{position:absolute;left:64px;top:84px;width:470px}
  .brand{display:flex;align-items:center;gap:16px}
  .brand img{width:76px;height:76px;background:#fff;border-radius:22px;padding:4px;box-shadow:0 10px 24px rgba(0,0,0,.25)}
  h1{margin:0;font-size:52px;font-weight:800;letter-spacing:-.03em}
  h2{margin:26px 0 22px;font-size:30px;line-height:1.2;font-weight:700}
  ul{margin:0;padding:0;list-style:none;font-size:20px;line-height:1.9;opacity:.95}
  li::before{content:"✓";display:inline-block;width:30px;color:#fbbf24;font-weight:800}
  .shot{position:absolute;left:556px;top:68px;transform:scale(.68);transform-origin:0 0}
  ${WINDOW_CSS}
  </style></head><body>
  <div class="left"><div class="brand"><img src="${ICON}" alt=""><h1>FormDitto</h1></div>
  <h2>Fill repetitive web forms<br>in one click</h2>
  <ul><li>Templates with dozens of variants</li><li>Preview, highlight and undo</li><li>Local-only: no account, no subscription</li></ul></div>
  <div class="shot">${browserWindow('s1', meta, { left: 0, top: 0 })}</div>
  </body></html>`;
}

async function render(browser, html, file, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/health`);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all(Array.from(document.images, (i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))));
  writeFileSync(file, await page.screenshot({ clip: { x: 0, y: 0, width, height } }));
  await page.close();
}

// ---------------------------------------------------------------------------------------------
// 3. Video: keyframes + cursor animation, H.264 via WebCodecs, MP4 via scripts/lib/mp4.mjs

const STAGE = { left: 40, top: 22 + 44 };
const toStage = (cursor) => (cursor.space === 'page' ? [STAGE.left + cursor.at[0], STAGE.top + cursor.at[1]] : [STAGE.left + PAGE_W + 1 + cursor.at[0], STAGE.top + cursor.at[1]]);

function timeline(meta) {
  // [image, start (s), caption, click?]
  const segs = [
    { img: 'card-start', start: 0 },
    { img: 'k2', start: 2.6, click: true },
    { img: 'k3', start: 6.2, click: true },
    { img: 'k4', start: 9.8, click: true },
    { img: 'k5', start: 13.8 },
    { img: 'k6', start: 15.6, click: true },
    { img: 'k7', start: 17.4, click: true },
    { img: 'k8', start: 18.7, click: true },
    { img: 'k9', start: 20.0 },
    { img: 'k10', start: 22.4 },
    { img: 'card-end', start: 26.8 },
  ];
  let last = [900, 520];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const end = i + 1 < segs.length ? segs[i + 1].start : 30;
    const m = meta[s.img];
    if (m && m.cursor) {
      const to = toStage(m.cursor);
      const moveStart = s.start + 0.45;
      const clickAt = s.click ? end - 0.3 : null;
      const moveEnd = s.click ? clickAt - 0.25 : Math.min(end - 0.4, moveStart + 1.3);
      s.cursor = { from: last, to, moveStart, moveEnd, click: clickAt };
      last = to;
    } else if (m) {
      s.cursor = { from: last, to: last, moveStart: s.start, moveEnd: s.start + 0.01, click: null };
    }
  }
  return segs;
}

const ENCODER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>encoder</title></head><body><script>
window.encodeDemo = async (segs, W, H, FPS, SECONDS) => {
  const names = [...new Set(segs.map((s) => s.img))];
  const imgs = {};
  for (const n of names) imgs[n] = await createImageBitmap(await (await fetch('/captures/stage-' + n + '.png')).blob());
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d');
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  function pointer(x, y) {
    g.save();
    g.translate(x, y);
    g.scale(1.35, 1.35);
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(0, 17); g.lineTo(4.2, 13); g.lineTo(7, 19.5); g.lineTo(9.6, 18.4); g.lineTo(6.9, 12.2); g.lineTo(12.3, 12.2); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 1.3; g.strokeStyle = '#111'; g.stroke();
    g.restore();
  }
  function draw(t) {
    let i = 0;
    while (i + 1 < segs.length && t >= segs[i + 1].start) i++;
    const s = segs[i];
    g.globalAlpha = 1;
    g.drawImage(imgs[s.img], 0, 0, W, H);
    const fade = 0.35;
    if (i > 0 && t - s.start < fade) {
      g.globalAlpha = 1 - ease(clamp((t - s.start) / fade));
      g.drawImage(imgs[segs[i - 1].img], 0, 0, W, H);
      g.globalAlpha = 1;
    }
    const c = s.cursor;
    if (!c) return;
    const p = ease(clamp((t - c.moveStart) / Math.max(0.01, c.moveEnd - c.moveStart)));
    const x = c.from[0] + (c.to[0] - c.from[0]) * p;
    const y = c.from[1] + (c.to[1] - c.from[1]) * p;
    if (c.click !== null && t >= c.click && t < c.click + 0.5) {
      const q = (t - c.click) / 0.5;
      g.beginPath();
      g.arc(x, y, 8 + 26 * q, 0, Math.PI * 2);
      g.fillStyle = 'rgba(98,102,239,' + (0.35 * (1 - q)) + ')';
      g.fill();
    }
    pointer(x, y);
  }
  const chunks = [];
  let description = null;
  let failure = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push({ ts: chunk.timestamp, key: chunk.type === 'key', data: b });
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !description) description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
    },
    error: (e) => { failure = e.message; },
  });
  enc.configure({ codec: 'avc1.42e01f', width: W, height: H, bitrate: 6000000, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality', hardwareAcceleration: 'prefer-software' });
  const N = FPS * SECONDS;
  for (let i = 0; i < N; i++) {
    draw(i / FPS);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
  }
  await enc.flush();
  enc.close();
  if (failure) throw new Error(failure);
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  return { description: b64(description), chunks: chunks.map((c) => ({ ts: c.ts, key: c.key, data: b64(c.data) })) };
};
window.checkVideo = async (src) => {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video error ' + (v.error && v.error.message))); });
  const brightness = async (t) => {
    v.currentTime = t;
    await new Promise((r) => { v.onseeked = r; });
    await new Promise((r) => setTimeout(r, 250));
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, 64, 36);
    const px = g.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return Math.round(sum / (px.length / 4) / 3);
  };
  document.body.append(v);
  return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, titleCard: await brightness(1), uiScene: await brightness(12) };
};
</script></body></html>`;

async function makeVideo(meta, composer) {
  const W = 1280;
  const H = 720;
  const FPS = 30;
  const SECONDS = 30;
  const captions = {
    k2: 'Pick a saved <b>variant</b> in the side panel',
    k3: '<b>Preview</b> which field gets which value',
    k4: 'One click fills the form — <b>you</b> review and submit',
    k5: 'Changed your mind? <b>Undo</b> restores every field',
    k6: 'New form? <b>Record</b> a template by clicking fields',
    k7: 'New form? <b>Record</b> a template by clicking fields',
    k8: 'New form? <b>Record</b> a template by clicking fields',
    k9: 'New form? <b>Record</b> a template by clicking fields',
    k10: 'Look-alike site? FormDitto <b>warns</b> before filling',
  };
  for (const [name, caption] of Object.entries(captions)) await render(composer, stageHtml(name, meta, caption), path.join(CAP, `stage-${name}.png`), W, H);
  await render(composer, cardHtml('start'), path.join(CAP, 'stage-card-start.png'), W, H);
  await render(composer, cardHtml('end'), path.join(CAP, 'stage-card-end.png'), W, H);
  writeFileSync(path.join(CAP, 'encoder.html'), ENCODER_HTML);

  // Google Chrome ships an H.264 encoder (Playwright's Chromium build does not).
  const chrome = await chromium.launch({ channel: 'chrome' });
  const page = await chrome.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/captures/encoder.html`);
  const out = await page.evaluate(({ segs, W: w, H: h, FPS: fps, SECONDS: sec }) => window.encodeDemo(segs, w, h, fps, sec), { segs: timeline(meta), W, H, FPS, SECONDS });
  const samples = out.chunks.map((c) => ({ ts: c.ts, key: c.key, data: Buffer.from(c.data, 'base64') }));
  for (let i = 1; i < samples.length; i++) if (samples[i].ts <= samples[i - 1].ts) throw new Error('encoder produced out-of-order frames');
  if (samples.length !== FPS * SECONDS) throw new Error(`expected ${FPS * SECONDS} frames, got ${samples.length}`);
  const mp4 = muxH264({ width: W, height: H, fps: FPS, avcC: Buffer.from(out.description, 'base64'), samples });
  const file = path.join(STORE, 'demo.mp4');
  writeFileSync(file, mp4);
  writeFileSync(path.join(CAP, 'demo.mp4'), mp4);
  const check = await page.evaluate(() => window.checkVideo('/captures/demo.mp4'));
  await chrome.close();
  // The title card (blue) and a UI scene (light) must differ: proves the file decodes and seeks.
  if (Math.abs(check.duration - SECONDS) > 0.1 || check.width !== W || check.height !== H || check.uiScene - check.titleCard < 60) throw new Error(`video check failed: ${JSON.stringify(check)}`);
  return { file, bytes: mp4.length, ...check };
}

// ---------------------------------------------------------------------------------------------

const SCREENSHOTS = [
  ['s1', 'Fill an 18-field request in one click', 'Pick a saved variant: FormDitto fills text, lists, checkboxes, radio buttons and dates, then highlights every field it changed.'],
  ['k3', 'Preview before anything changes', 'See each field with its current and new value. Lists and fields that load later are waited for automatically.'],
  ['s3', 'Dozens of variants per form, found in a keystroke', 'Pump type B, Pump type C, urgent orders… Search, copy and edit variants right in the side panel.'],
  ['s4', 'Create a template by clicking fields', 'No rules or selectors to write. Works with React and Vue forms, same-site iframes and web components.'],
  ['k10', 'Private and careful by design', 'Data stays on your device. Warns on look-alike sites. Never touches passwords, cards or hidden fields, and never submits a form.'],
];

async function main() {
  const server = await startTestServer({ port: PORT, mounts: { '/captures/': CAP, '/ext-icons/': path.join(ROOT, 'extension/icons') } });
  try {
    const composer = await chromium.launch();
    await makeIcons(composer);
    const meta = await captureUI();
    for (const [i, [name, title, sub]] of SCREENSHOTS.entries()) {
      await render(composer, screenshotHtml(name, meta, title, sub), path.join(STORE, `screenshot-${i + 1}.png`), 1280, 800);
    }
    await render(composer, tileHtml(), path.join(STORE, 'tile-440x280.png'), 440, 280);
    await render(composer, marqueeHtml(meta), path.join(STORE, 'marquee-1400x560.png'), 1400, 560);
    const video = await makeVideo(meta, composer);
    await composer.close();
    console.log('store assets written to store/:', JSON.stringify(video));
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
