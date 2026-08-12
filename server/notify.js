// Notification logic — the three triggers, plus the ntfy/webhook fallback.
// Cron-driven, config-gated, and safe to run when nothing is configured.
//
//   1. Daily digest         — "here's today", once each morning
//   2. Event reminders      — "Soccer practice in 1 hour", per-device lead time
//   3. On-add notifications — fired inline when an event is created for someone
//
// DEDUP WITHOUT A SENT-LOG: a single cron ticks every TICK_MINUTES and each
// trigger fires only for the window [tick, tick + TICK_MINUTES). Because the
// window is exactly the tick interval and windows never overlap, each occurrence
// falls in exactly one run, so no "already sent" bookkeeping is needed.
// Tradeoff: a reminder whose window elapses while the container is down is
// skipped rather than sent late. A sent-log table is the upgrade path if that
// becomes a real complaint.

const cron = require('node-cron');
const db = require('./db');
const push = require('./push');

const TICK_MINUTES = 5;
// Hour (0-23, household-local) the daily digest goes out.
const DIGEST_HOUR = Number.isInteger(+process.env.DIGEST_HOUR) ? +process.env.DIGEST_HOUR : 7;

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_TYPE = (process.env.WEBHOOK_TYPE || 'ntfy').toLowerCase();

function getSettings() {
  return db.decodeRow('settings', db.raw.prepare('SELECT * FROM settings WHERE id = 1').get());
}

function allSubscriptions() {
  return db.raw
    .prepare('SELECT * FROM push_subscriptions')
    .all()
    .map((r) => db.decodeRow('push_subscriptions', r));
}

// ── Household-local time helpers ────────────────────────────────────────────
// Events store FLOATING local time (a wall-clock date + time with no zone), so
// everything here has to be interpreted in the household's own timezone rather
// than the server's. "How long until this event" is then answered in *real*
// minutes, by resolving the wall-clock time to an instant (localToInstant) —
// not by subtracting wall-clock minutes, which assumes every hour is 60 minutes
// long and so fired twice on the night the clocks go back.

function localNow(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  let hour = +g('hour');
  if (hour === 24) hour = 0;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour, minute: +g('minute') };
}


