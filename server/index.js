require('dotenv').config();

const fs = require('fs');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cron = require('node-cron');

const { RRule } = require('rrule');
const db = require('./db');
const auth = require('./auth');
const push = require('./push');
const notify = require('./notify');
const share = require('./routes/share');
const meals = require('./routes/meals');
const todos = require('./routes/todos');
const { geocodeZip } = require('./geocode');
const { THEMES, HEX_RE, cleanEmoji } = require('./validate');

const app = express();
const PORT = process.env.PORT || 3000;

// Whether to believe X-Forwarded-* headers. OFF by default, and that default is
// a security boundary, not a convenience: `trust proxy` makes Express derive
// req.ip and req.protocol from client-supplied headers, so trusting it
// unconditionally lets anyone forge X-Forwarded-For and defeat the per-IP login
// rate limiter below — unlimited guesses at the one household password.
//
// Set TRUST_PROXY when (and only when) something in front of this container is
// setting those headers:
//   TRUST_PROXY=1            one proxy hop — the right answer for Caddy/nginx/NPM
//   TRUST_PROXY=true         trust the whole chain (only if you control all of it)
//   TRUST_PROXY=10.0.0.0/8   trust specific proxy addresses
//
// Leaving it unset behind a proxy is safe but blunt: every request then looks
// like it came from the proxy, so the login limiter becomes global and one
// person's typos can lock out the household for a few minutes.
// Where the settings page's "Support Kinboard" button points. Defaults to the
// project's own donation page; set DONATE_URL to redirect it, or set it to an
// EMPTY value to hide the button entirely. (Checked against undefined rather
// than falsiness precisely so `DONATE_URL=` in .env means "hide" instead of
// silently falling back to the default.)
const DONATE_URL = process.env.DONATE_URL !== undefined
  ? process.env.DONATE_URL
  : 'https://ko-fi.com/raymondoooo';

const TRUST_PROXY = (process.env.TRUST_PROXY || '').trim();
if (TRUST_PROXY) {
  const n = Number(TRUST_PROXY);
  app.set('trust proxy', TRUST_PROXY === 'true' ? true : (Number.isInteger(n) ? n : TRUST_PROXY));
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});
app.use(auth.attachAuth);

