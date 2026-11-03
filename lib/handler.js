'use strict';

// The whole app as one request handler: used by the Vercel function (api/index.js) and by
// dev-server.js on this computer. All saved data goes through `store` (see store.js).

const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./password');
const pages = require('./pages');
const icons = require('./icons');
const defaultConfig = require('../config.json');

const MAX_BODY = 10 * 1024;
const MAX_NOTE = 140;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
const LOCK_AFTER = 5;        // wrong passwords...
const LOCK_MINUTES = 15;     // ...lock sign-in from that address for this long
const HISTORY_MAX = 2000;
const COLORS = ['green', 'amber', 'red', 'blue', 'gray'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PLACEHOLDER_PASSWORD = 'change-this-password';
// Public pages: browsers always re-check, Vercel's CDN reuses a copy for 10s so the
// database is read a few times a minute no matter how many people are watching.
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=30';

const K = {
  state: 'ns:state',
  history: 'ns:history',
  password: 'ns:password',
  sessionGen: 'ns:session-gen',
  session: 'ns:session:',
  fail: 'ns:fail:',
  cooldown: 'ns:cooldown',
  reset: 'ns:reset:',
};

const defaultLog = (...a) => console.log(...a);

function createHandler({ env = process.env, store, config = defaultConfig, now = Date.now, log = defaultLog } = {}) {
  // ---------------------------------------------------------------- setup ---

  const byKey = {};
  for (const s of config.statuses || []) {
    if (!/^[a-z0-9-]{1,32}$/.test(s.key)) throw new Error(`config.json: status key "${s.key}" must be lowercase letters, digits or dashes.`);
    if (!COLORS.includes(s.color)) throw new Error(`config.json: status "${s.key}" color must be one of ${COLORS.join(', ')}.`);
    byKey[s.key] = s;
  }
  if (!Object.keys(byKey).length) throw new Error('config.json: add at least one status.');

  const problems = [];
  const nurseEmail = String(env.NURSE_EMAIL || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nurseEmail)) problems.push('Set NURSE_EMAIL to the nurse\'s email address.');
  const envPassword = String(env.NURSE_PASSWORD || '');
  if (!envPassword) problems.push(`Set NURSE_PASSWORD (at least ${MIN_PASSWORD} characters).`);
  else if (envPassword === PLACEHOLDER_PASSWORD) problems.push('Change NURSE_PASSWORD from the example value.');
  else if (envPassword.length < MIN_PASSWORD) problems.push(`NURSE_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
  const tz = env.SCHOOL_TIME_ZONE || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { problems.push(`SCHOOL_TIME_ZONE "${tz}" isn't a time zone (e.g. America/Chicago).`); }
  if (!store) problems.push('Connect a database: in your Vercel project open Storage, add Upstash Redis, then redeploy.');
  if (problems.length) {
    return (req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(pages.setupPage(problems));
    };
  }

  const onVercel = env.VERCEL === '1';
  const secureCookies = onVercel || env.COOKIE_SECURE === 'true';
  const trustProxy = onVercel || env.TRUST_PROXY === 'true';
  const sessionSeconds = Math.round((Number(env.SESSION_HOURS) || 12) * 3600);
  const cookieName = secureCookies ? '__Host-ns_session' : 'ns_session';
  const chatWebhook = env.CHAT_WEBHOOK_URL || '';
  const cronSecret = env.CRON_SECRET || '';

  // Hashes are made once per server instance.
  let envHashPromise, dummyHashPromise;
  const envHash = () => (envHashPromise = envHashPromise || hashPassword(envPassword));
  const dummyHash = () => (dummyHashPromise = dummyHashPromise || hashPassword(crypto.randomBytes(16).toString('hex')));

  // ------------------------------------------------------------------ time ---

  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });

  function zoned(ms) {
    const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, weekday: WEEKDAYS.indexOf(p.weekday) + 1 };
  }

  function formatBackAt(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // ------------------------------------------------------------------ data ---

  const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };

  function view(state) {
    const def = byKey[state.key];
    let updated = 'No updates yet';
    if (state.updatedMs) {
      const d = new Date(state.updatedMs);
      const day = zoned(state.updatedMs).date === zoned(now()).date ? 'today' : dayFmt.format(d).replace(',', '');
      updated = 'Updated ' + day + ' at ' + clockFmt.format(d).replace(/\s/g, ' ');
    }
    return {
      key: def.key, label: def.label, color: def.color, icon: icons.has(def.icon) ? def.icon : 'dot',
      note: state.note || '', backAt: formatBackAt(state.backAt), updated,
    };
  }

  async function readState() {
    const s = parse(await store.get(K.state));
    return s && byKey[s.key] ? s : { key: config.statuses[0].key, note: '', backAt: '', updatedMs: 0 };
  }

  async function saveState(state, by) {
    await store.set(K.state, JSON.stringify(state));
    const v = view(state);
    await store.lpush(K.history, JSON.stringify({ t: state.updatedMs, by, status: v.label, backAt: v.backAt, note: v.note }));
    await store.ltrim(K.history, 0, HISTORY_MAX - 1);
    await notifyChat(v);
  }

  async function notifyChat(v) {
    if (!chatWebhook) return;
    let text = `${config.title}: *${v.label}*`;
    if (v.backAt) text += `, back at ${v.backAt}`;
    if (v.note) text += `\n${v.note}`;
    try {
      await fetch(chatWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(3000),
      });
    } catch (err) { log('Chat notice failed:', err.message); }
  }

  /**
   * The current status, applying the end-of-day reset if it's due: after
   * config.dailyReset.time on a weekday, switch to its status unless the nurse already
   * changed it after that time today. Runs on reads, so no timer is needed.
   */
  async function getState() {
    const state = await readState();
    const r = config.dailyReset;
    if (!r || !byKey[r.status]) return state;
    const t = zoned(now());
    if (t.weekday > 5 || t.hm < r.time) return state;
    const last = zoned(state.updatedMs);
    if (state.key === r.status || (last.date === t.date && last.hm >= r.time)) return state;
    // Only one request does the reset, even if several arrive at once.
    if (!(await store.set(K.reset + t.date, '1', { nx: true, ex: 2 * 86400 }))) return readState();
    const next = { key: r.status, note: '', backAt: '', updatedMs: now() };
    await saveState(next, 'Automatic end-of-day reset');
    log(`End-of-day reset: status set to "${byKey[r.status].label}".`);
    return next;
  }

  /** The nurse's password hash: one she set on the page, or else NURSE_PASSWORD. */
  async function currentPasswordHash() {
    const rec = parse(await store.get(K.password));
    // Her saved password only counts while NURSE_PASSWORD is unchanged. An admin changing
    // NURSE_PASSWORD is how a forgotten password gets reset.
    if (rec && rec.hash && await verifyPassword(envPassword, rec.envCheck)) return rec.hash;
    if (rec) {
      await store.del(K.password);
      await store.incr(K.sessionGen);
      log('NURSE_PASSWORD was changed by an admin: password reset, all sign-ins ended.');
    }
    return envHash();
  }

  // ------------------------------------------------------------- sessions ---

  const newToken = () => crypto.randomBytes(32).toString('base64url');
  // Only a hash of the cookie is stored, so the database alone can't be used to sign in.
  const sessionKey = token => K.session + crypto.createHash('sha256').update(token).digest('base64url');

  async function startSession() {
    const token = newToken();
    const csrf = newToken();
    const gen = Number(await store.get(K.sessionGen)) || 0;
    await store.set(sessionKey(token), JSON.stringify({ csrf, gen }), { ex: sessionSeconds });
    return { token, csrf };
  }

  function sessionCookie(token, maxAge) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (secureCookies ? '; Secure' : '');
  }

  function cookieToken(req) {
    for (const part of String(req.headers.cookie || '').split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i) === cookieName) {
        const v = part.slice(i + 1);
        return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
      }
    }
    return null;
  }

  async function getSession(req) {
    const token = cookieToken(req);
    if (!token) return null;
    const [raw, gen] = await store.mget(sessionKey(token), K.sessionGen);
    const s = parse(raw);
    if (!s || s.gen !== (Number(gen) || 0)) return null;
    return { token, csrf: s.csrf };
  }

  async function requireSession(req) {
    const s = await getSession(req);
    if (!s) throw httpError(401, 'Please sign in again.');
    const sent = Buffer.from(String(req.headers['x-csrf-token'] || ''));
    const want = Buffer.from(s.csrf);
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) throw httpError(403, 'Please reload the page and try again.');
    return s;
  }

  function clientIp(req) {
    if (trustProxy) {
      const ip = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (ip) return ip;
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  async function lockedMinutes(ip) {
    if ((Number(await store.get(K.fail + ip)) || 0) < LOCK_AFTER) return 0;
    return Math.max(1, Math.ceil((await store.ttl(K.fail + ip)) / 60));
  }

  async function recordFail(ip) {
    const n = await store.incr(K.fail + ip);
    if (n === 1 || n === LOCK_AFTER) await store.expire(K.fail + ip, LOCK_MINUTES * 60);
    if (n === LOCK_AFTER) log(`Sign-in locked for ${LOCK_MINUTES} minutes for ${ip} after ${LOCK_AFTER} wrong passwords.`);
  }

  const lockedMessage = m => `Too many wrong tries. Try again in ${m} minute${m === 1 ? '' : 's'}.`;

  // ------------------------------------------------------------- responses ---

  function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

  function securityHeaders(frameable) {
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors " + (frameable ? '*' : "'none'"),
    };
    // Only the read-only board may be embedded (e.g. Google Sites). Sign-in pages never.
    if (!frameable) h['X-Frame-Options'] = 'DENY';
    if (secureCookies) h['Strict-Transport-Security'] = 'max-age=15552000';
    return h;
  }

  function send(res, status, body, type, headers = {}, frameable = false) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...securityHeaders(frameable), ...headers });
    res.end(body);
  }
  const html = (res, status, body, headers, frameable) => send(res, status, body, 'text/html; charset=utf-8', headers, frameable);
  const json = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', headers);

  async function readJson(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // Requiring JSON also blocks plain HTML forms posted from other websites.
    if (type !== 'application/json') { if (req.resume) req.resume(); throw httpError(415, 'Send JSON.'); }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      if (req.resume) req.resume();
      throw Object.assign(httpError(413, 'Too much data.'), { closeConnection: true });
    }
    let text;
    if ('body' in req) {
      // Vercel has already read the body (and may have parsed it).
      let b;
      try { b = req.body; } catch { throw httpError(400, 'Bad request.'); }
      if (b && typeof b === 'object' && !Buffer.isBuffer(b)) { if (Array.isArray(b)) throw httpError(400, 'Bad request.'); return b; }
      text = b == null ? '' : String(b);
    } else {
      text = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
          size += c.length;
          if (size <= MAX_BODY) return chunks.push(c);
          req.removeAllListeners('data');
          req.resume();
          reject(Object.assign(httpError(413, 'Too much data.'), { closeConnection: true }));
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }
    const v = parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'Bad request.');
    return v;
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    try { return new URL(origin).host === host; } catch { return false; }
  }

  // ------------------------------------------------------------------- API ---

  async function login(req, res, body) {
    const ip = clientIp(req);
    const locked = await lockedMinutes(ip);
    if (locked) return json(res, 429, { error: lockedMessage(locked) });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || password.length > MAX_PASSWORD) return json(res, 400, { error: 'Enter your email and password.' });

    const emailOk = email === nurseEmail;
    // A wrong email is checked against a dummy hash so it takes as long as a wrong password.
    const passwordOk = await verifyPassword(password, emailOk ? await currentPasswordHash() : await dummyHash());
    if (!emailOk || !passwordOk) {
      await recordFail(ip);
      log(`Failed sign-in from ${ip}${emailOk ? '' : ' (unknown email)'}`);
      return json(res, 401, { error: 'Email or password is incorrect.' });
    }
    await store.del(K.fail + ip);
    const s = await startSession();
    log(`Nurse signed in from ${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(s.token, sessionSeconds) });
  }

  async function logout(req, res) {
    const token = cookieToken(req);
    if (token) await store.del(sessionKey(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  async function setStatus(req, res, body) {
    await requireSession(req);
    const key = String(body.status || '');
    const backAt = String(body.backAt || '').trim();
    const note = String(body.note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTE);
    if (!byKey[key]) return json(res, 400, { error: 'Unknown status. Reload the page and try again.' });
    if (backAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(backAt)) return json(res, 400, { error: 'The "back at" time should look like 12:30.' });
    // Atomic: two taps arriving together can't both get through.
    const cooldownMs = (Number(config.cooldownSeconds) || 5) * 1000;
    if (!(await store.set(K.cooldown, '1', { px: cooldownMs, nx: true }))) {
      return json(res, 429, { error: 'Just updated. Wait a few seconds before changing it again.' });
    }
    const state = { key, note, backAt, updatedMs: now() };
    await saveState(state, nurseEmail);
    log(`Status set to "${byKey[key].label}" from ${clientIp(req)}`);
    return json(res, 200, view(state));
  }

  async function changePassword(req, res, body) {
    await requireSession(req);
    const ip = clientIp(req);
    const locked = await lockedMinutes(ip);
    if (locked) return json(res, 429, { error: lockedMessage(locked) });
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';

    if (!current || current.length > MAX_PASSWORD || !(await verifyPassword(current, await currentPasswordHash()))) {
      await recordFail(ip);
      return json(res, 400, { error: 'Your current password is not right.' });
    }
    if (next.length < MIN_PASSWORD) return json(res, 400, { error: `The new password needs at least ${MIN_PASSWORD} characters.` });
    if (next.length > MAX_PASSWORD) return json(res, 400, { error: 'The new password is too long.' });
    if (next === current) return json(res, 400, { error: 'The new password must be different from the current one.' });
    if (next.trim().toLowerCase() === nurseEmail) return json(res, 400, { error: 'Don\'t use your email as your password.' });

    await store.set(K.password, JSON.stringify({ hash: await hashPassword(next), envCheck: await envHash(), changedMs: now() }));
    // End every sign-in, then give this browser a fresh one.
    await store.incr(K.sessionGen);
    const s = await startSession();
    log(`Nurse changed her password from ${ip}. All other sign-ins were ended.`);
    return json(res, 200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': sessionCookie(s.token, sessionSeconds) });
  }

  async function historyCsv(req, res) {
    if (!(await getSession(req))) return send(res, 303, '', 'text/plain', { Location: '/nurse' });
    const cell = s => { s = String(s == null ? '' : s); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = (await store.lrange(K.history, 0, -1)).map(parse).filter(Boolean);
    const lines = ['time,changed_by,status,back_at,note'];
    for (const h of rows) {
      const z = zoned(h.t);
      lines.push([`${z.date} ${z.hm}`, h.by, h.status, h.backAt, h.note].map(cell).join(','));
    }
    return send(res, 200, lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8',
      { 'Content-Disposition': 'attachment; filename="nurse-status-history.csv"' });
  }

  // -------------------------------------------------------------- routing ---

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/') {
        const embed = url.searchParams.get('embed') === '1';
        return html(res, 200, pages.boardPage(config, view(await getState()), embed), { 'Cache-Control': PUBLIC_CACHE }, embed);
      }
      if (p === '/api/status') return json(res, 200, view(await getState()), { 'Cache-Control': PUBLIC_CACHE });
      if (p === '/api/cron') {
        // Vercel's daily job: makes sure the end-of-day reset happens even if nobody looks.
        if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) return json(res, 401, { error: 'Unauthorized.' });
        return json(res, 200, { ok: true, status: (await getState()).key });
      }
      if (p === '/nurse') {
        const s = await getSession(req);
        return html(res, 200, s ? pages.controlPage(config, view(await getState()), s.csrf, nurseEmail) : pages.loginPage(config));
      }
      if (p === '/nurse/password') {
        const s = await getSession(req);
        if (!s) return send(res, 303, '', 'text/plain', { Location: '/nurse' });
        return html(res, 200, pages.passwordPage(config, s.csrf, nurseEmail));
      }
      if (p === '/nurse/history.csv') return historyCsv(req, res);
      if (p === '/favicon.ico') return send(res, 204, '', 'text/plain');
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST') {
      const routes = { '/api/login': login, '/api/logout': logout, '/api/status': setStatus, '/api/password': changePassword };
      const handler = routes[p];
      if (!handler) return json(res, 404, { error: 'Not found.' });
      if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden.' });
      return handler(req, res, await readJson(req));
    }

    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, POST' });
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (!err.status) log('Error:', err.stack || err.message);
      if (res.headersSent) return;
      json(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong. Try again.' },
        err.closeConnection ? { Connection: 'close' } : {});
    }
  };
}

module.exports = { createHandler };
