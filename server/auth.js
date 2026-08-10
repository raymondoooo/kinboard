// One shared household password — no per-member accounts, no magic links, no
// mail server. A session is a signed, expiring cookie: value =
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
  req.authed = req.setupDone && verifySessionCookie(household.session_secret, req.cookies?.[COOKIE_NAME]);
  next();
}

function requireAuth(req, res, next) {
  if (!req.setupDone) return res.status(503).json({ error: 'Setup required', setupRequired: true });
  if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
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
  db.raw.prepare('UPDATE household SET password_hash = ? WHERE id = 1').run(passwordHash);
  res.json({ ok: true });
}

module.exports = {
  isSetUp,
  attachAuth,
  requireAuth,
  setupHandler,
  loginHandler,
  logoutHandler,
  changePasswordHandler,
  COOKIE_NAME,
};
