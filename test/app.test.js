'use strict';

// Run with:  node --test   (from the nurse-status-app folder)

const assert = require('node:assert');
const http = require('http');
const test = require('node:test');
const { createDevServer } = require('../dev-server');
const { memoryStore } = require('../lib/store');

const EMAIL = 'nurse@school.org';
const START_PASSWORD = 'first-password-123';
const TZ = 'America/Chicago';
// Nov 2026 in Chicago (UTC-6). Nov 5 is a Thursday.
const chicago = (day, hh, mm = 0) => Date.UTC(2026, 10, day, hh + 6, mm);

async function start(env, clock, store) {
  const server = createDevServer({ env, store, now: () => clock.t, log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

function request(port, method, p, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data !== null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: () => JSON.parse(b) }));
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
}

async function signIn(port, email, password) {
  const r = await request(port, 'POST', '/api/login', { body: { email, password } });
  if (r.status !== 200) return { r };
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const page = await request(port, 'GET', '/nurse', { cookie });
  return { r, cookie, csrf: page.body.match(/name="csrf-token" content="([^"]+)"/)[1] };
}

test('nurse status app', async t => {
  const clock = { t: chicago(5, 8) };
  const store = memoryStore({ now: () => clock.t });
  const env = { NURSE_EMAIL: EMAIL, NURSE_PASSWORD: START_PASSWORD, SCHOOL_TIME_ZONE: TZ, CRON_SECRET: 'cron-secret' };
  let { server, port } = await start(env, clock, store);
  const tick = (sec = 6) => { clock.t += sec * 1000; };
  const setAs = (s, body) => request(port, 'POST', '/api/status', { body, cookie: s.cookie, headers: { 'X-CSRF-Token': s.csrf } });
  let nurse;

  await t.test('board and status API are public and CDN-cacheable', async () => {
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /In the Health Office/);
    assert.match(page.headers['cache-control'], /s-maxage=10/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await request(port, 'GET', '/api/status')).json().key, 'in');
    assert.equal((await request(port, 'GET', '/static/app.js')).status, 200);
  });

  await t.test('nurse pages need sign-in', async () => {
    const page = await request(port, 'GET', '/nurse');
    assert.match(page.body, /Nurse sign-in/);
    assert.match(page.headers['cache-control'], /no-store/);
    assert.equal((await request(port, 'GET', '/nurse/password')).status, 303);
    assert.equal((await request(port, 'GET', '/nurse/history.csv')).status, 303);
  });

  await t.test('only the one account can sign in; same message for every failure', async () => {
    for (const [email, password] of [[EMAIL, 'nope-nope-nope'], ['teacher@school.org', START_PASSWORD]]) {
      const { r } = await signIn(port, email, password);
      assert.equal(r.status, 401);
      assert.equal(r.json().error, 'Email or password is incorrect.');
    }
    nurse = await signIn(port, '  Nurse@School.org ', START_PASSWORD);
    assert.equal(nurse.r.status, 200);
    assert.match(nurse.r.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.match((await request(port, 'GET', '/nurse', { cookie: nurse.cookie })).body, /Download history/);
  });

  await t.test('status changes need a session and the CSRF token', async () => {
    const body = { status: 'lunch', backAt: '12:30', note: '<img src=x onerror=alert(1)> =SUM(A1)' };
    assert.equal((await request(port, 'POST', '/api/status', { body })).status, 401);
    assert.equal((await setAs({ cookie: nurse.cookie, csrf: 'wrong' }, body)).status, 403);
    const ok = await setAs(nurse, body);
    assert.equal(ok.status, 200);
    assert.equal(ok.json().backAt, '12:30 PM');
    const board = await request(port, 'GET', '/');
    assert.match(board.body, /&lt;img src=x/);
    assert.doesNotMatch(board.body, /<img src=x/);
  });

  await t.test('other websites and plain forms are blocked', async () => {
    tick();
    const form = await request(port, 'POST', '/api/status', {
      body: 'status=out', cookie: nurse.cookie, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': nurse.csrf },
    });
    assert.equal(form.status, 415);
    const evil = await request(port, 'POST', '/api/status', {
      body: { status: 'out' }, cookie: nurse.cookie, headers: { Origin: 'https://evil.example', 'X-CSRF-Token': nurse.csrf },
    });
    assert.equal(evil.status, 403);
  });

  await t.test('double tap within 5 seconds is refused; bad input rejected', async () => {
    tick();
    assert.equal((await setAs(nurse, { status: 'away' })).status, 200);
    tick(2);
    assert.equal((await setAs(nurse, { status: 'out' })).status, 429);
    tick();
    assert.equal((await setAs(nurse, { status: 'hacked' })).status, 400);
    assert.equal((await setAs(nurse, { status: 'in', backAt: '25:99' })).status, 400);
    assert.equal((await request(port, 'POST', '/api/status', { body: { note: 'x'.repeat(20000) }, cookie: nurse.cookie, headers: { 'X-CSRF-Token': nurse.csrf } })).status, 413);
    assert.equal((await request(port, 'GET', '/api/status')).json().key, 'away');
  });

  await t.test('history downloads as CSV with formulas made harmless', async () => {
    const csv = await request(port, 'GET', '/nurse/history.csv', { cookie: nurse.cookie });
    assert.match(csv.headers['content-disposition'], /attachment/);
    assert.match(csv.body, /"2026-11-05 08:\d\d","nurse@school.org","At Lunch","12:30 PM"/);
    assert.match(csv.body, /"Away from the Office/);
  });

  await t.test('embed can go in Google Sites; nurse pages cannot', async () => {
    const embed = await request(port, 'GET', '/?embed=1');
    assert.equal(embed.headers['x-frame-options'], undefined);
    assert.match(embed.headers['content-security-policy'], /frame-ancestors \*/);
    assert.equal((await request(port, 'GET', '/nurse?embed=1')).headers['x-frame-options'], 'DENY');
  });

  await t.test('change password: checks, then ends every other sign-in', async () => {
    const laptop = await signIn(port, EMAIL, START_PASSWORD);
    const pw = body => request(port, 'POST', '/api/password', { body, cookie: nurse.cookie, headers: { 'X-CSRF-Token': nurse.csrf } });
    assert.match((await pw({ current: 'not-it-at-all', next: 'new-password-456' })).json().error, /current password/);
    assert.match((await pw({ current: START_PASSWORD, next: 'short' })).json().error, /at least 10/);
    assert.match((await pw({ current: START_PASSWORD, next: START_PASSWORD })).json().error, /different/);
    const ok = await pw({ current: START_PASSWORD, next: 'new-password-456' });
    assert.equal(ok.status, 200);
    assert.ok(!JSON.stringify([...(await store.mget('ns:password'))]).includes('new-password-456'), 'stored hashed');
    nurse = { cookie: ok.headers['set-cookie'][0].split(';')[0], csrf: ok.json().csrf };
    assert.match((await request(port, 'GET', '/nurse', { cookie: nurse.cookie })).body, /Set your status/);
    assert.match((await request(port, 'GET', '/nurse', { cookie: laptop.cookie })).body, /Nurse sign-in/);
    assert.equal((await signIn(port, EMAIL, START_PASSWORD)).r.status, 401);
    assert.equal((await signIn(port, EMAIL, 'new-password-456')).r.status, 200);
  });

  await t.test('sign out ends the session; sessions expire after 12 hours', async () => {
    const s = await signIn(port, EMAIL, 'new-password-456');
    const out = await request(port, 'POST', '/api/logout', { body: {}, cookie: s.cookie, headers: { 'X-CSRF-Token': s.csrf } });
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.match((await request(port, 'GET', '/nurse', { cookie: s.cookie })).body, /Nurse sign-in/);
    const s2 = await signIn(port, EMAIL, 'new-password-456');
    clock.t += 12 * 3600 * 1000 + 1000;
    assert.match((await request(port, 'GET', '/nurse', { cookie: s2.cookie })).body, /Nurse sign-in/);
    clock.t = chicago(6, 8);
  });

  await t.test('5 wrong passwords lock sign-in for 15 minutes', async () => {
    for (let i = 0; i < 5; i++) await signIn(port, EMAIL, 'guess-' + i + '-xxxxx');
    const locked = await signIn(port, EMAIL, 'new-password-456');
    assert.equal(locked.r.status, 429);
    assert.match(locked.r.json().error, /15 minutes/);
    clock.t += 15 * 60 * 1000 + 1000;
    assert.equal((await signIn(port, EMAIL, 'new-password-456')).r.status, 200);
  });

  await t.test('admin resets a forgotten password by changing NURSE_PASSWORD', async () => {
    const before = await signIn(port, EMAIL, 'new-password-456');
    server.close();
    ({ server, port } = await start({ ...env, NURSE_PASSWORD: 'admin-reset-789' }, clock, store));
    assert.equal((await signIn(port, EMAIL, 'new-password-456')).r.status, 401);
    assert.match((await request(port, 'GET', '/nurse', { cookie: before.cookie })).body, /Nurse sign-in/, 'old sign-ins ended');
    nurse = await signIn(port, EMAIL, 'admin-reset-789');
    assert.equal(nurse.r.status, 200);
  });

  await t.test('end-of-day reset happens on read and via the daily job', async () => {
    const statusNow = async () => (await request(port, 'GET', '/api/status')).json().key;
    clock.t = chicago(9, 9);                                                           // Monday
    nurse = await signIn(port, EMAIL, 'admin-reset-789');
    assert.equal((await setAs(nurse, { status: 'in' })).status, 200);
    clock.t = chicago(9, 16, 15); assert.equal(await statusNow(), 'in', 'not before 4:30');
    clock.t = chicago(9, 16, 31); assert.equal(await statusNow(), 'gone');
    clock.t = chicago(9, 17); await setAs(nurse, { status: 'in' });
    clock.t = chicago(9, 17, 30); assert.equal(await statusNow(), 'in', 'respects a change after 4:30');
    clock.t = chicago(14, 17); assert.equal(await statusNow(), 'in', 'skips Saturday');
    assert.equal((await request(port, 'GET', '/api/cron')).status, 401, 'cron needs the secret');
    clock.t = chicago(16, 18);                                                          // Monday
    const cron = await request(port, 'GET', '/api/cron', { headers: { Authorization: 'Bearer cron-secret' } });
    assert.equal(cron.json().status, 'gone');
    nurse = await signIn(port, EMAIL, 'admin-reset-789');
    const csv = await request(port, 'GET', '/nurse/history.csv', { cookie: nurse.cookie });
    assert.equal(csv.body.match(/Automatic end-of-day reset/g).length, 2);
  });

  server.close();
});

test('shows a setup page instead of running when settings are missing', async () => {
  const clock = { t: Date.now() };
  for (const [env, store, msg] of [
    [{ NURSE_PASSWORD: 'long-enough-password' }, memoryStore(), /NURSE_EMAIL/],
    [{ NURSE_EMAIL: EMAIL, NURSE_PASSWORD: 'short' }, memoryStore(), /at least 10/],
    [{ NURSE_EMAIL: EMAIL, NURSE_PASSWORD: 'change-this-password' }, memoryStore(), /example value/],
    [{ NURSE_EMAIL: EMAIL, NURSE_PASSWORD: 'long-enough-password' }, null, /Upstash Redis/],
  ]) {
    const { server, port } = await start(env, clock, store);
    const r = await request(port, 'GET', '/');
    assert.equal(r.status, 503);
    assert.match(r.body, msg);
    server.close();
  }
});
