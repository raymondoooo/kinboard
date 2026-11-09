// One shared household password — no per-member accounts, no magic links, no
// mail server. Scripts and other apps use an API key instead (see the end of
// this file). A session is a signed, expiring cookie: value =
// "<expiresAtMs>.<hmac>", HMAC'd with a secret generated once on setup and
// stored on the household row. No server-side session store is needed since
// there's only ever one credential to invalidate (change the password).

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME = 'kb_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

function getHousehold() {
  return db.raw.prepare('SELECT * FROM household WHERE id = 1').get() || null;
}

function isSetUp() {
  return !!getHousehold();
}

async function completeSetup({ password, name, timeZone }) {
  if (isSetUp()) throw new Error('Already set up');
  const passwordHash = await bcrypt.hash(password, 10);
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  db.raw.prepare('INSERT INTO household (id, password_hash, session_secret) VALUES (1, ?, ?)')
    .run(passwordHash, sessionSecret);

  const updates = {};
  if (name) updates.name = name;
  if (timeZone) updates.time_zone = timeZone;
  if (Object.keys(updates).length) {
    const cols = Object.keys(updates);
    db.raw.prepare(`UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`)
      .run(...cols.map((c) => updates[c]));
  }
}

function sign(secret, expiresAt) {
  return crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
}

function verifySessionCookie(secret, cookieVal) {
  if (!cookieVal || typeof cookieVal !== 'string' || !cookieVal.includes('.')) return false;
  const [expiresAtStr, mac] = cookieVal.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || !mac || Date.now() > expiresAt) return false;
  const expected = sign(secret, expiresAt);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mark the session cookie HTTPS-only. Opt-in rather than automatic (and
// deliberately NOT tied to NODE_ENV): plenty of people run this on a bare LAN
// address with no TLS, and setting `secure` there means the browser accepts the
// cookie at login and then refuses to send it back — you'd bounce to the login
// form forever with no error explaining why. Turn it on if you serve over HTTPS.
const SECURE_COOKIES = ['1', 'true', 'yes'].includes((process.env.SECURE_COOKIES || '').trim().toLowerCase());

function issueSessionCookie(res, household) {
  const expiresAt = Date.now() + SESSION_MS;
  const value = `${expiresAt}.${sign(household.session_secret, expiresAt)}`;
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MS,
    secure: SECURE_COOKIES,
  });
}

// Populates req.setupDone / req.authed on every request. Non-blocking — routes
// that need to enforce it call requireAuth (or check req.setupDone themselves
// for the /setup page redirect).
function attachAuth(req, res, next) {
  const household = getHousehold();
  req.setupDone = !!household;
  req.apiKeyId = null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (req.setupDone && bearer) {
    // A request that presents a key is judged on the key alone.
    req.apiKeyId = apiKeyIdFor(bearer[1]);
    req.authed = !!req.apiKeyId;
  } else {
    req.authed = req.setupDone && verifySessionCookie(household.session_secret, req.cookies?.[COOKIE_NAME]);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.setupDone) return res.status(503).json({ error: 'Setup required', setupRequired: true });
  if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
  next();
}

// For things only a person signed in with the password may do — creating and
// revoking API keys. Otherwise one leaked key could mint itself replacements
// and outlive being revoked.
function requireSession(req, res, next) {
  if (!req.setupDone) return res.status(503).json({ error: 'Setup required', setupRequired: true });
  if (!req.authed || req.apiKeyId) return res.status(401).json({ error: 'Sign in with the household password to manage API keys' });
  next();
}

async function setupHandler(req, res) {
  if (isSetUp()) return res.status(409).json({ error: 'Already set up' });
  const { name, timeZone, password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  await completeSetup({
    password,
    name: name ? String(name).trim().slice(0, 100) : null,
    timeZone: timeZone ? String(timeZone).trim().slice(0, 100) : null,
  });
  issueSessionCookie(res, getHousehold());
  res.json({ ok: true });
}

async function loginHandler(req, res) {
  const household = getHousehold();
  if (!household) return res.status(503).json({ error: 'Setup required', setupRequired: true });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const ok = await bcrypt.compare(password, household.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  issueSessionCookie(res, household);
  res.json({ ok: true });
}

function logoutHandler(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}

async function changePasswordHandler(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const household = getHousehold();
  const ok = await bcrypt.compare(currentPassword || '', household.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  const passwordHash = await bcrypt.hash(newPassword, 10);

  // Rotate the signing secret too, which is what actually invalidates every
  // existing session. Changing only the hash left old cookies working — so
  // someone changing the password *because it leaked* would believe they had
  // kicked the intruder out while the intruder stayed signed in indefinitely.
  // The one thing a password change must do is end other people's access.
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  db.raw
    .prepare('UPDATE household SET password_hash = ?, session_secret = ? WHERE id = 1')
    .run(passwordHash, sessionSecret);

  // Re-issue for the caller against the new secret, so the person who just
  // changed it isn't logged out of their own browser as a side effect.
  issueSessionCookie(res, getHousehold());

  res.json({ ok: true });
}

// ── API keys ────────────────────────────────────────────────────────────────
// "kb_" + 32 random bytes. Keys are long and random, so a plain SHA-256 is the
// right hash: it's fast enough to check on every request, and there's nothing
// to brute-force the way there is with a password.
const KEY_PREFIX = 'kb_';

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function apiKeyIdFor(key) {
  if (!key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const row = db.raw.prepare('SELECT id, last_used_at FROM api_keys WHERE key_hash = ?').get(hashKey(key));
  if (!row) return null;
  // "Last used" is for spotting a key nobody needs any more, so minute-level is
  // plenty — don't write to the database on every request.
  const now = new Date();
  if (!row.last_used_at || now - new Date(row.last_used_at) > 60_000) {
    db.raw.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }
  return row.id;
}

function listKeys(req, res) {
  res.json(db.raw.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at').all());
}

function createKey(req, res) {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the key a name, e.g. what it is for' });
  if (db.raw.prepare('SELECT count(*) n FROM api_keys').get().n >= 50) {
    return res.status(400).json({ error: 'Too many API keys — revoke some you no longer use' });
  }
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  db.raw.prepare('INSERT INTO api_keys (id, name, key_hash, prefix) VALUES (?, ?, ?, ?)')
    .run(id, name, hashKey(key), key.slice(0, 7));
  // The only time the key itself ever leaves the server.
  res.json({ id, name, key });
}

function revokeKey(req, res) {
  const { changes } = db.raw.prepare('DELETE FROM api_keys WHERE id = ?').run(String(req.params.id));
  if (!changes) return res.status(404).json({ error: 'No such key' });
  res.json({ ok: true });
}

module.exports = {
  isSetUp,
  attachAuth,
  requireAuth,
  requireSession,
  listKeys,
  createKey,
  revokeKey,
  setupHandler,
  loginHandler,
  logoutHandler,
  changePasswordHandler,
  COOKIE_NAME,
};
