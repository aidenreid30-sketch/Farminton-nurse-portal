'use strict';

// Key-value storage. On Vercel: Upstash Redis over its REST API (plain fetch, no packages).
// On this computer: an in-memory stand-in that saves to a JSON file. Both have the same methods.

const fs = require('fs');
const path = require('path');

function upstashStore(url, token) {
  async function cmd(...args) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || data.error) throw new Error('Database error: ' + (data.error || r.status));
    return data.result;
  }
  const opts = o => [...(o.ex ? ['EX', o.ex] : []), ...(o.px ? ['PX', o.px] : []), ...(o.nx ? ['NX'] : [])];
  return {
    get: k => cmd('GET', k),
    set: (k, v, o = {}) => cmd('SET', k, v, ...opts(o)),
    del: (...ks) => cmd('DEL', ...ks),
    incr: k => cmd('INCR', k),
    expire: (k, s) => cmd('EXPIRE', k, s),
    ttl: k => cmd('TTL', k),
    mget: (...ks) => cmd('MGET', ...ks),
    lpush: (k, v) => cmd('LPUSH', k, v),
    ltrim: (k, a, b) => cmd('LTRIM', k, a, b),
    lrange: (k, a, b) => cmd('LRANGE', k, a, b),
  };
}

function memoryStore({ file, now = Date.now } = {}) {
  const data = new Map();   // key -> { v: string | string[], exp: ms or 0 }
  if (file && fs.existsSync(file)) {
    for (const [k, e] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) data.set(k, e);
  }
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(data)));
  };
  const live = k => {
    const e = data.get(k);
    if (!e) return null;
    if (e.exp && e.exp <= now()) { data.delete(k); return null; }
    return e;
  };
  const store = {
    async get(k) { const e = live(k); return e && !Array.isArray(e.v) ? e.v : null; },
    async set(k, v, o = {}) {
      if (o.nx && live(k)) return null;
      const ms = o.ex ? o.ex * 1000 : (o.px || 0);
      data.set(k, { v: String(v), exp: ms ? now() + ms : 0 });
      persist();
      return 'OK';
    },
    async del(...ks) { let n = 0; for (const k of ks) if (data.delete(k)) n++; persist(); return n; },
    async incr(k) {
      const e = live(k);
      const n = (e ? Number(e.v) : 0) + 1;
      data.set(k, { v: String(n), exp: e ? e.exp : 0 });
      persist();
      return n;
    },
    async expire(k, s) { const e = live(k); if (!e) return 0; e.exp = now() + s * 1000; persist(); return 1; },
    async ttl(k) { const e = live(k); if (!e) return -2; return e.exp ? Math.ceil((e.exp - now()) / 1000) : -1; },
    async mget(...ks) { return Promise.all(ks.map(k => store.get(k))); },
    async lpush(k, v) {
      const e = live(k) || { v: [], exp: 0 };
      e.v.unshift(String(v));
      data.set(k, e);
      persist();
      return e.v.length;
    },
    async ltrim(k, a, b) { const e = live(k); if (e) { e.v = e.v.slice(a, b + 1); persist(); } return 'OK'; },
    async lrange(k, a, b) { const e = live(k); return e ? e.v.slice(a, b === -1 ? undefined : b + 1) : []; },
  };
  return store;
}

/** Upstash via the variables Vercel's Marketplace integration adds; null if not connected. */
function storeFromEnv(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore(url, token) : null;
}

module.exports = { upstashStore, memoryStore, storeFromEnv };