// "HH:MM[:SS]" → minutes past midnight.
function hmToMinutes(hms) {
  const [h, m] = String(hms).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Constructing an Intl.DateTimeFormat is expensive, and the reminder loop asks
// for the offset once per device per occurrence (twice, for the two-pass
// resolution below). A household with five phones and fifty occurrences would
// build thousands of formatters every five minutes, forever, on hardware that is
// often a Raspberry Pi. There is one timezone in a household — cache it.
const dtfCache = new Map();
function offsetFormatter(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// Minutes `tz` is ahead of UTC at a given instant (negative = behind).
function tzOffsetMinutes(tz, date) {
  const dtf = offsetFormatter(tz);
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  let hour = +p.hour;
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// A floating wall-clock time ("2026-11-01" + 02:30) in `tz` → the real instant
// it happens at.
//
// Reminders used to compare wall-clock minutes, which quietly assumes every hour
// is 60 minutes long. On the night the clocks go back, 01:30 local happens
// twice, so a reminder due then went out twice — an hour apart, the first an
// hour early. Comparing real instants makes that impossible by construction: an
// instant crosses the [lead, lead + tick) window exactly once, whatever the
// local clock is doing.
//
// Two passes, because the first correction can itself cross a transition. An
// ambiguous time (the repeated hour) resolves to one of its two instants
// deterministically, a nonexistent one (the skipped hour) to the shifted
// instant. Both are fine — what matters is that the answer is one real moment.
function localToInstant(ymd, minutesPastMidnight, tz) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const hh = Math.floor(minutesPastMidnight / 60);
  const mm = minutesPastMidnight % 60;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    guess = naive - tzOffsetMinutes(tz, new Date(guess)) * 60000;
  }
  return guess;
}

// ── Occurrence lookup ───────────────────────────────────────────────────────
// Reuses expandRecurring() from index.js rather than re-deriving recurrence
// rules — one recurrence engine, so reminders can't disagree with what the
// calendar shows. Lazily required to avoid a circular import at init, the same
// pattern routes/share.js already uses for fetchFeedEvents.
function occurrencesForDates(dateKeys) {
  const wanted = new Set(dateKeys);
  if (!wanted.size) return [];

  let expandRecurring;
  try {
    ({ expandRecurring } = require('./index'));
  } catch (err) {
    console.error('[notify] could not load expandRecurring:', err.message);
    return [];
  }
  if (typeof expandRecurring !== 'function') return [];

  const rows = db.raw.prepare('SELECT * FROM events').all().map((r) => db.decodeRow('events', r));

  // Pad the expansion window a day either side so a recurrence anchored near a
  // boundary can't be clipped by server-vs-household timezone skew; the exact
  // date filter below is what actually decides membership.
  const sorted = [...wanted].sort();
  const windowStart = new Date(sorted[0] + 'T00:00:00');
  windowStart.setDate(windowStart.getDate() - 1);
  const windowEnd = new Date(sorted[sorted.length - 1] + 'T00:00:00');
  windowEnd.setDate(windowEnd.getDate() + 1);

  const out = [];
  for (const row of rows) {
    const expanded = (row.recurring || row.rrule)
      ? expandRecurring(row, windowStart, windowEnd)
      : [toOccurrence(row)];
    for (const occ of expanded) {
      const dateKey = String(occ.start || '').slice(0, 10);
      if (wanted.has(dateKey)) out.push({ ...occ, date: dateKey });
    }
  }
  return out;
}

// Subscribed calendars count too.
//
// This is the omission that made notifications look dead: the calendar page
// merges iCal feed events and so does the share page, but the digest and
// reminders only ever read the `events` table. Subscribe to a school or team
// calendar — the reason the feed feature exists — and you were reminded about
// none of it, with nothing in the logs to say so.
//
// Feed failures stay contained: a calendar that won't load costs its own
// events, never the reminder for something you typed in yourself.
async function feedOccurrencesForDates(dateKeys) {
  const wanted = new Set(dateKeys);
  if (!wanted.size) return [];

  let fetchFeedEvents;
  try {
    ({ fetchFeedEvents } = require('./index'));
  } catch {
    return [];
  }
  if (typeof fetchFeedEvents !== 'function') return [];

  const feeds = db.raw.prepare('SELECT * FROM feeds').all().map((r) => db.decodeRow('feeds', r));
  if (!feeds.length) return [];

  const members = db.raw.prepare('SELECT display_name, color, member_type FROM members').all();
  const colors = {};
  const personNames = [];
  const categoryNames = [];
  for (const m of members) {
    if (!m.display_name) continue;
    colors[m.display_name] = m.color;
    (m.member_type === 'category' ? categoryNames : personNames).push(m.display_name);
  }

  const sorted = [...wanted].sort();
  const windowStart = new Date(sorted[0] + 'T00:00:00');
  windowStart.setDate(windowStart.getDate() - 1);
  const windowEnd = new Date(sorted[sorted.length - 1] + 'T00:00:00');
  windowEnd.setDate(windowEnd.getDate() + 2);

  const arrays = await Promise.all(feeds.map(async (f) => {
    try {
      return await fetchFeedEvents(f, windowStart, windowEnd, colors, personNames, categoryNames);
    } catch (err) {
      console.error(`[notify] feed ${f.name || f.url} failed: ${err.message}`);
      return [];
    }
  }));

  const tz = (getSettings() || {}).time_zone || 'America/New_York';
  const out = [];
  for (const fev of arrays.flat()) {
    const local = feedStartToLocal(fev, tz);
    if (!local || !wanted.has(local.date)) continue;
    out.push({
      uid: fev.uid,
      title: fev.title,
      start: local.start,
      allDay: !!fev.allDay,
      people: fev.people || [],
      location: fev.location || null,
      date: local.date,
    });
  }
  return out;
}

// Feed occurrences carry a real UTC instant ("...T03:53:00.000Z"); events typed
// into Kinboard carry floating local wall-clock ("...T23:53:00"). Those are the
// same moment but a different calendar day, and everything downstream — the day
// filter, and the lead-time maths, which re-interprets the time as local —
// assumes the floating form. Convert before merging, or a feed event silently
// lands on the wrong day and is dropped.
function feedStartToLocal(fev, tz) {
  const s = String(fev.start || '');
  if (!s) return null;
  // All-day feed events are already emitted as local-midnight strings.
  if (fev.allDay || !/Z$/i.test(s)) return { date: s.slice(0, 10), start: s };

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const p = {};
  for (const { type, value } of offsetFormatter(tz).formatToParts(d)) p[type] = value;
  let hour = p.hour === '24' ? '00' : p.hour;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, start: `${date}T${hour}:${p.minute}:${p.second}` };
}

