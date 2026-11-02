// ── ICS (RFC 5545) writer ────────────────────────────────────────────────────
// Pure: no database, no Express. server/routes/share.js gathers the events and
// hands them here; test/ics.test.js exercises this module directly.
//
// Every DATE / DATE-TIME this file writes goes through dateProp() and the three
// formatters under it. There used to be two hand-rolled paths — native events
// glued "T" + the stored time minus its colons, so a time saved as "19:30"
// came out as the invalid DTSTART:20260813T1930 — and strict parsers rejected
// the whole feed. Don't format a date anywhere else in here.
//
// Time zones: native events are wall-clock times in the household's zone, so
// they're written with TZID=<zone> and a VTIMEZONE built from the platform's
// tz data. Converting them to UTC instead would be wrong for recurring events:
// a weekly 7pm practice expanded from a UTC DTSTART lands at 6pm or 8pm on the
// far side of a DST change. Feed occurrences are already-expanded absolute
// instants, so they're written in UTC with a Z.

const DEFAULT_TZ = 'America/New_York';

// ── Formatters ──────────────────────────────────────────────────────────────

// "2026-08-13", "2026-08-13 19:30:00", a Date… → "20260813".
function fmtDate(d) {
  const s = d instanceof Date ? d.toISOString() : String(d == null ? '' : d);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (!m) throw new Error(`ics: not a date: ${JSON.stringify(d)}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

// "7:30", "19:30", "19:30:00", "193000" → "193000". Stored times come in both
// HH:MM and HH:MM:SS (hand-entered vs imported); both must come out HHMMSS.
function fmtTime(t) {
  const m = /^(\d{1,2}):?(\d{2})(?::?(\d{2}))?/.exec(String(t == null ? '' : t).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) throw new Error(`ics: not a time: ${JSON.stringify(t)}`);
  return `${m[1].padStart(2, '0')}${m[2]}${m[3] || '00'}`;
}

// An absolute instant (Date, ISO string, or SQLite "YYYY-MM-DD HH:MM:SS",
// which is UTC) → "20260813T233000Z".
function fmtUtc(x) {
  let d = x;
  if (!(d instanceof Date)) {
    const s = String(x);
    d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  }
  if (isNaN(d)) throw new Error(`ics: not an instant: ${JSON.stringify(x)}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

// The one way a date-valued property gets written. `v` is one of
//   { date }                 all-day       → NAME;VALUE=DATE:20260813
//   { date, time, tz }       wall clock    → NAME;TZID=America/New_York:20260813T193000
//   { instant }              absolute UTC  → NAME:20260813T233000Z
// or an array of the same kind (EXDATE lists).
function dateProp(name, v) {
  const list = Array.isArray(v) ? v : [v];
  const first = list[0];
  if (first.instant !== undefined) return `${name}:${list.map(x => fmtUtc(x.instant)).join(',')}`;
  if (first.time == null) return `${name};VALUE=DATE:${list.map(x => fmtDate(x.date)).join(',')}`;
  return `${name};TZID=${first.tz}:${list.map(x => `${fmtDate(x.date)}T${fmtTime(x.time)}`).join(',')}`;
}

// ── Time-zone arithmetic (from Intl, no tz library) ─────────────────────────

// UTC offset of `tz` at instant `d`, in minutes (New York in July → -240).
function offsetMinutes(tz, d) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName').value; // "GMT-04:00" or "GMT"
  const m = /([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0)) : 0;
}

// Wall-clock date + time in `tz` → the UTC instant it names.
function zonedToUtc(date, time, tz) {
  const t = fmtTime(time), ds = fmtDate(date);
  const guess = Date.UTC(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
  let ms = guess - offsetMinutes(tz, new Date(guess)) * 60000;
  ms = guess - offsetMinutes(tz, new Date(ms)) * 60000; // second pass settles DST edges
  return new Date(ms);
}

function fmtOffset(min) {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

function shortName(tz, d) {
  const n = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d).find(p => p.type === 'timeZoneName').value;
  return /^[A-Za-z]{2,6}$/.test(n) ? n : null; // skip "GMT-3" style non-names
}

// Every offset change of `tz` during `year`, as { at (Date), from, to } in minutes.
function transitionsIn(tz, year) {
  const out = [];
  let prevT = Date.UTC(year, 0, 1), prev = offsetMinutes(tz, new Date(prevT));
  for (let t = prevT + 86400000; t <= Date.UTC(year + 1, 0, 1); t += 86400000) {
    const off = offsetMinutes(tz, new Date(t));
    if (off !== prev) {
      // Whole seconds: offset is `prev` at lo, `off` at hi; hi lands on the
      // first second of the new offset.
      let lo = prevT / 1000, hi = t / 1000;
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); offsetMinutes(tz, new Date(mid * 1000)) === prev ? lo = mid : hi = mid; }
      const at = new Date(hi * 1000);
      if (at.getUTCFullYear() === year) out.push({ at, from: prev, to: off });
    }
    prevT = t; prev = off;
  }
  return out;
}