// ── Lightweight per-IP rate limiter ──
// In-memory (fine for a single app instance). Used on the abuse-prone
// unauthenticated endpoints below (login, public share links).
const rlBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rlBuckets) if (now > v.resetAt) rlBuckets.delete(k);
}, 5 * 60 * 1000);
function rateLimit({ max = 60, windowMs = 60_000 } = {}) {
  return (req, res, next) => {
    // req.ip ONLY — never read X-Forwarded-For directly. Express already derives
    // req.ip from that header when (and only when) TRUST_PROXY says the header is
    // trustworthy, so this is spoof-proof by default and correct behind a proxy.
    // Reading the raw header here is what made the limiter bypassable.
    const ip = req.ip || 'unknown';
    const key = `${req.path}|${ip}`;
    const now = Date.now();
    const rec = rlBuckets.get(key);
    if (!rec || now > rec.resetAt) { rlBuckets.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    next();
  };
}

// ── Setup / login / logout ──
app.post('/api/setup', auth.setupHandler);
app.post('/api/login', rateLimit({ max: 10, windowMs: 5 * 60 * 1000 }), auth.loginHandler);
app.post('/api/logout', auth.logoutHandler);
app.post('/api/account/password', auth.requireAuth, auth.changePasswordHandler);

// ── Pages ──
app.get('/setup', (req, res) => {
  if (req.setupDone) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});
app.get('/', (req, res) => {
  if (!req.setupDone) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('/settings', (req, res) => {
  if (!req.setupDone) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
});

async function getSettings() {
  const { data } = await db.from('settings').select('*').eq('id', 1).single();
  return data;
}

// Gate read access. A household may opt into a public, read-only calendar
// (is_public = true); otherwise the viewer must be logged in with the
// household password. Defaults to private.
async function requireViewAccess(req, res, next) {
  if (!req.setupDone) return res.status(503).json({ error: 'Setup required', setupRequired: true });
  const settings = await getSettings();
  if (settings.is_public) return next();
  if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
  next();
}

// ── Map a DB event row to the shape the frontend expects (start/end ISO strings) ──
function toClientEvent(row) {
  const date = row.date; // "YYYY-MM-DD"
  let start, end;
  if (row.all_day || !row.start_time) {
    // All-day contract (shared with fetchFeedEvents/generateHolidayEvents):
    // local-midnight strings, "T00:00:00" already included, end EXCLUSIVE
    // (next day). The frontend's day-overlap filter relies on every all-day
    // producer emitting exactly this shape — do not switch back to a bare
    // "YYYY-MM-DD" here without also updating eventsForDay() in index.html.
    start = date + 'T00:00:00';
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    end = d.toISOString().slice(0, 10) + 'T00:00:00';
  } else {
    start = `${date}T${row.start_time}`;
    end   = `${date}T${row.end_time || row.start_time}`;
  }
  return {
    uid: row.id,
    title: row.title,
    start,
    end,
    allDay: !!row.all_day,
    people: row.people || [],
    location: row.location,
    recurring: row.recurring,
    // `recurring` is only the LEGACY pattern field (drives the repeat
    // dropdown's literal value); an imported/custom RRULE row has recurring=null
    // but is still very much part of a series. hasSeries is the field the client
    // uses to decide whether "delete/edit this occurrence only" applies at
    // all — checking `recurring` alone there would treat every RRULE series as
    // a plain one-off (wrong scope on delete = data loss). `rrule` is exposed so
    // the edit form can read a custom pattern back into its builder.
    hasSeries: !!(row.recurring || row.rrule),
    rrule: row.rrule || null,
    // Per-event share override (always | never | null=follow keywords). The
    // client uses it + the household's shareKeywords to show the "shared"
    // state and to drive the edit-form control.
    shareOverride: row.share_override || null,
    endsOn: row.ends_on,
  };
}

// ── Native recurring events ────────────────────────────────────────────────
// A recurring event is ONE master row (events.recurring = daily|weekly|monthly|
// yearly) that we expand into occurrences at read time — mirroring how iCal feeds
// and holidays are expanded into the same [windowStart, windowEnd] the calendar
// shows. Each occurrence keeps the master's uid (so the client's edit/delete-by-
// uid + instanceStart wiring works) and carries its own start/end for that date.
const RECUR_DAY_MS = 24 * 60 * 60 * 1000;
// 'monthly_dow' = "the Nth <weekday> of each month" (e.g. 3rd Friday). The weekday
// and ordinal aren't stored — they're derived from the series' anchor date, so no
// schema change was needed.
const RECUR_RULES = new Set(['daily', 'weekly', 'monthly', 'yearly', 'monthly_dow']);

function fmtLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Which ordinal an anchor date represents within its month: 1–4, or 5 meaning
// "last" (used when the anchor is the final occurrence of its weekday that month,
// e.g. a 5th Friday, or a 4th that happens to be the last). Matches how common
// calendar apps interpret "the Nth weekday" from a picked date.
function dowOrdinal(d) {
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const isLast = d.getDate() + 7 > daysInMonth;
  return isLast ? 5 : Math.ceil(d.getDate() / 7);
}

// The Date for the `ordinal`-th `weekday` in a given month (ordinal 5 = last).
// Returns null only if a fixed 1–4 ordinal can't exist (never happens — every
// month has ≥4 of each weekday), which keeps the caller's skip logic uniform.
function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  if (ordinal >= 5) {
    const lastDow = new Date(year, month + 1, 0).getDay();
    const back = (lastDow - weekday + 7) % 7;
    return new Date(year, month + 1, -back);           // last <weekday> of the month
  }
  const firstDow = new Date(year, month, 1).getDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (ordinal - 1) * 7;
  const t = new Date(year, month, day);
  return t.getMonth() === month ? t : null;
}

// The i-th occurrence date for a rule, anchored at `first`. Returns null when the
// rule yields no valid date for that step — monthly on the 31st in a short month,
// yearly on Feb 29 in a common year — so the caller skips it and keeps going.
function occurrenceDate(first, rule, i) {
  const y = first.getFullYear(), m = first.getMonth(), d = first.getDate();
  let t;
  switch (rule) {
    case 'daily':   return new Date(y, m, d + i);
    case 'weekly':  return new Date(y, m, d + 7 * i);
    case 'monthly': t = new Date(y, m + i, d); return t.getDate() === d ? t : null;
    case 'yearly':  t = new Date(y + i, m, d); return t.getDate() === d ? t : null;
    case 'monthly_dow': return nthWeekdayOfMonth(y, m + i, first.getDay(), dowOrdinal(first));
    default:        return null;
  }
}

// A monotonically increasing bound date for step i — used purely to know when to
// stop iterating (occurrenceDate can be null on skipped steps and can't drive the
// stop condition on its own).
function occurrenceBound(first, rule, i) {
  const y = first.getFullYear(), m = first.getMonth(), d = first.getDate();
  switch (rule) {
    case 'daily':   return new Date(y, m, d + i);
    case 'weekly':  return new Date(y, m, d + 7 * i);
    case 'monthly': return new Date(y, m + i, 1);
    case 'monthly_dow': return new Date(y, m + i, 1);
    case 'yearly':  return new Date(y + i, 0, 1);
    default:        return new Date(8640000000000000);
  }
}

// Imported events (Google/Apple/Outlook/etc.) can carry an RFC5545 RRULE that
// doesn't map onto the legacy daily/weekly/monthly/yearly/monthly_dow model
// (multi-weekday BYDAY, INTERVAL>1, an explicit UNTIL). When row.rrule is set
// it takes over expansion entirely — recurring/ends_on are ignored for that
// row. exdates still applies unchanged: it's just a set of excluded calendar
// dates, agnostic to how occurrences were generated.
function expandRruleRecurring(row, windowStart, windowEnd) {
  const first = new Date(row.date + 'T00:00:00'); // local midnight of series start — same anchor convention as the legacy path
  let rule;
  try {
    rule = new RRule({ ...RRule.parseString(row.rrule), dtstart: first });
  } catch (err) {
    console.error(`[rrule] failed to parse "${row.rrule}" for event ${row.id}: ${err.message}`);
    return [];
  }

  const endsOn = row.ends_on ? new Date(row.ends_on + 'T23:59:59') : null;
  const hardEnd = (endsOn && endsOn < windowEnd) ? endsOn : windowEnd;
  const exdates = new Set((row.exdates || []).map(x => (typeof x === 'string' ? x.slice(0, 10) : fmtLocalDate(new Date(x)))));

  // rrule.js handles its own iteration/UNTIL bounding internally — no manual
  // step-guard loop needed here (unlike the legacy hand-rolled path below).
  const occs = rule.between(windowStart, hardEnd, true);
  const out = [];
  for (const occ of occs) {
    const key = fmtLocalDate(occ);
    if (exdates.has(key)) continue;
    out.push(toClientEvent({ ...row, date: key }));
  }
  return out;
}

function expandRecurring(row, windowStart, windowEnd) {
  if (row.rrule) return expandRruleRecurring(row, windowStart, windowEnd);
  if (!RECUR_RULES.has(row.recurring)) return [toClientEvent(row)];
  const rule = row.recurring;
  const first = new Date(row.date + 'T00:00:00');                 // local midnight of series start
  const endsOn = row.ends_on ? new Date(row.ends_on + 'T23:59:59') : null;
  const hardEnd = (endsOn && endsOn < windowEnd) ? endsOn : windowEnd;
  const exdates = new Set((row.exdates || []).map(x => (typeof x === 'string' ? x.slice(0, 10) : fmtLocalDate(new Date(x)))));

  // Fast-forward the step index to roughly windowStart so long-running series
  // (e.g. a years-old daily event) don't burn the iteration budget on off-screen
  // past occurrences. The −1/−2 backstep keeps a boundary occurrence from being
  // skipped; occurrences before windowStart are filtered out below anyway.
  let i0 = 0;
  if (first < windowStart) {
    if (rule === 'daily')       i0 = Math.max(0, Math.floor((windowStart - first) / RECUR_DAY_MS) - 1);
    else if (rule === 'weekly') i0 = Math.max(0, Math.floor((windowStart - first) / (7 * RECUR_DAY_MS)) - 1);
    else if (rule === 'monthly' || rule === 'monthly_dow') i0 = Math.max(0, (windowStart.getFullYear() - first.getFullYear()) * 12 + (windowStart.getMonth() - first.getMonth()) - 1);
    else if (rule === 'yearly')  i0 = Math.max(0, windowStart.getFullYear() - first.getFullYear() - 1);
  }

  const out = [];
  const MAX = 800; // safety cap on in-loop steps; comfortably covers a year of daily
  for (let i = i0, guard = 0; guard < MAX; i++, guard++) {
    if (occurrenceBound(first, rule, i) > hardEnd) break;
    const occ = occurrenceDate(first, rule, i);
    if (!occ) continue;
    if (occ > hardEnd) break;
    if (occ < windowStart) continue;
    const key = fmtLocalDate(occ);
    if (exdates.has(key)) continue;
    out.push(toClientEvent({ ...row, date: key }));         // same uid, this date's start/end
  }
  return out;
}

// ── iCal feed helpers ──────────────────────────────────────────────────────
const ical = require('node-ical');
const feedCache = new Map(); // feedId → { fetchedAt, events }
const FEED_CACHE_TTL = 3 * 60 * 1000; // 3 min — how quickly source-calendar edits appear

// Detect all-day events: node-ical sets dateOnly for VALUE=DATE type, but some
// providers (TeamSnap, school districts) output midnight-UTC DATETIME instead.
// Treat as all-day when both start and end land on exact UTC day boundaries.
const DAY_MS = 24 * 60 * 60 * 1000;
function detectAllDay(dtstart, dtend) {
  if (!dtstart) return false;
  if (dtstart.dateOnly) return true;
  if (dtstart.getTime() % DAY_MS !== 0) return false;
  if (!dtend) return true;
  return dtend.getTime() % DAY_MS === 0;
}

const VALID_CATEGORIES = new Set(['personal', 'family', 'birthday', 'anniversary', 'holiday']);

// ── Holiday generation ─────────────────────────────────────────────────────
// Compute the nth occurrence of a weekday (0=Sun…6=Sat) in a month (1-based).
function nthWeekday(year, month, weekday, n) {
  const d = new Date(year, month - 1, 1);
  let count = 0;
  while (d.getMonth() === month - 1) {
    if (d.getDay() === weekday && ++count === n) return new Date(d);
    d.setDate(d.getDate() + 1);
  }
  return null;
}
// Last occurrence of a weekday in a month.
function lastWeekday(year, month, weekday) {
  const d = new Date(year, month, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return new Date(d);
}
// Easter date — Anonymous Gregorian algorithm.
function easterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Hanukkah starts at sundown on the listed Gregorian date each year.
// Precomputed via Hebrew calendar tables for 2020-2040.
const HANUKKAH_DATES = {
  2020:[12,10], 2021:[11,28], 2022:[12,18], 2023:[12, 7],
  2024:[12,25], 2025:[12,14], 2026:[12, 4], 2027:[12,22],
  2028:[12,10], 2029:[12,29], 2030:[12,18], 2031:[12, 8],
  2032:[12,26], 2033:[12,15], 2034:[12, 5], 2035:[12,23],
  2036:[12,11], 2037:[11,30], 2038:[12,20], 2039:[12, 9],
  2040:[12,27],
};
function hanukkahDate(year) {
  const e = HANUKKAH_DATES[year];
  return e ? new Date(year, e[0] - 1, e[1]) : null;
}

// Holiday metadata (key/name/emoji) + date rules come from the shared master list,
// which the browser checklists also load. Here we map each `rule` to a real date.
const HOLIDAY_DEFS   = require('../public/holidays.js');
const HOLIDAY_BY_KEY = Object.fromEntries(HOLIDAY_DEFS.map(h => [h.key, h]));

function holidayDate(def, year) {
  const r = def.rule || {};
  switch (r.kind) {
    case 'fixed':    return new Date(year, r.month - 1, r.day);
    case 'nth':      return nthWeekday(year, r.month, r.weekday, r.n);
    case 'last':     return lastWeekday(year, r.month, r.weekday);
    case 'easter':   return easterDate(year);
    case 'hanukkah': return hanukkahDate(year);
    default:         return null;
  }
}

function generateHolidayEvents(selectedKeys, color, windowStart, windowEnd) {
  const events = [];
  const startYear = windowStart.getFullYear();
  const endYear   = windowEnd.getFullYear();
  for (let year = startYear; year <= endYear; year++) {
    for (const key of selectedKeys) {
      const def = HOLIDAY_BY_KEY[key];
      if (!def) continue;
      const date = holidayDate(def, year);
      if (!date || date < windowStart || date > windowEnd) continue;
      // Represent the holiday as a LOCAL-midnight all-day event. Two rules the
      // calendar's day-bucketing relies on:
      //  1. Include a time ("T00:00:00") so the browser parses it as local midnight,
      //     not UTC — a bare "2026-12-25" parses as UTC and lands a day early west
      //     of UTC.
      //  2. end is EXCLUSIVE (next day's midnight). The overlap test is
      //     `evEnd > dayStart`, so a single-day event needs end = start + 1 day,
      //     otherwise it matches no cell and vanishes.
      const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00:00`;
      const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      events.push({
        uid: `holiday-${key}-${year}`,
        title: `${def.emoji} ${def.name}`,
        allDay: true,
        people: ['Holiday'],
        color: color || '#f59e0b',
        icon: '',
        category: 'holiday',
        feedId: null,
        location: '',
        start: fmt(date),
        end: fmt(nextDay),
      });
    }
  }
  return events;
}

// Scan text for one of the given person names (case-insensitive, whole-word).
// Whole-word avoids false hits like "Sam" inside "Samantha" or a stray substring
// inside an email/URL. `names` should be PERSON members only — categories like
// "Family" are assigned deliberately, not auto-detected from notes (and "family"
// shows up in service-account organizer emails, which would mis-color everything).
function detectPersonFromText(text, names) {
  if (!text || !names || !names.length) return '';
  const lower = text.toLowerCase();
  for (const name of names) {
    const n = (name || '').toLowerCase();
    if (!n) continue;
    const re = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(lower)) return name;
  }
  return '';
}

// All-day events must be local-midnight strings with an EXCLUSIVE end (the next
// day), or the calendar's overlap test (`evEnd > dayStart`) drops or mis-buckets
// them. node-ical anchors all-day dates at UTC midnight, so read the calendar date
// in UTC (.toISOString slice) then present it as local midnight.
function allDayStart(d) {
  return d.toISOString().slice(0, 10) + 'T00:00:00';
}
function allDayEnd(startD, endD) {
  let e = endD;
  if (!e || e.getTime() <= startD.getTime()) e = new Date(startD.getTime() + 86400000);
  return e.toISOString().slice(0, 10) + 'T00:00:00';
}

// Minutes that `tzid` is ahead of UTC at the given instant (negative = behind UTC).
function tzOffsetMinutes(tzid, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  let hour = +m.hour; if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
  return (asUTC - date.getTime()) / 60000;
}

// The wall-clock Y-M-D/H:M:S for a real instant in a given IANA zone. Used by
// the one-time calendar import (below): native events store "floating" local
// date/time with no timezone attached (same as the add-event form), so an
// imported timed event must be converted from its real instant into the
// HOUSEHOLD's configured wall-clock time, not the server's (UTC) — otherwise
// an "8 AM Eastern" import would land as a bare "8 AM" and silently mean UTC.
function wallClockParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const hour = m.hour === '24' ? '00' : m.hour;
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${hour}:${m.minute}:${m.second}` };
}

// All-day (VALUE=DATE) fields carry no timezone by design, so the calendar
// date is unambiguous — read it the same way allDayStart()/allDayEnd() do.
// Timed fields need the household's own timezone (see wallClockParts above).
function importDateKey(date, allDay, timeZone) {
  return allDay ? date.toISOString().slice(0, 10) : wallClockParts(date, timeZone).date;
}

// node-ical's rrule.between() drops the event's TZID when expanding occurrences,
// so each timed occurrence comes back shifted by (hostOffset - tzidOffset). The
// master DTSTART (ev.start) is parsed correctly, but the recurrences are not —
// e.g. an 8 AM America/New_York event renders at noon on a UTC host. Re-anchor
// each occurrence so its wall-clock time in the source zone matches the master.
// Host-independent (a no-op when occurrences are already correct) and DST-safe,
// since the offset is recomputed per occurrence. No tzid (floating / all-day) →
// nothing to correct.
function fixRecurrence(occ, tzid) {
  if (!tzid) return occ;
  const deltaMin = tzOffsetMinutes(tzid, occ) + occ.getTimezoneOffset();
  return new Date(occ.getTime() + deltaMin * 60000);
}

async function fetchFeedEvents(feed, windowStart, windowEnd, memberColors = {}, personNames = [], categoryNames = []) {
  const cached = feedCache.get(feed.id);
  if (cached && Date.now() - cached.fetchedAt < FEED_CACHE_TTL) return cached.events;

  let data;
  try {
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
    data = await Promise.race([ical.async.fromURL(feed.url), timer]);
  } catch (err) {
    console.error(`[feeds] fetch failed ${feed.url}: ${err.message}`);
    return cached ? cached.events : [];
  }

  const feedPerson = feed.fixed_person || '';
  const feedColor  = feed.color || memberColors[feedPerson] || null;
  const icon       = feed.emoji || '';
  const category   = VALID_CATEGORIES.has(feed.category) ? feed.category : 'personal';
  const events     = [];

  // Per-event person/color. Detection runs FIRST: a shared calendar that tags each
  // event in the title or notes colors it accordingly. People win over categories
  // (description "Abbie\n[S]" → Abbie), then bare category tags ("Birthday" →
  // Birthday). Only when nothing is found do we fall back to the feed's assigned
  // person/color (e.g. a one-kid TeamSnap feed). Scans title + description only —
  // never organizer / attendee, whose service-account emails contain noise.
  function attribute(title, desc) {
    const detected = detectPersonFromText(title, personNames)
                  || detectPersonFromText(desc,  personNames)
                  || detectPersonFromText(title, categoryNames)
                  || detectPersonFromText(desc,  categoryNames);
    const winner = detected || feedPerson;
    return {
      people: winner ? [winner] : [],
      color:  detected ? (memberColors[detected] || null) : feedColor,
    };
  }

  // Build + push one client event from a source VEVENT (master, single, or an
  // edited-instance override). Re-attributes per event so a renamed override
  // (e.g. "Practice → Captains Practice") still colors correctly.
  function pushEvent(uid, src, startD, endD, allDay) {
    const title = (src.summary || '').trim() || '(No title)';
    const desc  = (src.description || '').trim();
    const { people, color } = attribute(title, desc);
    events.push({
      uid, title, allDay, people, color, icon, category, feedId: feed.id,
      location: src.location || '',
      start: allDay ? allDayStart(startD) : startD.toISOString(),
      end:   allDay ? allDayEnd(startD, endD) : endD.toISOString(),
    });
  }

  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT') continue;
    // node-ical exposes parsed dates as ev.start / ev.end (NOT ev.dtstart/dtend).
    const allDay = detectAllDay(ev.start, ev.end);

    if (ev.rrule) {
      const dur  = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 0;
      const tzid = ev.rrule.origOptions && ev.rrule.origOptions.tzid;

      // EXDATE: instances the user deleted from the series. node-ical parses these
      // to correct instants (unlike rrule.between's shifted occurrences), so after
      // fixRecurrence each kept occurrence matches exactly.
      const exdates = new Set();
      if (ev.exdate) {
        for (const k of Object.keys(ev.exdate)) {
          const d = ev.exdate[k];
          if (d && d.getTime) exdates.add(d.getTime());
        }
      }

      // RECURRENCE-ID: instances the user EDITED (moved/renamed). Each override is
      // keyed in ev.recurrences by its original-occurrence instant (recurrenceid).
      // We suppress the base occurrence at that instant and emit the override below.
      const overridden = new Set();
      if (ev.recurrences) {
        for (const k of Object.keys(ev.recurrences)) {
          const r = ev.recurrences[k];
          if (r && r.recurrenceid && r.recurrenceid.getTime) overridden.add(r.recurrenceid.getTime());
        }
      }

      const occs = ev.rrule.between(windowStart, windowEnd, true);
      for (const rawOcc of occs) {
        // Correct node-ical's rrule timezone shift (all-day stays date-anchored).
        const occ = allDay ? rawOcc : fixRecurrence(rawOcc, tzid);
        const t = occ.getTime();
        if (exdates.has(t)) continue;    // deleted from the series
        if (overridden.has(t)) continue; // replaced by an edited instance (emitted below)
        const occEnd = new Date(occ.getTime() + dur);
        pushEvent(`f${feed.id}-${ev.uid || ''}-${t}`, ev, occ, occEnd, allDay);
      }

      // Emit edited instances at their new time/title. A CANCELLED override means
      // the instance was deleted via RECURRENCE-ID rather than EXDATE — skip it
      // (the base occurrence is already suppressed above, so it just disappears).
      if (ev.recurrences) {
        for (const k of Object.keys(ev.recurrences)) {
          const r = ev.recurrences[k];
          if (!r || !r.start) continue;
          if ((r.status || '').toUpperCase() === 'CANCELLED') continue;
          const rAllDay = detectAllDay(r.start, r.end);
          const rEnd = r.end || r.start;
          if (r.start <= windowEnd && rEnd >= windowStart) {
            pushEvent(`f${feed.id}-${ev.uid || ''}-ovr-${r.start.getTime()}`, r, r.start, rEnd, rAllDay);
          }
        }
      }
    } else if (ev.start) {
      const s = ev.start;
      const e = ev.end || ev.start;
      if (s <= windowEnd && e >= windowStart) {
        pushEvent(`f${feed.id}-${ev.uid || ''}`, ev, s, e, allDay);
      }
    }
  }

  feedCache.set(feed.id, { fetchedAt: Date.now(), events });
  return events;
}

// A row's recurrence is EITHER a legacy pattern string (`recurring`) or an
// RFC5545 rule (`rrule`) — never both. The client sends both fields (one null)
// on a whole-series save so switching between simple/custom/none clears the
// other. Validate any rrule to a safe subset before it's stored.
const VALID_RRULE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,:+\-]+)*$/;
function isValidRrule(s) {
  return typeof s === 'string' && s.length <= 500 && VALID_RRULE.test(s);
}

// Map an incoming request body to DB columns (only defined fields).
function toRow(body) {
  const row = {};
  if (body.title !== undefined) row.title = body.title;
  if (body.date !== undefined) row.date = body.date;
  if (body.allDay !== undefined) row.all_day = body.allDay;
  if (body.startTime !== undefined) row.start_time = body.startTime || null;
  if (body.endTime !== undefined) row.end_time = body.endTime || null;
  // An end time at or before the start time (same-day event, no multi-day timed
  // events supported) makes the event fail eventsForDay()'s overlap check on
  // EVERY day — it silently stops rendering anywhere, not just on its own date.
  // Treat it as "no end set" instead of storing a nonsensical/invisible range.
  if (row.start_time && row.end_time && row.end_time <= row.start_time) row.end_time = null;
  if (body.people !== undefined) {
    row.people = Array.isArray(body.people)
      ? body.people.filter(p => typeof p === 'string' && p).slice(0, 20)
      : [];
  }
  if (body.location !== undefined) row.location = body.location;
  if (body.repeat !== undefined) row.recurring = body.repeat;
  if (body.rrule !== undefined) row.rrule = body.rrule || null;
  if (body.endsOn !== undefined) row.ends_on = body.endsOn;
  if (body.shareOverride !== undefined) {
    row.share_override = (body.shareOverride === 'always' || body.shareOverride === 'never') ? body.shareOverride : null;
  }
  return row;
}

// Config: colors come from members; layout/theme from the settings row.
app.get('/api/config', requireViewAccess, async (req, res) => {
  const { data: members, error } = await db.from('members').select('display_name, color, emoji');
  if (error) return res.status(500).json({ error: error.message });
  const settings = await getSettings();

  const colors = {};
  const emojis = {};
  for (const m of members) {
    if (!m.display_name) continue;
    colors[m.display_name] = m.color;
    if (m.emoji) emojis[m.display_name] = m.emoji;
  }

  // Weather: only emitted once the ZIP has been geocoded to coordinates. The
  // frontend uses these directly against Open-Meteo; no coords -> no weather row.
  let weather = null;
  if (settings.latitude != null && settings.longitude != null) {
    weather = {
      latitude: settings.latitude,
      longitude: settings.longitude,
      units: settings.weather_units || 'fahrenheit',
    };
  }

  res.json({
    name: settings.name,
    weeksToShow: settings.weeks_to_show ?? 4,
    firstDayOfWeek: settings.first_day_of_week ?? 0,
    timeZone: settings.time_zone || 'America/New_York',
    colors,
    emojis,
    weather,
    zip: settings.zip || '',
    theme: settings.theme || 'dark',
    isPublic: !!settings.is_public,
    holidays: Array.isArray(settings.holidays) ? settings.holidays : [],
    // Title keywords that auto-share an event to the read-only link. The client
    // uses these to show which events are currently shared.
    shareKeywords: Array.isArray(settings.share_keywords) ? settings.share_keywords : [],
    // Chore points. pointValueCents = 0 means "points only, no money" — a
    // perfectly normal setup, so the UI must not assume a currency.
    pointValueCents: settings.point_value_cents || 0,
    currencySymbol: settings.currency_symbol || '$',
    // Whether THIS request is logged in with the household password — drives
    // whether the client shows write controls (add/edit/delete) or read-only
    // (e.g. an anonymous visitor on a public calendar).
    authed: !!req.authed,
    donateUrl: DONATE_URL,
  });
});

// List events, merged with live iCal feed events.
app.get('/api/events', requireViewAccess, async (req, res) => {
  const { data, error } = await db.from('events').select('*').order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const windowStart = new Date(); windowStart.setMonth(windowStart.getMonth() - 1);
  const windowEnd   = new Date(); windowEnd.setFullYear(windowEnd.getFullYear() + 1);

  // Recurring rows are expanded into per-date occurrences within the window;
  // single events map straight through. A row is recurring if EITHER the
  // legacy `recurring` field OR an imported `rrule` is set — expandRecurring()
  // itself already branches on rrule internally, but an imported RRULE-only
  // row has recurring=null, so checking recurring alone here would skip
  // expansion entirely and silently flatten it to one occurrence.
  const dbEvents = [];
  for (const row of data) {
    if (row.recurring || row.rrule) dbEvents.push(...expandRecurring(row, windowStart, windowEnd));
    else dbEvents.push(toClientEvent(row));
  }

  const [{ data: feeds = [] }, { data: members = [] }, settings] = await Promise.all([
    db.from('feeds').select('*'),
    db.from('members').select('display_name, color, member_type'),
    getSettings(),
  ]);
  const memberColors = {};
  const personNames = [];   // real people — detected first in feed notes
  const categoryNames = []; // Family/Birthday/etc. — detected as a fallback tag
  for (const m of members || []) {
    if (!m.display_name) continue;
    memberColors[m.display_name] = m.color;
    if (m.member_type === 'category') categoryNames.push(m.display_name);
    else personNames.push(m.display_name);
  }

  const feedArrays = await Promise.all((feeds || []).map(f => fetchFeedEvents(f, windowStart, windowEnd, memberColors, personNames, categoryNames)));

  const selectedHolidays = Array.isArray(settings.holidays) ? settings.holidays : [];
  const holidayEvents    = generateHolidayEvents(selectedHolidays, memberColors['Holiday'] || '#f59e0b', windowStart, windowEnd);

  const allEvents = [...dbEvents, ...feedArrays.flat(), ...holidayEvents];
  res.json({ lastRefresh: new Date(), count: allEvents.length, events: allEvents });
});

// Create an event (must be logged in).
app.post('/api/events', auth.requireAuth, async (req, res) => {
  if (!req.body.title || !req.body.date) {
    return res.status(400).json({ error: 'title and date are required' });
  }
  const row = toRow(req.body);
  if (row.all_day === undefined) row.all_day = true;
  if (row.rrule) {
    if (!isValidRrule(row.rrule)) return res.status(400).json({ error: 'Invalid recurrence rule' });
    row.recurring = null; // rrule and legacy recurring are mutually exclusive
  }

  const { data, error } = await db.from('events').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify devices watching the assigned people. Deliberately not awaited: a
  // slow or failing push service must not delay (or fail) event creation.
  // `deviceId` comes from the creating client so it doesn't buzz itself.
  notify.notifyEventAdded(data, req.body.deviceId || null)
    .catch((err) => console.error('[notify] on-add dispatch:', err.message));

  res.json({ ok: true, event: toClientEvent(data) });
});

// Update an event (must be logged in).
app.patch('/api/events/:id', auth.requireAuth, async (req, res) => {
  const row = toRow(req.body);
  if (Object.keys(row).length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  // Edit ONE occurrence of a recurring series: detach it as an independent,
  // non-recurring event on that date and add the original date to the master's
  // exceptions so the series no longer renders it.
  if (req.query.instanceStart) {
    const day = String(req.query.instanceStart).slice(0, 10);
    const { data: master, error: readErr } = await db.from('events').select('*').eq('id', req.params.id).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!master) return res.status(404).json({ error: 'Event not found' });

    const detached = {
      title: master.title, date: day,
      start_time: master.start_time, end_time: master.end_time,
      all_day: master.all_day, people: master.people, location: master.location,
      ...row,                    // edited fields win
      recurring: null, rrule: null, ends_on: null, exdates: [],   // the detached copy is a one-off
    };
    const { data: created, error: insErr } = await db.from('events').insert(detached).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    const exdates = Array.from(new Set([...(master.exdates || []), day]));
    const { error: updErr } = await db.from('events')
      .update({ exdates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.json({ ok: true, event: toClientEvent(created) });
  }

  // Whole-event / whole-series edit. The repeat rule and end date ARE editable
  // here (inline, no delete + re-add needed) — but for an existing recurring
  // master we still don't let the form's date field move the series anchor,
  // since it reflects whichever occurrence the user clicked, not the series
  // start; re-anchoring the start date is still delete + re-add.
  if (row.recurring !== undefined && row.recurring !== null && !RECUR_RULES.has(row.recurring)) {
    return res.status(400).json({ error: 'Invalid repeat value' });
  }
  if (row.rrule !== undefined && row.rrule !== null && !isValidRrule(row.rrule)) {
    return res.status(400).json({ error: 'Invalid recurrence rule' });
  }
  // rrule and legacy recurring are mutually exclusive; a set rrule wins.
  if (row.rrule) row.recurring = null;

  const { data: existing } = await db.from('events').select('recurring, rrule, ends_on').eq('id', req.params.id).maybeSingle();

  // Same anchor-protection as the comment above, extended to imported/custom
  // RRULE rows: without the `existing.rrule` check, a whole-series edit on an
  // RRULE series would silently re-anchor it to whatever occurrence date the
  // user happened to click, since existing.recurring is null for those rows.
  if (existing && (existing.recurring || existing.rrule)) delete row.date;

  if (existing) {
    const newRecurring = row.recurring !== undefined ? row.recurring : existing.recurring;
    const newRrule     = row.rrule     !== undefined ? row.rrule     : existing.rrule;
    const newEndsOn    = row.ends_on   !== undefined ? row.ends_on   : existing.ends_on;
    // The stored exceptions (deleted/detached occurrences) are dates picked
    // against the OLD pattern — they don't necessarily line up with a changed
    // rule or end date, so start clean rather than carry stale exclusions
    // forward when the pattern (legacy OR rrule) or end date actually changes.
    if (newRecurring !== existing.recurring || newRrule !== existing.rrule || newEndsOn !== existing.ends_on) {
      row.exdates = [];
    }
    // "Does not repeat" collapses the series to a single event — no dangling
    // end date. Guard on !row.rrule so a custom save (recurring=null but rrule
    // set) keeps its end date.
    if (row.recurring === null && !row.rrule) row.ends_on = null;
  }

  row.updated_at = new Date().toISOString();

  const { data, error } = await db.from('events').update(row).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({ ok: true, event: toClientEvent(data) });
});

// Delete an event (must be logged in).
app.delete('/api/events/:id', auth.requireAuth, async (req, res) => {
  // Delete ONE occurrence of a recurring series: record its date as an exception
  // (the master row and every other occurrence stay). Without instanceStart we
  // delete the whole event/series.
  if (req.query.instanceStart) {
    const day = String(req.query.instanceStart).slice(0, 10);
    const { data: ev, error: readErr } = await db.from('events').select('exdates').eq('id', req.params.id).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const exdates = Array.from(new Set([...(ev.exdates || []), day]));
    const { error } = await db.from('events')
      .update({ exdates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  const { error } = await db.from('events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Share links + ICS feed ──
// Public, token-gated (the token is the access grant — works even when the
// calendar is private, since viewing via a share link is always allowed).
app.get('/api/calendar/:token', rateLimit({ max: 60 }), share.icsHandler);
app.get('/share/:token', rateLimit({ max: 60 }), share.shareViewHandler);
app.get('/api/share/:token/events', rateLimit({ max: 60 }), share.shareEventsHandler);
// Owner controls — generate/revoke the share token.
app.get('/api/share/status', auth.requireAuth, share.shareStatus);
app.post('/api/share/generate', auth.requireAuth, share.generateShareToken);
app.post('/api/share/revoke', auth.requireAuth, share.revokeShareToken);

// Look up a member's color by display_name, to color a feed by its owner.
async function memberColor(person) {
  if (!person) return null;
  const { data } = await db.from('members').select('color').eq('display_name', person).maybeSingle();
  return data?.color || null;
}

// ── Members (name/color/emoji tags — no login of their own) ──
app.get('/api/members', auth.requireAuth, async (req, res) => {
  const { data, error } = await db.from('members').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ members: data });
});

app.post('/api/members', auth.requireAuth, async (req, res) => {
  const name = (req.body.display_name || '').trim();
  if (!name) return res.status(400).json({ error: 'display_name required' });

  const row = {
    display_name: name.slice(0, 30),
    color: HEX_RE.test(req.body.color) ? req.body.color : '#6366f1',
    emoji: cleanEmoji(req.body.emoji),
    member_type: 'person',
  };
  const { data, error } = await db.from('members').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, member: data });
});

app.patch('/api/members/:id', auth.requireAuth, async (req, res) => {
  const update = {};
  if (typeof req.body.display_name === 'string' && req.body.display_name.trim()) {
    update.display_name = req.body.display_name.trim().slice(0, 30);
  }
  if (HEX_RE.test(req.body.color)) update.color = req.body.color;
  if ('emoji' in req.body) update.emoji = cleanEmoji(req.body.emoji);
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const { data, error } = await db.from('members').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true, member: data });
});

app.delete('/api/members/:id', auth.requireAuth, async (req, res) => {
  const { data: m } = await db.from('members').select('member_type').eq('id', req.params.id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'Member not found' });
  if (m.member_type === 'category') return res.status(400).json({ error: 'Category members cannot be deleted — change their color in settings instead' });

  const { error } = await db.from('members').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Categories ──
// The four category pseudo-members (Family / Birthday / Anniversary / Holiday).
// Idempotent: safe to call on every settings load.
const CATEGORY_DEFS = [
  { name: 'Family',      color: '#6366f1' },
  { name: 'Birthday',    color: '#9333ea' },
  { name: 'Anniversary', color: '#ef4444' },
  { name: 'Holiday',     color: '#f59e0b' },
];
app.post('/api/categories/ensure', auth.requireAuth, async (req, res) => {
  const { data: existing, error } = await db.from('members').select('id, display_name, member_type');
  if (error) return res.status(500).json({ error: error.message });

  for (const cat of CATEGORY_DEFS) {
    const row = (existing || []).find(m =>
      (m.display_name || '').toLowerCase() === cat.name.toLowerCase());
    if (row) {
      if (row.member_type !== 'category') {
        await db.from('members').update({ member_type: 'category' }).eq('id', row.id);
      }
    } else {
      await db.from('members').insert({
        display_name: cat.name, color: cat.color, emoji: null, member_type: 'category',
      });
    }
  }
  res.json({ ok: true });
});

// ── Feeds ──
app.get('/api/feeds', auth.requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('feeds')
    .select('id, url, name, display_name, fixed_person, color, emoji, category, never_share')
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ feeds: data });
});

app.post('/api/feeds', auth.requireAuth, async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid url required' });
  const person = (req.body.person || req.body.member || '').trim().slice(0, 30) || null;
  let label = (req.body.label || '').trim().slice(0, 60);
  if (!label) { try { label = new URL(url).hostname; } catch { label = 'Calendar'; } }

  const category = VALID_CATEGORIES.has(req.body.category) ? req.body.category : 'personal';
  const row = {
    url,
    name: label,
    display_name: label,
    fixed_person: person,
    color: await memberColor(person),
    emoji: cleanEmoji(req.body.emoji),
    category,
    never_share: req.body.never_share === true,
  };
  const { data, error } = await db.from('feeds').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, feed: data });
});