// Everything on the calendar for these dates — typed in or subscribed.
async function allOccurrencesForDates(dateKeys) {
  const [own, feed] = await Promise.all([
    Promise.resolve(occurrencesForDates(dateKeys)),
    feedOccurrencesForDates(dateKeys),
  ]);
  return [...own, ...feed];
}

// Minimal stand-in for index.js's toClientEvent for non-recurring rows (which
// expandRecurring never sees). Only the fields the notification copy needs.
function toOccurrence(row) {
  const start = row.all_day || !row.start_time
    ? `${row.date}T00:00:00`
    : `${row.date}T${row.start_time}`;
  return {
    uid: row.id,
    title: row.title,
    start,
    allDay: !!row.all_day,
    people: row.people || [],
    location: row.location,
  };
}

// ── Audience matching ───────────────────────────────────────────────────────
// A device with an empty notify_people watches everything. Otherwise it only
// hears about events naming at least one of its people. An event with no people
// assigned counts as household-wide and reaches everyone.
function deviceCaresAbout(sub, people) {
  const watch = Array.isArray(sub.notify_people) ? sub.notify_people : [];
  if (!watch.length) return true;
  if (!people || !people.length) return true;
  const lower = watch.map((w) => String(w).toLowerCase());
  return people.some((p) => lower.includes(String(p).toLowerCase()));
}

function timeLabel(occ) {
  if (occ.allDay) return 'All day';
  const hm = String(occ.start).slice(11, 16);
  const [h, m] = hm.split(':').map(Number);
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

// ── Webhook / ntfy fallback ─────────────────────────────────────────────────
// Household-wide (there's no per-person routing over a single webhook) and works
// over plain HTTP, which is the point: it's what LAN-only self-hosters use when
// Web Push isn't available to them.
// ntfy carries the title in an HTTP *header*, and header values are ByteStrings —
// any codepoint above 255 throws outright. Real titles routinely contain them:
// the em dash in our own digest subject, emoji in event titles, accented family
// names. Encode those as an RFC 2047 encoded-word (which ntfy decodes) and leave
// plain-ASCII titles untouched so the common case stays readable on the wire.
function encodeHeaderValue(s) {
  const str = String(s == null ? '' : s);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

async function sendWebhook(title, body) {
  if (!WEBHOOK_URL) return;
  try {
    let opts;
    if (WEBHOOK_TYPE === 'ntfy') {
      opts = { method: 'POST', headers: { Title: encodeHeaderValue(title) }, body };
    } else if (WEBHOOK_TYPE === 'discord') {
      opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}` }) };
    } else if (WEBHOOK_TYPE === 'slack') {
      opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${body}` }) };
    } else {
      opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) };
    }
    const res = await fetch(WEBHOOK_URL, { ...opts, signal: AbortSignal.timeout(8000) });
    if (!res.ok) console.error(`[notify] webhook ${res.status}`);
  } catch (err) {
    console.error('[notify] webhook failed:', err.message);
  }
}

// ── Trigger 1: daily digest ─────────────────────────────────────────────────
async function runDigest() {
  const settings = getSettings();
  const tz = settings.time_zone || 'America/New_York';
  const today = localNow(tz).date;

  const occs = (await allOccurrencesForDates([today]))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const subs = allSubscriptions().filter((s) => s.digest_enabled);

  const title = `${settings.name || 'Today'} — today's schedule`;

  let sent = 0;
  for (const sub of subs) {
    const mine = occs.filter((o) => deviceCaresAbout(sub, o.people));
    // Nothing on the calendar for this device today → stay silent rather than
    // send a daily "nothing today" push, which trains people to ignore it.
    if (!mine.length) continue;
    const body = mine.map((o) => `${timeLabel(o)} · ${o.title}`).join('\n');
    if (await push.sendToSubscription(sub, { title, body, url: '/', tag: `digest-${today}` })) sent++;
  }

  if (occs.length) {
    await sendWebhook(title, occs.map((o) => `${timeLabel(o)} · ${o.title}`).join('\n'));
  }

  console.log(`[notify] digest — ${occs.length} event(s) today, ${sent} push(es) sent`);
  return { events: occs.length, sent };
}

