// Local static server for the test pages. Listens on loopback only (127.0.0.1 and ::1), so the same
// pages are reachable from two origins: http://127.0.0.1:PORT and http://localhost:PORT.
// Test pages get a strict CSP (no inline scripts or styles), like a hardened internal portal.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.FD_TEST_PORT || 5179);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const VENDOR = {
  '/vendor/react.js': 'node_modules/react/umd/react.production.min.js',
  '/vendor/react-dom.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '/vendor/vue.js': 'node_modules/vue/dist/vue.global.prod.js',
};
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'";

/**
 * Creates the server. `mounts` maps URL prefixes to extra directories (used by the store scripts);
 * pages served from mounts get no CSP.
 */
export function createTestServer({ mounts = {} } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = null;
    let csp = true;
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (VENDOR[url.pathname]) file = path.join(root, VENDOR[url.pathname]);
    else {
      for (const [prefix, dir] of Object.entries(mounts)) {
        if (url.pathname.startsWith(prefix)) {
          file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
          csp = false;
          if (!file.startsWith(path.resolve(dir))) file = null;
          break;
        }
      }
      if (!file && !csp) file = null;
      else if (!file) {
        const pagesDir = path.join(root, 'test/pages');
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        file = path.resolve(pagesDir, rel);
        if (!file.startsWith(pagesDir)) file = null;
      }
    }
    try {
      if (!file) throw new Error('forbidden');
      const body = await readFile(file);
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      if (csp && file.endsWith('.html')) headers['content-security-policy'] = PAGE_CSP;
      // Byte ranges let <video> seek (without them Chrome treats media as a live stream).
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { ...headers, 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
}

/** Starts listening on 127.0.0.1 and ::1. Returns a close() function. */
export async function startTestServer(options = {}) {
  const port = options.port ?? PORT;
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const s = createTestServer(options);
    await new Promise((resolve, reject) => {
      s.once('error', (e) => (host === '::1' ? resolve() : reject(e)));
      s.listen(port, host, resolve);
    });
    servers.push(s);
  }
  return { port, close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startTestServer();
  console.log(`test pages: http://127.0.0.1:${port}/  and  http://localhost:${port}/`);
}