app.patch('/api/feeds/:id', auth.requireAuth, async (req, res) => {
  const update = {};
  if (typeof req.body.url === 'string' && /^https?:\/\//i.test(req.body.url.trim())) {
    update.url = req.body.url.trim();
  }
  if (typeof req.body.label === 'string') {
    const l = req.body.label.trim().slice(0, 60);
    if (l) { update.name = l; update.display_name = l; }
  }
  if ('member' in req.body || 'person' in req.body) {
    const person = (req.body.person || req.body.member || '').trim().slice(0, 30) || null;
    update.fixed_person = person;
    update.color = await memberColor(person);
  }
  if ('emoji' in req.body) update.emoji = cleanEmoji(req.body.emoji);
  if (typeof req.body.category === 'string' && VALID_CATEGORIES.has(req.body.category)) {
    update.category = req.body.category;
  }
  if (typeof req.body.never_share === 'boolean') update.never_share = req.body.never_share;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const { data, error } = await db.from('feeds').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Feed not found' });
  res.json({ ok: true, feed: data });
});

app.delete('/api/feeds/:id', auth.requireAuth, async (req, res) => {
  const { error } = await db.from('feeds').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Meal planner + to-do list ──
app.get('/api/meals',        auth.requireAuth, meals.list);
app.post('/api/meals',       auth.requireAuth, meals.create);
app.patch('/api/meals/:id',  auth.requireAuth, meals.update);
app.delete('/api/meals/:id', auth.requireAuth, meals.remove);

app.get('/api/todos',        auth.requireAuth, todos.list);
app.post('/api/todos',       auth.requireAuth, todos.create);
app.patch('/api/todos/:id',  auth.requireAuth, todos.update);
app.delete('/api/todos/:id', auth.requireAuth, todos.remove);

// Chore points — per-person totals, history, and settling up.
app.get('/api/chores/earnings',    auth.requireAuth, todos.earnings);
app.get('/api/chores/completions', auth.requireAuth, todos.completions);
app.post('/api/chores/payout',     auth.requireAuth, todos.payout);

// ── One-time calendar import (migrate off a live feed subscription) ──
// Unlike a Feed (live, read-only, re-fetched every few minutes), this parses
// an iCal URL ONCE and writes native, fully-editable rows into `events`:
//   - a plain VEVENT (no RRULE)      -> one one-off row, filtered by rangeStart/rangeEnd
//   - a recurring VEVENT (RRULE)     -> ONE master row with `rrule` set,
//                                       imported in full regardless of range — a series'
//                                       *pattern* isn't a point in time, and the display
//                                       window already governs what's actually shown
//   - an edited/moved single instance (RECURRENCE-ID) -> its original date is added to
//                                       the master's exdates and the override becomes its
//                                       own one-off row, mirroring "edit one occurrence"
// `dryRun: true` parses and counts without writing anything, for a preview step.
app.post('/api/feeds/import', auth.requireAuth, async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid url required' });
  const dryRun = !!req.body.dryRun;
  const fallbackPerson = (req.body.person || '').trim().slice(0, 30) || null;
  const settings = await getSettings();
  const timeZone = settings.time_zone || 'America/New_York';

  // Range filters ONE-OFF events only (see header comment above).
  const rangeStart = req.body.rangeStart ? new Date(`${req.body.rangeStart}T00:00:00Z`) : null;
  const rangeEnd   = req.body.rangeEnd   ? new Date(`${req.body.rangeEnd}T23:59:59Z`)   : null;

  let data;
  try {
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
    data = await Promise.race([ical.async.fromURL(url), timer]);
  } catch (err) {
    return res.status(502).json({ error: `Could not fetch calendar: ${err.message}` });
  }

  const { data: members = [] } = await db.from('members').select('display_name, member_type');
  const personNames = [];
  const categoryNames = [];
  for (const m of members || []) {
    if (!m.display_name) continue;
    (m.member_type === 'category' ? categoryNames : personNames).push(m.display_name);
  }
  function attributePerson(title, desc) {
    return detectPersonFromText(title, personNames) || detectPersonFromText(desc, personNames)
        || detectPersonFromText(title, categoryNames) || detectPersonFromText(desc, categoryNames)
        || fallbackPerson;
  }
  // The heuristic above still attributes at most one name per import row —
  // wrapped as a one-element array to match the events.people[] column shape.
  const toPeopleArray = p => p ? [p] : [];

  const seriesRows = [];
  const singleRows = [];

  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT') continue;
    const allDay = detectAllDay(ev.start, ev.end);
    const title  = (ev.summary || '').trim() || '(No title)';
    const desc   = (ev.description || '').trim();
    const person = attributePerson(title, desc);
    const location = ev.location || '';

    if (ev.rrule) {
      // Extract just the RRULE value — DTSTART is re-derived from our own
      // `date` column at expansion time (expandRruleRecurring), same as the
      // legacy recurring model, so the DTSTART line node-ical embeds is dropped.
      const full = ev.rrule.toString();
      const idx = full.indexOf('RRULE:');
      const ruleText = idx >= 0 ? full.slice(idx + 'RRULE:'.length) : null;
      if (!ruleText) continue; // malformed — skip rather than insert an unexpandable row

      const exdateKeys = new Set();
      if (ev.exdate) {
        for (const k of Object.keys(ev.exdate)) {
          const d = ev.exdate[k];
          if (d && d.getTime) exdateKeys.add(importDateKey(d, allDay, timeZone));
        }
      }

      const overrides = [];
      if (ev.recurrences) {
        for (const k of Object.keys(ev.recurrences)) {
          const r = ev.recurrences[k];
          if (!r || !r.recurrenceid) continue;
          exdateKeys.add(importDateKey(r.recurrenceid, allDay, timeZone)); // suppress base occurrence either way
          if ((r.status || '').toUpperCase() === 'CANCELLED') continue; // pure deletion, no replacement row
          const rAllDay = detectAllDay(r.start, r.end);
          const rTitle  = (r.summary || title).trim() || '(No title)';
          overrides.push({
            title: rTitle,
            date: importDateKey(r.start, rAllDay, timeZone),
            all_day: rAllDay,
            start_time: rAllDay ? null : wallClockParts(r.start, timeZone).time,
            end_time:   rAllDay ? null : wallClockParts(r.end || r.start, timeZone).time,
            location: r.location || location,
            people: toPeopleArray(attributePerson(rTitle, (r.description || '').trim())),
          });
        }
      }

      seriesRows.push({
        title,
        date: importDateKey(ev.start, allDay, timeZone),
        all_day: allDay,
        start_time: allDay ? null : wallClockParts(ev.start, timeZone).time,
        end_time:   allDay ? null : wallClockParts(ev.end || ev.start, timeZone).time,
        location, people: toPeopleArray(person),
        rrule: ruleText,
        exdates: Array.from(exdateKeys),
        overrides,
      });
    } else if (ev.start) {
      const key = importDateKey(ev.start, allDay, timeZone);
      if (rangeStart && ev.start < rangeStart) continue;
      if (rangeEnd && ev.start > rangeEnd) continue;
      singleRows.push({
        title, date: key, all_day: allDay,
        start_time: allDay ? null : wallClockParts(ev.start, timeZone).time,
        end_time:   allDay ? null : wallClockParts(ev.end || ev.start, timeZone).time,
        location, people: toPeopleArray(person),
      });
    }
  }

  const overrideCount = seriesRows.reduce((n, s) => n + s.overrides.length, 0);

  if (dryRun) {
    const sample = [...seriesRows, ...singleRows].slice(0, 8).map(s => `${s.title} (${s.date})`);
    return res.json({
      ok: true, dryRun: true,
      seriesCount: seriesRows.length,
      singleCount: singleRows.length,
      overrideCount,
      sample,
    });
  }

  let insertedSeries = 0, insertedSingles = 0, insertedOverrides = 0;
  for (const s of seriesRows) {
    const { overrides, ...masterFields } = s;
    const { error } = await db.from('events').insert({
      title: masterFields.title, date: masterFields.date, all_day: masterFields.all_day,
      start_time: masterFields.start_time, end_time: masterFields.end_time,
      location: masterFields.location, people: masterFields.people,
      rrule: masterFields.rrule, exdates: masterFields.exdates,
    });
    if (error) {
      return res.status(500).json({
        error: `Import stopped on "${s.title}": ${error.message}`,
        insertedSeries, insertedSingles, insertedOverrides,
      });
    }
    insertedSeries++;

    for (const o of overrides) {
      const { error: oErr } = await db.from('events').insert(o);
      if (!oErr) insertedOverrides++;
    }
  }
  for (const s of singleRows) {
    const { error } = await db.from('events').insert(s);
    if (!error) insertedSingles++;
  }

  // Auto-remove the matching feed subscription so events don't show twice.
  let removedFeed = false;
  const { data: matchingFeed } = await db.from('feeds').select('id').eq('url', url).maybeSingle();
  if (matchingFeed) {
    const { error: delErr } = await db.from('feeds').delete().eq('id', matchingFeed.id);
    removedFeed = !delErr;
  }

  res.json({ ok: true, dryRun: false, insertedSeries, insertedSingles, insertedOverrides, removedFeed });
});

