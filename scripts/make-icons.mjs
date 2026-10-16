// Renders store/src/icon.svg into the extension icons and the store icon.
// 128×128: 96×96 artwork centred with 16 px transparent padding (Chrome Web Store guideline).
// 16/32/48: artwork scaled to the full canvas for the toolbar and extensions page.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'store/src/icon.svg'), 'utf8');

export async function makeIcons(browser) {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const out = {};
  for (const [size, art, pad] of [[16, 16, 0], [32, 32, 0], [48, 48, 0], [128, 96, 16]]) {
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace('width="96" height="96"', `width="${art}" height="${art}"`);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="padding:${pad}px;width:${size}px;height:${size}px;box-sizing:border-box">${sized}</div></body></html>`);
    const file = path.join(root, `extension/icons/icon-${size}.png`);
    writeFileSync(file, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    out[size] = file;
  }
  copyFileSync(out[128], path.join(root, 'store/icon-128.png'));
  // Edge Add-ons "Extension logo": 1:1, 300×300 recommended (minimum 128×128).
  await page.setViewportSize({ width: 300, height: 300 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="padding:30px;width:300px;height:300px;box-sizing:border-box">${svg.replace('width="96" height="96"', 'width="240" height="240"')}</div></body></html>`);
  writeFileSync(path.join(root, 'store/logo-300.png'), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 300, height: 300 } }));
  await page.close();
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch();
  console.log(await makeIcons(browser));
  await browser.close();
}
