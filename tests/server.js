// Tiny static server for local testing. Serves the app under /Decibel-meeter/,
// the same sub-path GitHub Pages uses, so relative paths and the service worker
// scope are tested for real. Usage: node tests/server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = '/Decibel-meeter/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (!p.startsWith(BASE)) {
      res.writeHead(302, { Location: BASE });
      res.end();
      return;
    }
    p = p.slice(BASE.length) || 'index.html';
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

function start(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port || 0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { start, BASE };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8080;
  start(port).then(() => console.log('Loud Enough running at http://localhost:' + port + BASE));
}