// ── Calendar settings ──
app.patch('/api/settings', auth.requireAuth, async (req, res) => {
  const b = req.body || {};
  const update = {};
  if (typeof b.name === 'string' && b.name.trim()) update.name = b.name.trim().slice(0, 60);
  if (typeof b.time_zone === 'string' && b.time_zone.trim()) update.time_zone = b.time_zone.trim().slice(0, 64);
  if (Number.isInteger(b.first_day_of_week) && b.first_day_of_week >= 0 && b.first_day_of_week <= 6) {
    update.first_day_of_week = b.first_day_of_week;
  }
  if (Number.isInteger(b.weeks_to_show)) update.weeks_to_show = Math.min(8, Math.max(1, b.weeks_to_show));
  if (typeof b.theme === 'string' && THEMES.has(b.theme)) update.theme = b.theme;
  if (typeof b.is_public === 'boolean') update.is_public = b.is_public;
  if (b.weather_units === 'celsius' || b.weather_units === 'fahrenheit') update.weather_units = b.weather_units;

  if (typeof b.zip === 'string') {
    const zip = b.zip.trim().slice(0, 5);
    update.zip = zip || null;
    if (zip) {
      const geo = await geocodeZip(zip);
      update.latitude = geo ? geo.latitude : null;
      update.longitude = geo ? geo.longitude : null;
    } else {
      update.latitude = null;
      update.longitude = null;
    }
  }

  if (Array.isArray(b.holidays)) {
    const validKeys = new Set(HOLIDAY_DEFS.map(h => h.key));
    update.holidays = b.holidays.filter(k => validKeys.has(k));
  }

  if (b.point_value_cents !== undefined) {
    const c = Math.trunc(Number(b.point_value_cents));
    update.point_value_cents = Number.isFinite(c) ? Math.min(100000, Math.max(0, c)) : 0;
  }
  if (typeof b.currency_symbol === 'string') {
    update.currency_symbol = b.currency_symbol.trim().slice(0, 4) || '$';
  }

  if (Array.isArray(b.share_keywords)) {
    // Normalize: trim, drop blanks, lowercase-dedupe, cap length + count.
    const seen = new Set();
    const cleaned = [];
    for (const raw of b.share_keywords) {
      if (typeof raw !== 'string') continue;
      const w = raw.trim().slice(0, 40);
      if (!w) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(w);
      if (cleaned.length >= 40) break;
    }
    update.share_keywords = cleaned;
  }

  if (Object.keys(update).length === 0) return res.json({ ok: true });

  const { data, error } = await db.from('settings').update(update).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, geocoded: update.latitude != null });
});