// The transition as RFC 5545 wants it: local time in the OLD offset, and the
// "Nth weekday of month" rule it follows.
function describe(tz, tr) {
  const local = new Date(tr.at.getTime() + tr.from * 60000);
  const y = local.getUTCFullYear(), mo = local.getUTCMonth(), day = local.getUTCDate();
  const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return {
    local: local.toISOString().slice(0, 19).replace(/[-:]/g, ''),
    month: mo + 1,
    byday: `${day + 7 > dim ? -1 : Math.ceil(day / 7)}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][local.getUTCDay()]}`,
    clock: local.toISOString().slice(11, 19),
    from: tr.from, to: tr.to,
    kind: tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD',
    name: shortName(tz, tr.at),
  };
}

function observance(o, rrule) {
  return [
    `BEGIN:${o.kind}`,
    `DTSTART:${o.local}`,
    `TZOFFSETFROM:${fmtOffset(o.from)}`,
    `TZOFFSETTO:${fmtOffset(o.to)}`,
    ...(rrule ? [rrule] : []),
    ...(o.name ? [`TZNAME:${o.name}`] : []),
    `END:${o.kind}`,
  ];
}

// VTIMEZONE for `tz` covering fromYear onward. Years that follow the zone's
// current yearly rule collapse into RRULE observances; any earlier years with
// different rules (US before 2007, say) are written out one transition each.
function vtimezone(tz, fromYear, toYear) {
  const years = [];
  for (let y = fromYear; y <= toYear; y++) years.push({ y, trs: transitionsIn(tz, y).map(t => describe(tz, t)) });
  const key = trs => trs.map(t => `${t.month}/${t.byday}/${t.clock}/${t.from}/${t.to}`).join('|');

  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const last = years[years.length - 1];
  if (!last.trs.length && years.every(y => !y.trs.length)) {
    // No DST anywhere in range: one fixed offset.
    const off = offsetMinutes(tz, new Date(Date.UTC(toYear, 0, 1)));
    lines.push(...observance({ kind: 'STANDARD', local: `${fromYear}0101T000000`, from: off, to: off, name: shortName(tz, new Date(Date.UTC(toYear, 0, 1))) }));
  } else {
    // Walk back from the newest year while each year follows the same rule.
    const rule = key(last.trs);
    let i = years.length - 1;
    while (i > 0 && key(years[i - 1].trs) === rule) i--;
    for (const y of years.slice(0, i)) for (const t of y.trs) lines.push(...observance(t));
    for (const t of years[i].trs) lines.push(...observance(t, last.trs.length ? `RRULE:FREQ=YEARLY;BYMONTH=${t.month};BYDAY=${t.byday}` : null));
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ── Text ────────────────────────────────────────────────────────────────────

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold to 75 OCTETS per RFC 5545 (continuation lines start with a space),
// never splitting a character — titles carry emoji, and cutting one in half
// leaves invalid UTF-8 a strict parser rejects.
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let cur = '';
  for (const ch of line) { // iterates code points
    if (Buffer.byteLength(cur + ch) > 75) { parts.push(cur); cur = ' '; }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

// ── Events ──────────────────────────────────────────────────────────────────

const FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function addDay(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// UNTIL must match DTSTART: a DATE for all-day series, a UTC DATE-TIME for
// timed ones (RFC 5545 §3.3.10). `until` may be a stored "YYYY-MM-DD", or the
// UNTIL already in an imported rule (DATE, floating, or UTC).
function untilValue(until, timed, tz) {
  const s = String(until);
  if (!timed) return fmtDate(s);
  if (/Z$/i.test(s)) return fmtUtc(new Date(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i, '$1-$2-$3T$4:$5:$6Z')));
  const m = /^(\d{4}-?\d{2}-?\d{2})(?:T(\d{6}))?$/i.exec(s);
  if (!m) throw new Error(`ics: not an UNTIL: ${JSON.stringify(until)}`);
  return fmtUtc(zonedToUtc(m[1], m[2] || '235959', tz)); // a bare date = through the end of that day
}

function rruleFor(ev, timed, tz) {
  let parts;
  if (ev.rrule) {
    // Imported/custom RFC 5545 rule. Keep it, but re-write any UNTIL to the
    // form DTSTART requires — imports store floating ones.
    parts = String(ev.rrule).replace(/^RRULE:/i, '').split(';').filter(Boolean)
      .map(p => /^UNTIL=/i.test(p) ? `UNTIL=${untilValue(p.slice(6), timed, tz)}` : p);
  } else if (ev.recurring === 'monthly_dow') {
    // "Nth weekday of the month" → BYDAY (e.g. 3FR, or -1FR for last).
    const d = new Date(String(ev.date).slice(0, 10) + 'T00:00:00Z');
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const ord = d.getUTCDate() + 7 > dim ? -1 : Math.ceil(d.getUTCDate() / 7);
    parts = ['FREQ=MONTHLY', `BYDAY=${ord}${BYDAY[d.getUTCDay()]}`];
  } else if (FREQ[ev.recurring]) {
    parts = [`FREQ=${FREQ[ev.recurring]}`];
  } else {
    return null;
  }
  // The series end lives in ends_on, not the rule; add it when the rule lacks one.
  if (ev.ends_on && !parts.some(p => /^UNTIL=/i.test(p))) parts.push(`UNTIL=${untilValue(ev.ends_on, timed, tz)}`);
  return `RRULE:${parts.join(';')}`;
}

// A stored (native) event → VEVENT with its RRULE/EXDATE; the subscriber's app
// expands the recurrence.
function veventFor(ev, tz) {
  const timed = !ev.all_day && !!ev.start_time;
  const lines = ['BEGIN:VEVENT', `UID:${ev.id}@kinboard`, dateProp('DTSTAMP', { instant: ev.updated_at || ev.created_at || new Date() })];

  if (!timed) {
    lines.push(dateProp('DTSTART', { date: ev.date }));
  } else {
    lines.push(dateProp('DTSTART', { date: ev.date, time: ev.start_time, tz }));
    if (ev.end_time) {
      const s = fmtTime(ev.start_time), e = fmtTime(ev.end_time);
      // An end at or before the start is an overnight event (7pm–1am): it ends
      // the next day. Equal times are a zero-length event: no DTEND at all.
      if (e !== s) lines.push(dateProp('DTEND', { date: e < s ? addDay(ev.date) : ev.date, time: ev.end_time, tz }));
    }
  }

  lines.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (Array.isArray(ev.people) && ev.people.length) lines.push(`DESCRIPTION:${icsEscape(ev.people.join(', '))}`);

  const rrule = rruleFor(ev, timed, tz);
  if (rrule) {
    lines.push(rrule);
    // EXDATE must match DTSTART's type: the skipped day at the series' time.
    if (Array.isArray(ev.exdates) && ev.exdates.length) {
      lines.push(dateProp('EXDATE', ev.exdates.map(d => timed ? { date: d, time: ev.start_time, tz } : { date: d })));
    }
  }

  lines.push('END:VEVENT');
  return lines;
}

// A single already-expanded feed occurrence → a standalone VEVENT. Timed ones
// are absolute instants, so they're written in UTC.
function veventForFeedOcc(fev) {
  const uid = `share-${(fev.uid || 'feed')}-${String(fev.start).replace(/[^0-9]/g, '')}@kinboard`;
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, dateProp('DTSTAMP', { instant: new Date() })];
  if (fev.allDay) {
    lines.push(dateProp('DTSTART', { date: fev.start }));
  } else {
    lines.push(dateProp('DTSTART', { instant: fev.start }));
    if (fev.end && new Date(fev.end) > new Date(fev.start)) lines.push(dateProp('DTEND', { instant: fev.end }));
  }
  lines.push(`SUMMARY:${icsEscape(fev.title)}`);
  if (fev.location) lines.push(`LOCATION:${icsEscape(fev.location)}`);
  if (Array.isArray(fev.people) && fev.people.length) lines.push(`DESCRIPTION:${icsEscape(fev.people.join(', '))}`);
  lines.push('END:VEVENT');
  return lines;
}

// One event that can't be written (a corrupt stored date, say) is logged and
// left out rather than taking the whole feed down with it.
function safe(fn, what) {
  try { return fn(); } catch (e) { console.error(`[ics] skipped ${what}: ${e.message}`); return []; }
}

function buildIcs(settings, events, feedOccs = [], now = new Date()) {
  const tz = settings.time_zone || DEFAULT_TZ;
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kinboard//self-hosted//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(settings.name)}`,
    `X-WR-TIMEZONE:${icsEscape(tz)}`,
  ];

  const timed = (events || []).filter(ev => !ev.all_day && ev.start_time);
  if (timed.length) {
    // Cover the oldest timed event through well past today, so the zone's
    // current rule is what's in force for anything open-ended.
    const years = timed.map(ev => +String(ev.date).slice(0, 4)).filter(Boolean);
    out.push(...vtimezone(tz, Math.min(...years, now.getUTCFullYear()) - 1, now.getUTCFullYear() + 2));
  }

  for (const ev of events || []) out.push(...safe(() => veventFor(ev, tz), `event ${ev.id}`));
  for (const fev of feedOccs || []) out.push(...safe(() => veventForFeedOcc(fev), `feed event ${fev.uid}`));
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, dateProp, fmtDate, fmtTime, fmtUtc, zonedToUtc, vtimezone, fold, icsEscape };
