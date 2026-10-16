// Checks the store assets produced by `npm run store`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../store');
const file = (name) => path.join(STORE, name);

function pngInfo(buf) {
  assert.equal(buf.toString('hex', 0, 8), '89504e470d0a1a0a', 'PNG signature');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/** Decodes an 8-bit RGBA, non-interlaced PNG into a Buffer of pixels. */
function decodeRgba(buf) {
  const info = pngInfo(buf);
  assert.deepEqual([info.bitDepth, info.colorType, info.interlace], [8, 6, 0], 'expected 8-bit RGBA');
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = info.width * 4;
  const out = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { ...info, pixels: out };
}

test('store images have the sizes the Chrome Web Store requires', () => {
  const expected = { 'icon-128.png': [128, 128], 'logo-300.png': [300, 300], 'tile-440x280.png': [440, 280], 'marquee-1400x560.png': [1400, 560] };
  for (let i = 1; i <= 5; i++) expected[`screenshot-${i}.png`] = [1280, 800];
  for (const [name, [w, h]] of Object.entries(expected)) {
    assert.ok(existsSync(file(name)), name);
    const info = pngInfo(readFileSync(file(name)));
    assert.deepEqual([info.width, info.height], [w, h], name);
  }
});

test('icon-128: 96×96 artwork with a fully transparent 16 px margin', () => {
  const { width, pixels } = decodeRgba(readFileSync(file('icon-128.png')));
  const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
  let opaqueInMargin = 0;
  let opaqueInside = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const inside = x >= 16 && x < 112 && y >= 16 && y < 112;
      if (!inside && alpha(x, y) !== 0) opaqueInMargin++;
      if (inside && alpha(x, y) === 255) opaqueInside++;
    }
  }
  assert.equal(opaqueInMargin, 0);
  assert.ok(opaqueInside > 96 * 96 * 0.8, 'artwork fills the 96×96 area');
});

test('demo.mp4: H.264 MP4, 1280×720, 30 seconds, fast start', () => {
  const buf = readFileSync(file('demo.mp4'));
  assert.equal(buf.toString('ascii', 4, 8), 'ftyp');
  const moov = buf.indexOf(Buffer.from('moov'));
  const mdat = buf.indexOf(Buffer.from('mdat'));
  assert.ok(moov > 0 && moov < mdat, 'moov before mdat');
  assert.ok(buf.indexOf(Buffer.from('avc1')) > 0 && buf.indexOf(Buffer.from('avcC')) > 0);
  const mvhd = buf.indexOf(Buffer.from('mvhd'));
  const timescale = buf.readUInt32BE(mvhd + 16);
  const duration = buf.readUInt32BE(mvhd + 20);
  assert.equal(duration / timescale, 30);
  const tkhd = buf.indexOf(Buffer.from('tkhd'));
  assert.equal(buf.readUInt32BE(tkhd + 80) >>> 16, 1280);
  assert.equal(buf.readUInt32BE(tkhd + 84) >>> 16, 720);
});

test('a store description for every UI language, quoting the button labels of that language', () => {
  const locales = readdirSync(path.join(STORE, '../extension/_locales')).sort();
  assert.deepEqual(readdirSync(file('descriptions')).map((f) => f.replace(/\.txt$/, '')).sort(), locales);
  for (const lang of locales) {
    const text = readFileSync(file(`descriptions/${lang}.txt`), 'utf8');
    const ui = JSON.parse(readFileSync(path.join(STORE, `../extension/_locales/${lang}/messages.json`), 'utf8'));
    // Edge requires at least 250 characters and allows up to 10,000.
    assert.ok(text.length >= 250 && text.length <= 10000, `${lang}: ${text.length} characters`);
    for (const key of ['newTemplate', 'recAddAll', 'fillBtn', 'undo']) assert.ok(text.includes(ui[key].message.replace(/ /g, ' ')), `${lang}: mentions “${ui[key].message}” (${key})`);
    assert.ok(text.includes('FormDitto'), lang);
  }
});

test('store texts exist: listing, permissions, privacy', () => {
  for (const name of ['listing.md', 'permissions.md', 'PRIVACY.md']) assert.ok(readFileSync(file(name), 'utf8').length > 500, name);
  const listing = readFileSync(file('listing.md'), 'utf8').toLowerCase();
  for (const kw of ['autofill', 'form filler', 'templates']) assert.ok(listing.includes(kw), kw);
  const perms = readFileSync(file('permissions.md'), 'utf8');
  for (const p of ['activeTab', 'scripting', 'storage', 'sidePanel', 'Host permissions', 'remote code']) assert.ok(perms.includes(p), p);
});