// ── Web Push ──
// Subscriptions are per-DEVICE (there are no individual logins), so each row
// carries its own label, watched-people filter, and reminder lead time.

// The VAPID public key the browser needs to subscribe. Cheap and non-secret.
app.get('/api/push/key', auth.requireAuth, (req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

app.get('/api/push/subscriptions', auth.requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, device_id, label, notify_people, digest_enabled, reminders_enabled, on_add_enabled, reminder_minutes, created_at')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ subscriptions: data });
});

// Register (or re-register) this device. Keyed on the push endpoint, which is
// the browser's own identity for the subscription — re-subscribing with the same
// endpoint updates the existing row instead of piling up duplicates.
app.post('/api/push/subscribe', auth.requireAuth, async (req, res) => {
  const { subscription, deviceId, label, notifyPeople, reminderMinutes } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'subscription with endpoint and keys is required' });
  }

  const row = {
    device_id: deviceId || null,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    label: (label || '').trim().slice(0, 60) || 'This device',
    notify_people: Array.isArray(notifyPeople)
      ? notifyPeople.filter((p) => typeof p === 'string' && p).slice(0, 20)
      : [],
    reminder_minutes: Number.isFinite(+reminderMinutes) ? Math.min(1440, Math.max(0, +reminderMinutes)) : 60,
  };

  const { data: existing } = await db
    .from('push_subscriptions').select('id').eq('endpoint', row.endpoint).maybeSingle();

  const { data, error } = existing
    ? await db.from('push_subscriptions').update(row).eq('endpoint', row.endpoint).select().single()
    : await db.from('push_subscriptions').insert(row).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, subscription: data });
});

