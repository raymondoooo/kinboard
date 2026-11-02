const crypto = require('crypto');
const path = require('path');
const { RRule } = require('rrule');
const db = require('../db');
const { buildIcs } = require('../ics');

function getSettings() {
  return db.decodeRow('settings', db.raw.prepare('SELECT * FROM settings WHERE id = 1').get());
}

// The .ics itself is written by server/ics.js; this file decides which events
// go in it.

// ── Token resolution ────────────────────────────────────────────────────────
// The URL token IS the access grant — works even when the calendar is
// private, since viewing via a share link is always allowed.

function tokenMatches(req, settings, column = 'share_token') {
  // Tolerate a trailing ".ics" so a single route works for both the feed URL
  // (…/UUID.ics) and the plain token, regardless of Express suffix parsing.
  const token = String(req.params.token || '').replace(/\.ics$/i, '');
  return !!(settings[column] && token && settings[column] === token);
}

function filenameSlug(name) {
  const slug = String(name || 'kinboard').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'kinboard';
}

// Build and send a .ics of native events (RRULE VEVENTs) plus live-feed
// occurrences (expanded) — `nativeOk`/`feedOk`/`titleOk` decide what's in it.
async function sendIcs(res, settings, { nativeOk, feedOk, titleOk, daysBack = 0 }) {
  const tz = settings.time_zone || 'America/New_York';

  const [{ data: events, error }, { data: members }, { data: feeds }] = await Promise.all([
    db.from('events').select('*').order('date', { ascending: true }),
    db.from('members').select('display_name, color'),
    db.from('feeds').select('*'),
  ]);
  if (error) return res.status(500).send('Error');

  const native = (events || []).filter(nativeOk);

  // Feed occurrences within the same forward window as the web share.
  let feedOccs = [];
  try {
    const { fetchFeedEvents } = require('../index');
    const included = (feeds || []).filter(feedOk);
    if (typeof fetchFeedEvents === 'function' && included.length) {
      const start = tenantToday(tz);
      const end = new Date(start); end.setDate(end.getDate() + SHARE_WINDOW_DAYS);
      start.setDate(start.getDate() - daysBack);
      const colors = {};
      for (const m of members || []) { if (m.display_name) colors[m.display_name] = m.color; }
      const personNames = (members || []).map(m => m.display_name).filter(Boolean);
      const arrs = await Promise.all(included.map(f => fetchFeedEvents(f, start, end, colors, personNames, [])));
      feedOccs = arrs.flat().filter(fev => titleOk(fev.title));
    }
  } catch (e) {
    console.error(`[share .ics] feed merge failed: ${e.message}`);
  }

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${filenameSlug(settings.name)}.ics"`);
  res.send(buildIcs(settings, native, feedOccs));
}

// GET /api/calendar/:token.ics  (webcal subscribe URL)
// Mirrors the share page: only SHARED events (keyword rule + per-event override
// for native; keyword rule for live feeds) are emitted, so a subscription never
// broadcasts private events.
async function icsHandler(req, res) {
  const settings = getSettings();
  if (!tokenMatches(req, settings)) return res.status(404).send('Not found');
  const matches = makeMatcher(settings.share_keywords);
  return sendIcs(res, settings, {
    nativeOk: ev => nativeShared(ev, matches),
    feedOk: f => !f.never_share, // per-feed opt-out
    titleOk: matches,
  });
}

// GET /api/calendar/all/:token.ics  (the full feed)
// Everything on the calendar — no keyword filter, and the "never share"
// overrides don't apply: those govern the view-only links, and this feed is for
// the household's own apps. Its token is separate from share_token, so the
// filtered link can't be turned into this one, and each is revoked on its own.
// A month of past feed events is kept so a phone's recent days aren't blank.
async function fullIcsHandler(req, res) {
  const settings = getSettings();
  if (!tokenMatches(req, settings, 'full_share_token')) return res.status(404).send('Not found');
  return sendIcs(res, settings, { nativeOk: () => true, feedOk: () => true, titleOk: () => true, daysBack: 30 });
}

// GET /share/:token  (human-readable read-only page)
function shareViewHandler(req, res) {
  const settings = getSettings();
  if (!tokenMatches(req, settings)) return res.status(404).sendFile(path.join(__dirname, '..', '..', 'public', 'share-404.html'));
  // The static page reads the token from its own URL and fetches the public feed.
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'share.html'));
}

// ── Share-page expansion ─────────────────────────────────────────────────────
// The share WEB page shows a flat agenda, so we expand recurrences server-side
// (using the real rrule library — same engine as the main app) into a bounded
// window and hand the page a plain list. The .ics feed above stays unexpanded on
// purpose (subscriber apps expand it themselves); only this page pre-expands.
const SHARE_WINDOW_DAYS = 180;