// ── Trigger 2: per-event lead-time reminders ────────────────────────────────
// All-day events are deliberately excluded: "1 hour before" is meaningless for
// something with no start time, and they're already covered by the digest.
async function checkDueReminders() {
  const settings = getSettings();
  const tz = settings.time_zone || 'America/New_York';
  const now = localNow(tz);
  const nowMs = Date.now();

  const subs = allSubscriptions().filter((s) => s.reminders_enabled);
  if (!subs.length) return { sent: 0 };

  // Look at today and tomorrow so a lead time that reaches past midnight works.
  const tomorrow = new Date(now.date + 'T12:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const occs = (await allOccurrencesForDates([now.date, tomorrow.toISOString().slice(0, 10)]))
    .filter((o) => !o.allDay);

  let sent = 0;
  for (const sub of subs) {
    const lead = Number.isFinite(+sub.reminder_minutes) ? +sub.reminder_minutes : 60;
    for (const occ of occs) {
      if (!deviceCaresAbout(sub, occ.people)) continue;
      // Real minutes until the event, not wall-clock minutes — see
      // localToInstant. The half-open window is what makes this fire once.
      const occMs = localToInstant(occ.date, hmToMinutes(String(occ.start).slice(11, 16)), tz);
      const delta = (occMs - nowMs) / 60000;
      if (delta < lead || delta >= lead + TICK_MINUTES) continue;

      const whenText = lead >= 60
        ? `in ${Math.round(lead / 60)} hour${Math.round(lead / 60) === 1 ? '' : 's'}`
        : `in ${lead} minutes`;
      const body = [
        `${timeLabel(occ)}${occ.location ? ` · 📍 ${occ.location}` : ''}`,
        occ.people && occ.people.length ? occ.people.join(', ') : '',
      ].filter(Boolean).join('\n');

      if (await push.sendToSubscription(sub, {
        title: `${occ.title} ${whenText}`,
        body,
        url: '/',
        tag: `reminder-${occ.uid}-${occ.date}`,
      })) sent++;
    }
  }

  if (sent) console.log(`[notify] reminders — ${sent} sent`);
  return { sent };
}

// ── Trigger 3: an event was added for someone ───────────────────────────────
// Called inline from POST /api/events. originDeviceId is the device that made
// the request, so the phone that just created the event doesn't buzz itself.
async function notifyEventAdded(eventRow, originDeviceId) {
  try {
    const people = eventRow.people || [];
    const subs = allSubscriptions().filter(
      (s) => s.on_add_enabled && s.device_id !== originDeviceId && deviceCaresAbout(s, people)
    );
    if (!subs.length) return { sent: 0 };

    const occ = toOccurrence(eventRow);
    const dateLabel = new Date(eventRow.date + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
    const who = people.length ? people.join(', ') : 'the family';

    const sent = await push.sendToMany(subs, {
      title: `New event for ${who}`,
      body: `${eventRow.title}\n${dateLabel} · ${timeLabel(occ)}`,
      url: '/',
      tag: `added-${eventRow.id}`,
    });
    return { sent };
  } catch (err) {
    // A notification failure must never break event creation.
    console.error('[notify] on-add failed:', err.message);
    return { sent: 0 };
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────
// ONE cron drives everything. The digest fires when household-local time enters
// the DIGEST_HOUR window, which keeps it correct even if the household changes
// its timezone at runtime (a fixed node-cron timezone would not).
async function tick() {
  try {
    const settings = getSettings();
    const now = localNow(settings.time_zone || 'America/New_York');

    // Send today's digest once. Keyed on the household-local date rather than
    // "we are inside the first five minutes of DIGEST_HOUR", which sent two
    // digests on the night the clocks go back (that hour happens twice) and
    // none at all if the container was restarting during those five minutes.
    // The catch-up window is bounded so starting a container in the evening
    // doesn't fire a digest for a day that's nearly over.
    const withinCatchUp = now.hour >= DIGEST_HOUR && now.hour < DIGEST_HOUR + 3;
    if (withinCatchUp && settings.last_digest_date !== now.date) {
      // Claim the day before sending. If the send throws, the digest is skipped
      // rather than retried every five minutes for the rest of the window.
      db.raw.prepare('UPDATE settings SET last_digest_date = ? WHERE id = 1').run(now.date);
      await runDigest();
    }

    await checkDueReminders();
  } catch (err) {
    console.error('[notify] tick failed:', err.message);
  }
}

function schedule() {
  cron.schedule(`*/${TICK_MINUTES} * * * *`, tick);
  console.log(
    `[notify] scheduled — every ${TICK_MINUTES}m; digest at ${String(DIGEST_HOUR).padStart(2, '0')}:00 household-local` +
      (WEBHOOK_URL ? `; webhook=${WEBHOOK_TYPE}` : '')
  );
}

module.exports = { schedule, tick, runDigest, checkDueReminders, notifyEventAdded, sendWebhook };
