// Web Push transport: a thin wrapper over the send API plus an isEnabled() gate,
// so callers can fire notifications unconditionally and safely no-op when push
// isn't usable.
//
// VAPID keys are generated once and persisted in the push_config table rather
// than read from env. That's deliberate for self-hosting — the whole point is
// that someone runs `docker compose up` and notifications work, with no key
// management or signup step.
//
// NOTE: Web Push only works from a secure context (HTTPS, or localhost). The
// server can't detect that — the browser enforces it — so the client hides the
// notification UI when window.isSecureContext is false. See public/settings.html.

const webpush = require('web-push');
const db = require('./db');

let cachedKeys = null;

function getVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const row = db.raw.prepare('SELECT vapid_public, vapid_private FROM push_config WHERE id = 1').get();
  if (row) {
    cachedKeys = { publicKey: row.vapid_public, privateKey: row.vapid_private };
    return cachedKeys;
  }

  // First use — mint a keypair and persist it. INSERT OR IGNORE guards the
  // (unlikely) race where two requests both find the table empty; whoever loses
  // simply re-reads the winner's keys below.
  const generated = webpush.generateVAPIDKeys();
  db.raw
    .prepare('INSERT OR IGNORE INTO push_config (id, vapid_public, vapid_private) VALUES (1, ?, ?)')
    .run(generated.publicKey, generated.privateKey);
  const stored = db.raw.prepare('SELECT vapid_public, vapid_private FROM push_config WHERE id = 1').get();
  cachedKeys = { publicKey: stored.vapid_public, privateKey: stored.vapid_private };
  console.log('[push] generated a new VAPID keypair');
  return cachedKeys;
}

function getPublicKey() {
  return getVapidKeys().publicKey;
}

// Which push service a subscription belongs to — Apple, Google or Microsoft.
// Worth logging, because a failure is very often specific to one of them.
function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'unknown host'; }
}

// The `mailto:`/URL identifying this server to the push service. Push services
// use it to contact an operator about misbehaving traffic; it is not required to
// be reachable, and nothing is sent to it.
//
// The default used to be `mailto:kinboard@localhost`, which Apple rejects with a
// 403: its push service validates the JWT `sub` claim and will not accept a
// mailto whose domain isn't well formed. Google and Microsoft accept it happily,
// so push failed *only* on iPhones and iPads — and the sole visible symptom was
// "Nothing was sent" in Settings. An https URL is accepted everywhere.
const DEFAULT_VAPID_SUBJECT = 'https://github.com/raymondoooo/kinboard';

function vapidSubject() {
  const configured = (process.env.VAPID_SUBJECT || '').trim();
  if (!configured) return DEFAULT_VAPID_SUBJECT;
  // A malformed override resurrects exactly the bug above: silent, and only on
  // Apple devices. Refuse it rather than sign a claim that can't be delivered.
  const ok = /^https:\/\/[^\s/]+\.[^\s/]+/i.test(configured)
    || /^mailto:[^@\s]+@[^@\s.]+\.[^@\s.]+/i.test(configured);
  if (!ok) {
    console.warn(
      `[push] ignoring VAPID_SUBJECT="${configured}" — it must be an https:// URL, or a ` +
      'mailto: address with a real domain. Apple rejects anything else with a 403. ' +
      `Falling back to ${DEFAULT_VAPID_SUBJECT}`
    );
    return DEFAULT_VAPID_SUBJECT;
  }
  return configured;
}

// Always "available" since the keys self-generate. Kept as a function anyway so
// every caller has one uniform gate to check, and so a future build that sources
// keys from the environment can report "not configured" without touching callers.
function isEnabled() {
  return true;
}

function applyVapid() {
  const { publicKey, privateKey } = getVapidKeys();
  webpush.setVapidDetails(vapidSubject(), publicKey, privateKey);
}

// Send to one subscription row. Returns true on success. A 404/410 from the push
// service means the browser threw the subscription away (uninstalled the PWA,
// cleared site data, revoked permission) — that's not an error worth surfacing,
// it just means the row is garbage, so delete it.
async function sendToSubscription(sub, payload) {
  if (!isEnabled()) return false;
  applyVapid();

  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 404 || status === 410) {
      db.raw.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      console.log(`[push] pruned expired subscription (${status}) ${(sub.label || sub.endpoint).slice(0, 60)}`);
    } else if (status === 403) {
      // Almost always the VAPID subject, and almost always Apple. "403: Received
      // unexpected response code" on its own sent me looking at keys, the
      // service worker and the payload before the subject.
      console.error(
        `[push] rejected (403) by ${hostOf(sub.endpoint)} — the push service refused our ` +
        `VAPID identity (subject "${vapidSubject()}"). Apple requires an https:// URL or a ` +
        'mailto: with a real domain; set VAPID_SUBJECT if you have overridden it.'
      );
    } else {
      console.error(`[push] send failed to ${hostOf(sub.endpoint)} (${status || 'no status'}): ${err.message}`);
    }
    return false;
  }
}

async function sendToMany(subs, payload) {
  if (!subs || !subs.length) return 0;
  const results = await Promise.all(subs.map((s) => sendToSubscription(s, payload)));
  return results.filter(Boolean).length;
}

module.exports = { isEnabled, getPublicKey, sendToSubscription, sendToMany };
