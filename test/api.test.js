// node --test   (boots the real server against a throwaway database)
//
// Covers what would hurt most if it broke: the household login and its rate
// limit, share-link secrets, API key scope and revocation, and the event
// lifecycle. Each server is a child process on a free port with its own temp
// DATA_DIR, so nothing touches a real calendar.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = 'test-household-pass';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Start a server and return a small client for it. A cookie jar per client
// is enough: the session is a single cookie.
async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinboard-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), TZ: 'America/New_York' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  t.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not listening yet */ }
    if (i > 100) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const client = () => {
    let cookie = '';
    return async function req(method, url, { body, headers = {} } = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(cookie && { cookie }),
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, text, json };
    };
  };
  return { base, client, log: () => log };
}

async function setUp(srv) {
  const owner = srv.client();
  const r = await owner('POST', '/api/setup', { body: { name: 'Test Family', timeZone: 'America/New_York', password: PASSWORD } });
  assert.strictEqual(r.status, 200, r.text);
  return owner;
}

// A date inside the window GET /api/events returns (a month back to a year ahead).
function soon(days = 7) {
  const d = new Date(Date.now() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

test('login: the right password signs in, a wrong one does not', async (t) => {
  const srv = await startServer(t);
  await setUp(srv);

  const anon = srv.client();
  assert.strictEqual((await anon('GET', '/api/events')).status, 401);
  assert.strictEqual((await anon('POST', '/api/login', { body: { password: 'not-it' } })).status, 401);
  assert.strictEqual((await anon('GET', '/api/events')).status, 401, 'a failed login must not leave a session behind');

  assert.strictEqual((await anon('POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
  assert.strictEqual((await anon('GET', '/api/events')).status, 200);

  assert.strictEqual((await anon('POST', '/api/setup', { body: { name: 'X', timeZone: 'UTC', password: 'another-pass' } })).status, 409,
    'setup cannot be run again to take over the household');
});

test('login: guesses are rate limited, and X-Forwarded-For does not reset the count', async (t) => {
  const srv = await startServer(t);
  await setUp(srv);
  const anon = srv.client();

  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push((await anon('POST', '/api/login', { body: { password: `guess-${i}` } })).status);
  }
  assert.deepStrictEqual(codes, Array(10).fill(401));
  assert.strictEqual((await anon('POST', '/api/login', { body: { password: 'guess-10' } })).status, 429);

  // Without TRUST_PROXY the header must be ignored, or every guess could
  // claim a fresh address.
  const spoofed = await anon('POST', '/api/login', {
    body: { password: PASSWORD },
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assert.strictEqual(spoofed.status, 429);
});

test('events: create, read, edit, delete', async (t) => {
  const srv = await startServer(t);
  const owner = await setUp(srv);
  const date = soon();

  const created = await owner('POST', '/api/events', {
    body: { title: 'Swim lesson', date, startTime: '16:30', endTime: '17:15', allDay: false },
  });
  assert.strictEqual(created.status, 200, created.text);
  const id = created.json.event.uid; // the client shape calls the row id `uid`
  assert.ok(id);

  let list = (await owner('GET', '/api/events')).json.events;
  const ev = list.find((e) => e.uid === id);
  assert.ok(ev, 'new event is listed');
  assert.strictEqual(ev.start, `${date}T16:30:00`);

  const edited = await owner('PATCH', `/api/events/${id}`, { body: { title: 'Swim meet' } });
  assert.strictEqual(edited.status, 200, edited.text);
  list = (await owner('GET', '/api/events')).json.events;
  assert.strictEqual(list.find((e) => e.uid === id).title, 'Swim meet');

  assert.strictEqual((await owner('DELETE', `/api/events/${id}`)).status, 200);
  list = (await owner('GET', '/api/events')).json.events;
  assert.ok(!list.some((e) => e.uid === id), 'deleted event is gone');
  assert.strictEqual((await owner('PATCH', `/api/events/${id}`, { body: { title: 'Ghost' } })).status, 404);
});

test('events: bad input is refused and nobody signed out can write', async (t) => {
  const srv = await startServer(t);
  const owner = await setUp(srv);

  assert.strictEqual((await owner('POST', '/api/events', { body: { title: 'No date' } })).status, 400);
  assert.strictEqual((await owner('POST', '/api/events', { body: { title: 'Bad date', date: '2030-02-30', allDay: true } })).status, 400);
  assert.strictEqual((await owner('POST', '/api/events', { body: { title: 'Bad time', date: soon(), startTime: '25:00' } })).status, 400);

  const anon = srv.client();
  assert.strictEqual((await anon('POST', '/api/events', { body: { title: 'Sneaky', date: soon(), allDay: true } })).status, 401);
  const ok = await owner('POST', '/api/events', { body: { title: 'Real', date: soon(), allDay: true } });
  const id = ok.json.event.uid;
  assert.strictEqual((await anon('PATCH', `/api/events/${id}`, { body: { title: 'Changed' } })).status, 401);
  assert.strictEqual((await anon('DELETE', `/api/events/${id}`)).status, 401);
});

test('share links: the right secret works, a wrong or revoked one gets nothing', async (t) => {
  const srv = await startServer(t);
  const owner = await setUp(srv);
  await owner('POST', '/api/events', { body: { title: 'Piano recital', date: soon(), allDay: true } });

  const share = (await owner('POST', '/api/share/generate')).json;
  const full = (await owner('POST', '/api/share/full/generate')).json;
  assert.ok(share.token && full.fullIcsUrl);
  const fullToken = full.fullIcsUrl.match(/\/all\/([^/]+)\.ics$/)[1];
  assert.notStrictEqual(fullToken, share.token, 'the full feed has its own secret');

  const anon = srv.client();
  const fullFeed = await anon('GET', `/api/calendar/all/${fullToken}.ics`);
  assert.strictEqual(fullFeed.status, 200);
  assert.match(fullFeed.text, /BEGIN:VCALENDAR/);
  assert.match(fullFeed.text, /Piano recital/);
  assert.strictEqual((await anon('GET', `/api/calendar/${share.token}.ics`)).status, 200);
  assert.strictEqual((await anon('GET', `/share/${share.token}`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/share/${share.token}/events`)).status, 200);

  const wrong = 'x'.repeat(share.token.length);
  for (const url of [
    `/api/calendar/${wrong}.ics`,
    `/api/calendar/all/${wrong}.ics`,
    `/api/calendar/all/${share.token}.ics`, // the view-only secret can't open the full feed
    `/share/${wrong}`,
    `/api/share/${wrong}/events`,
  ]) {
    const r = await anon('GET', url);
    assert.strictEqual(r.status, 404, url);
    assert.doesNotMatch(r.text, /Piano recital/, url);
  }

  assert.strictEqual((await owner('POST', '/api/share/revoke')).status, 200);
  assert.strictEqual((await owner('POST', '/api/share/full/revoke')).status, 200);
  assert.strictEqual((await anon('GET', `/api/calendar/${share.token}.ics`)).status, 404);
  assert.strictEqual((await anon('GET', `/api/calendar/all/${fullToken}.ics`)).status, 404);
  assert.strictEqual((await anon('GET', `/share/${share.token}`)).status, 404);

  assert.doesNotMatch(srv.log(), new RegExp(share.token), 'the share secret must not be logged');
  assert.doesNotMatch(srv.log(), new RegExp(fullToken), 'the full-feed secret must not be logged');
});

test('API keys: read and write events, but cannot manage keys or the password', async (t) => {
  const srv = await startServer(t);
  const owner = await setUp(srv);

  assert.strictEqual((await owner('POST', '/api/keys', { body: {} })).status, 400, 'a key needs a name');
  const made = await owner('POST', '/api/keys', { body: { name: 'Wall tablet' } });
  assert.strictEqual(made.status, 200, made.text);
  const { id, key } = made.json;
  assert.match(key, /^kb_[A-Za-z0-9_-]{40,}$/);

  const listed = (await owner('GET', '/api/keys')).json;
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, 'Wall tablet');
  assert.ok(!JSON.stringify(listed).includes(key), 'the key itself is shown once, never listed');

  const bot = srv.client();
  const bearer = { authorization: `Bearer ${key}` };
  assert.strictEqual((await bot('GET', '/api/events', { headers: bearer })).status, 200);
  const made2 = await bot('POST', '/api/events', { headers: bearer, body: { title: 'From a script', date: soon(), allDay: true } });
  assert.strictEqual(made2.status, 200, made2.text);

  assert.strictEqual((await bot('GET', '/api/keys', { headers: bearer })).status, 401);
  assert.strictEqual((await bot('POST', '/api/keys', { headers: bearer, body: { name: 'Another' } })).status, 401);
  assert.strictEqual((await bot('DELETE', `/api/keys/${id}`, { headers: bearer })).status, 401);
  assert.strictEqual((await bot('POST', '/api/account/password', {
    headers: bearer, body: { currentPassword: PASSWORD, newPassword: 'taken-over' },
  })).status, 401);

  // A request carrying a key is judged on the key alone, even with a valid session.
  assert.strictEqual((await owner('GET', '/api/events', { headers: { authorization: 'Bearer kb_not-a-real-key' } })).status, 401);
  assert.strictEqual((await bot('GET', '/api/events', { headers: { authorization: 'Bearer kb_not-a-real-key' } })).status, 401);

  assert.strictEqual((await owner('DELETE', `/api/keys/${id}`)).status, 200);
  assert.strictEqual((await bot('GET', '/api/events', { headers: bearer })).status, 401, 'a revoked key stops working');
  assert.strictEqual((await owner('DELETE', `/api/keys/${id}`)).status, 404);
  assert.ok(!srv.log().includes(key), 'the key must not be logged');
});