function parseYMD(s) { return new Date(String(s).slice(0, 10) + 'T00:00:00'); }
function toYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// "Today" anchored to the household's timezone (the viewer could be elsewhere).
function tenantToday(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return new Date(`${g('year')}-${g('month')}-${g('day')}T00:00:00`);
}

// ── Selective sharing ────────────────────────────────────────────────────────
// An event reaches the share if a household share-keyword appears in its title.
// Native events additionally honor a per-event override (always / never); feed
// events can only follow the keyword rule (no row to store an override on).
function makeMatcher(keywords) {
  const kws = (keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
  return title => {
    if (!kws.length) return false;
    const t = String(title || '').toLowerCase();
    return kws.some(k => t.includes(k));
  };
}
function nativeShared(ev, matches) {
  if (ev.share_override === 'always') return true;
  if (ev.share_override === 'never') return false;
  return matches(ev.title);
}

// "6:30pm" from a stored "HH:MM:SS" (already local wall-clock — no tz needed).
function labelFromHM(hms) {
  if (!hms) return '';
  const [h, m] = String(hms).split(':');
  const hr = ((+h + 11) % 12) + 1;
  return `${hr}:${m}${+h < 12 ? 'am' : 'pm'}`;
}
// Feed timed events carry a UTC ISO instant; render date + label in household tz.
function localParts(iso, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = t => p.find(x => x.type === t).value;
  let h = +g('hour'); if (h === 24) h = 0;
  const hr = ((h + 11) % 12) + 1;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hm: `${String(h).padStart(2, '0')}:${g('minute')}`, label: `${hr}:${g('minute')}${h < 12 ? 'am' : 'pm'}` };
}
function nthWeekdayShare(year, month, weekday, ordinal) {
  if (ordinal >= 5) {
    const lastDow = new Date(year, month + 1, 0).getDay();
    return new Date(year, month + 1, -((lastDow - weekday + 7) % 7));
  }
  const firstDow = new Date(year, month, 1).getDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
  const t = new Date(year, month, day);
  return t.getMonth() === month ? t : null;
}
// Occurrence date-keys for one event within [start, end] (inclusive), honoring
// rrule / legacy recurring / ends_on / exdates. Non-recurring events are
// included ONLY when their own date falls in the window.
function expandForShare(ev, start, end) {
  const ex = new Set((ev.exdates || []).map(x => String(x).slice(0, 10)));
  const keep = d => d >= start && d <= end && !ex.has(toYMD(d));
  const first = parseYMD(ev.date);
  const endsOn = ev.ends_on ? parseYMD(ev.ends_on) : null;
  const hardEnd = (endsOn && endsOn < end) ? endsOn : end;

  if (ev.rrule) {
    try {
      const rule = new RRule({ ...RRule.parseString(ev.rrule), dtstart: first });
      return rule.between(start, hardEnd, true).map(toYMD).filter(k => !ex.has(k));
    } catch { return []; }
  }
  if (!ev.recurring) return keep(first) ? [toYMD(first)] : [];

  const out = [];
  if (ev.recurring === 'monthly_dow') {
    const weekday = first.getDay();
    const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const ordinal = first.getDate() + 7 > dim ? 5 : Math.ceil(first.getDate() / 7);
    let y = first.getFullYear(), mo = first.getMonth(), guard = 0;
    while (new Date(y, mo, 1) <= hardEnd && guard++ < 2400) {
      const occ = nthWeekdayShare(y, mo, weekday, ordinal);
      if (occ && keep(occ)) out.push(toYMD(occ));
      if (++mo > 11) { mo = 0; y++; }
    }
    return out;
  }
  const step = { daily: c => c.setDate(c.getDate() + 1), weekly: c => c.setDate(c.getDate() + 7),
                 monthly: c => c.setMonth(c.getMonth() + 1), yearly: c => c.setFullYear(c.getFullYear() + 1) }[ev.recurring];
  if (!step) return keep(first) ? [toYMD(first)] : [];
  let cur = new Date(first), guard = 0;
  while (cur <= hardEnd && guard++ < 5000) {
    if (keep(cur)) out.push(toYMD(cur));
    step(cur);
  }
  return out;
}

