'use strict';

// Runs the app on this computer (Start.bat). Uses Upstash if its variables are in .env,
// otherwise a stand-in database saved to data/dev-store.json.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { readEnvFile } = require('./lib/env');
const { createHandler } = require('./lib/handler');
const { storeFromEnv, memoryStore } = require('./lib/store');

const STATIC_DIR = path.join(__dirname, 'public', 'static');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };

function createDevServer(options) {
  const handler = createHandler(options);
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/static/')) {
      // On Vercel these come straight from public/; here, serve them the same way.
      const file = path.join(STATIC_DIR, path.basename(p));
      const type = TYPES[path.extname(file)];
      if (!type || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(file));
    }
    handler(req, res);
  });
}

module.exports = { createDevServer };

if (require.main === module) {
  const env = { ...process.env, ...readEnvFile(path.join(__dirname, '.env')) };
  const upstash = storeFromEnv(env);
  const store = upstash || memoryStore({ file: path.join(__dirname, 'data', 'dev-store.json') });
  const port = Number(env.PORT) || 8090;
  const host = env.HOST || '127.0.0.1';
  const log = (...a) => console.log(new Date().toLocaleString('en-US'), '-', ...a);

  createDevServer({ env, store, log }).listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.log('');
    console.log('  Nurse Status Board (running on this computer)');
    console.log('');
    console.log(`    Status board:  http://${shown}:${port}/`);
    console.log(`    Nurse page:    http://${shown}:${port}/nurse`);
    console.log(`    Database:      ${upstash ? 'Upstash Redis' : 'local stand-in (data/dev-store.json)'}`);
    console.log('\n  Close this window to stop it.\n');
  });
}