app.patch('/api/push/subscriptions/:id', auth.requireAuth, async (req, res) => {
  const b = req.body || {};
  const update = {};
  if (typeof b.label === 'string' && b.label.trim()) update.label = b.label.trim().slice(0, 60);
  if (Array.isArray(b.notifyPeople)) {
    update.notify_people = b.notifyPeople.filter((p) => typeof p === 'string' && p).slice(0, 20);
  }
  if (typeof b.digestEnabled === 'boolean') update.digest_enabled = b.digestEnabled;
  if (typeof b.remindersEnabled === 'boolean') update.reminders_enabled = b.remindersEnabled;
  if (typeof b.onAddEnabled === 'boolean') update.on_add_enabled = b.onAddEnabled;
  if (Number.isFinite(+b.reminderMinutes)) update.reminder_minutes = Math.min(1440, Math.max(0, +b.reminderMinutes));
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const { data, error } = await db
    .from('push_subscriptions').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Subscription not found' });
  res.json({ ok: true, subscription: data });
});

app.delete('/api/push/subscriptions/:id', auth.requireAuth, async (req, res) => {
  const { error } = await db.from('push_subscriptions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// "Send test notification" — proves the whole chain (VAPID → push service →
// service worker) end to end from the settings page.
app.post('/api/push/test', auth.requireAuth, async (req, res) => {
  const endpoint = (req.body && req.body.endpoint) || null;
  const { data: subs, error } = endpoint
    ? await db.from('push_subscriptions').select('*').eq('endpoint', endpoint)
    : await db.from('push_subscriptions').select('*');
  if (error) return res.status(500).json({ error: error.message });
  if (!subs.length) return res.status(404).json({ error: 'No registered devices to notify' });

  const sent = await push.sendToMany(subs, {
    title: 'Kinboard test notification',
    body: 'Notifications are working. 🎉',
    url: '/',
    tag: 'kinboard-test',
  });
  res.json({ ok: true, sent });
});

// Manually fire the daily digest (used to verify it without waiting for the
// morning cron).
app.post('/api/push/digest-now', auth.requireAuth, async (req, res) => {
  res.json({ ok: true, ...(await notify.runDigest()) });
});

// Manually run one reminder pass. Same call the 5-minute cron makes, exposed for
// debugging "why didn't I get a reminder?" without waiting for the next tick.
// Note this evaluates the CURRENT window, so it only reports events that are
// due right now — it is not a way to replay missed reminders.
app.post('/api/push/reminders-now', auth.requireAuth, async (req, res) => {
  res.json({ ok: true, ...(await notify.checkDueReminders()) });
});

// Reused by the share route (server/routes/share.js) so the read-only share
// page / .ics feed can include live iCal-feed events, filtered by the
// household's share keywords. expandRecurring is exported for server/notify.js
// so digest/reminder occurrence expansion reuses the real recurrence engine
// rather than a second, weaker copy of the rules.
module.exports = { fetchFeedEvents, expandRecurring };

// ── Nightly SQLite backup ──
// A timestamped online-backup snapshot (safe to take mid-write — WAL is
// checkpointed into one consistent file), pruned to the most recent 14.
const BACKUP_DIR = path.join(db.DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
async function runBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `kinboard-${stamp}.db`);
  try {
    await db.raw.backup(dest);
    console.log(`[backup] wrote ${dest}`);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (err) {
    console.error('[backup] failed:', err.message);
  }
}
cron.schedule('0 3 * * *', runBackup); // daily at 03:00 server time

// Digest + event reminders (one tick drives both — see server/notify.js).
notify.schedule();

// Static frontend (icons, manifest, holidays.js, sw.js, share.html, ...). The
// explicit page routes above already handle '/', '/setup', '/settings' with
// setup-gating, so index isn't auto-served here.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`kinboard server running on port ${PORT}`);
});