// Gather the events that are shared (native + live feeds), expanded into the
// window and normalized into flat occurrences. Shared by the web page and .ics.
async function collectSharedOccurrences(settings) {
  const tz = settings.time_zone || 'America/New_York';
  const start = tenantToday(tz);
  const end = new Date(start); end.setDate(end.getDate() + SHARE_WINDOW_DAYS);
  const startKey = toYMD(start), endKey = toYMD(end);
  const matches = makeMatcher(settings.share_keywords);

  const [{ data: events }, { data: members }, { data: feeds }] = await Promise.all([
    db.from('events')
      // `rrule`/`share_override` must be selected — the former so imported
      // recurring events expand correctly, the latter for the per-event rule.
      .select('id, title, date, start_time, end_time, all_day, people, location, recurring, rrule, ends_on, exdates, share_override')
      .order('date', { ascending: true }),
    db.from('members').select('display_name, color'),
    db.from('feeds').select('*'),
  ]);

  const colors = {};
  for (const m of members || []) { if (m.display_name) colors[m.display_name] = m.color; }

  const occ = [];

  // Native events — keyword rule + per-event override.
  for (const ev of events || []) {
    if (!nativeShared(ev, matches)) continue;
    for (const dateKey of expandForShare(ev, start, end)) {
      occ.push({
        date: dateKey, title: ev.title,
        all_day: !!ev.all_day, hm: (ev.all_day || !ev.start_time) ? '' : String(ev.start_time).slice(0, 5),
        timeLabel: (ev.all_day || !ev.start_time) ? '' : labelFromHM(ev.start_time),
        people: ev.people || [], location: ev.location || null,
        color: (ev.people && ev.people[0] && colors[ev.people[0]]) || null,
      });
    }
  }

  // Live iCal-feed events — keyword rule only (no row to store an override on).
  // fetchFeedEvents is reused from index.js (lazy require avoids a circular
  // init); a feed fetch failure must not break the share page.
  try {
    const { fetchFeedEvents } = require('../index');
    const shareableFeeds = (feeds || []).filter(f => !f.never_share); // per-feed opt-out
    if (typeof fetchFeedEvents === 'function' && shareableFeeds.length) {
      const personNames = (members || []).map(m => m.display_name).filter(Boolean);
      const feedArrays = await Promise.all(shareableFeeds.map(f => fetchFeedEvents(f, start, end, colors, personNames, [])));
      for (const fev of feedArrays.flat()) {
        if (!matches(fev.title)) continue;
        let date, hm, timeLabel;
        if (fev.allDay) { date = String(fev.start).slice(0, 10); hm = ''; timeLabel = ''; }
        else { const lp = localParts(fev.start, tz); date = lp.date; hm = lp.hm; timeLabel = lp.label; }
        if (date < startKey || date > endKey) continue;
        occ.push({
          date, title: fev.title, all_day: !!fev.allDay, hm, timeLabel,
          people: fev.people || [], location: fev.location || null,
          color: fev.color || (fev.people && fev.people[0] && colors[fev.people[0]]) || null,
        });
      }
    }
  } catch (e) {
    console.error(`[share] feed merge failed: ${e.message}`);
  }

  occ.sort((a, b) => a.date.localeCompare(b.date) || a.hm.localeCompare(b.hm));
  return { occ, startKey };
}

// Public read-only events for the share page (token-gated, no login needed).
async function shareEventsHandler(req, res) {
  const settings = getSettings();
  if (!tokenMatches(req, settings)) return res.status(404).json({ error: 'Not found' });
  const { occ, startKey } = await collectSharedOccurrences(settings);
  res.json({
    calendarName: settings.name,
    timeZone: settings.time_zone,
    windowDays: SHARE_WINDOW_DAYS,
    today: startKey,
    occurrences: occ,
  });
}

// ── Owner controls (authed) ─────────────────────────────────────────────────

function shareUrls(req, settings) {
  const base = `${req.protocol}://${req.get('host')}`;
  const out = { token: null, fullIcsUrl: null };
  if (settings.share_token) {
    out.token = settings.share_token;
    out.shareUrl = `${base}/share/${settings.share_token}`;
    out.icsUrl = `${base}/api/calendar/${settings.share_token}.ics`;
  }
  if (settings.full_share_token) out.fullIcsUrl = `${base}/api/calendar/all/${settings.full_share_token}.ics`;
  return out;
}

// Owner-authed — never exposed via /api/config (which viewers can read).
async function shareStatus(req, res) {
  res.json(shareUrls(req, getSettings()));
}

async function generateShareToken(req, res) {
  const token = crypto.randomUUID();
  db.raw.prepare('UPDATE settings SET share_token = ? WHERE id = 1').run(token);
  res.json(shareUrls(req, getSettings()));
}

async function revokeShareToken(req, res) {
  db.raw.prepare('UPDATE settings SET share_token = NULL WHERE id = 1').run();
  res.json({ ok: true });
}

async function generateFullToken(req, res) {
  db.raw.prepare('UPDATE settings SET full_share_token = ? WHERE id = 1').run(crypto.randomUUID());
  res.json(shareUrls(req, getSettings()));
}

async function revokeFullToken(req, res) {
  db.raw.prepare('UPDATE settings SET full_share_token = NULL WHERE id = 1').run();
  res.json({ ok: true });
}

module.exports = {
  icsHandler,
  fullIcsHandler,
  shareViewHandler,
  shareEventsHandler,
  shareStatus,
  generateShareToken,
  revokeShareToken,
  generateFullToken,
  revokeFullToken,
};
