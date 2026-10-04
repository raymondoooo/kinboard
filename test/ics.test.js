// node --test   (no dependencies: exercises server/ics.js directly)
const test = require('node:test');
const assert = require('node:assert');
const { buildIcs, fmtTime, zonedToUtc } = require('../server/ics');

const TZ = 'America/New_York';
const settings = { name: 'Test Family', time_zone: TZ };

const events = [
  // Hand-entered: time stored as HH:MM — the shape that produced DTSTART:…T1930.
  { id: 'hhmm', title: 'Minions/Draft', date: '2026-08-13', start_time: '19:30', end_time: '23:00', all_day: 0, created_at: '2026-08-01 12:00:00' },
  // Imported: HH:MM:SS.
  { id: 'hhmmss', title: 'Dentist', date: '2026-08-13', start_time: '10:00:00', end_time: '11:00:00', all_day: 0, created_at: '2026-08-01 12:00:00' },
  { id: 'single-digit', title: 'Early', date: '2026-08-14', start_time: '7:05', all_day: 0, created_at: '2026-08-01 12:00:00' },
  { id: 'allday', title: 'Field trip', date: '2026-08-15', all_day: 1, created_at: '2026-08-01 12:00:00' },
  // Ends after midnight.
  { id: 'overnight', title: 'Sleepover', date: '2026-08-15', start_time: '19:00', end_time: '01:00', all_day: 0, created_at: '2026-08-01 12:00:00' },
  // Weekly, HH:MM, skipped weeks, an end date.
  { id: 'weekly', title: '⚽ Practice', date: '2026-07-07', start_time: '17:30', end_time: '19:00', all_day: 0,
    recurring: 'weekly', exdates: ['2026-07-28', '2026-08-11'], ends_on: '2026-11-17', created_at: '2026-07-01 12:00:00' },
  // Imported rule with a floating UNTIL (as stored by imports).
  { id: 'imported', title: 'XMA - Flyers', date: '2026-06-04', start_time: '18:00', end_time: '19:00', all_day: 0,
    rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20260710T035959;BYDAY=TH', exdates: ['2026-06-18'], created_at: '2026-06-01 12:00:00' },
  // All-day recurring with exdates and an end.
  { id: 'monthly', title: 'Rent', date: '2026-01-01', all_day: 1, recurring: 'monthly', exdates: ['2026-03-01'], ends_on: '2026-12-31', created_at: '2026-01-01 12:00:00' },
  { id: 'dow', title: 'Book club', date: '2026-08-20', start_time: '19:00', all_day: 0, recurring: 'monthly_dow', created_at: '2026-08-01 12:00:00' },
];

const feedOccs = [
  { uid: 'f1', title: 'Work offsite', start: '2026-08-13T13:00:00.000Z', end: '2026-08-13T21:00:00.000Z', allDay: false },
  { uid: 'f2', title: 'Holiday', start: '2026-08-17', allDay: true },
  { uid: 'f3', title: 'A long, long title with emoji 🎉🎉🎉 so the line must fold across a multi-byte character boundary', start: '2026-08-18T12:00:00.000Z', allDay: false },
];

const ics = buildIcs(settings, events, feedOccs, new Date('2026-10-04T12:00:00Z'));
const unfolded = ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
const vevents = () => unfolded.slice(unfolded.indexOf('END:VTIMEZONE'));

test('every DTSTART/DTEND/EXDATE/RECURRENCE-ID value is a valid RFC 5545 DATE or DATE-TIME', () => {
  const props = vevents().filter(l => /^(DTSTART|DTEND|EXDATE|RECURRENCE-ID)[;:]/.test(l));
  assert.ok(props.length > 15, `expected plenty of date props, got ${props.length}`);
  for (const line of props) {
    for (const value of line.slice(line.indexOf(':') + 1).split(',')) {
      assert.match(value, /^\d{8}(T\d{6}Z?)?$/, line);
    }
  }
});

test('an HH:MM time comes out HHMMSS', () => {
  assert.ok(unfolded.includes('DTSTART;TZID=America/New_York:20260813T193000'));
  assert.ok(unfolded.includes('DTEND;TZID=America/New_York:20260813T230000'));
  assert.ok(unfolded.includes('DTSTART;TZID=America/New_York:20260814T070500'));
  assert.strictEqual(fmtTime('19:30'), '193000');
  assert.strictEqual(fmtTime('19:30:15'), '193015');
  assert.throws(() => fmtTime('25:00'));
});

test('an all-day event is VALUE=DATE', () => {
  assert.ok(unfolded.includes('DTSTART;VALUE=DATE:20260815'));
});

test('an overnight event ends the next day', () => {
  assert.ok(unfolded.includes('DTEND;TZID=America/New_York:20260816T010000'));
});

test('EXDATE and UNTIL match the type of DTSTART', () => {
  assert.ok(unfolded.includes('EXDATE;TZID=America/New_York:20260728T173000,20260811T173000'));
  assert.ok(unfolded.includes('EXDATE;VALUE=DATE:20260301'));
  for (const line of unfolded.filter(l => l.startsWith('RRULE:'))) {
    const until = /UNTIL=([^;]+)/.exec(line);
    if (until) assert.match(until[1], /^\d{8}(T\d{6}Z)?$/, line);
  }
  // Timed series: end of the ends_on day, New York time, in UTC.
  assert.ok(unfolded.includes('RRULE:FREQ=WEEKLY;UNTIL=20261118T045959Z'));
  // Imported floating UNTIL read as household-local and converted.
  assert.ok(unfolded.includes('RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260710T075959Z;BYDAY=TH'));
  // All-day series: a plain DATE.
  assert.ok(unfolded.includes('RRULE:FREQ=MONTHLY;UNTIL=20261231'));
});

test('feed occurrences are written in UTC', () => {
  assert.ok(unfolded.includes('DTSTART:20260813T130000Z'));
  assert.ok(unfolded.includes('DTEND:20260813T210000Z'));
});

test('every TZID used has a VTIMEZONE, with both DST observances', () => {
  const used = new Set(unfolded.map(l => /;TZID=([^:;]+)/.exec(l)?.[1]).filter(Boolean));
  const defined = new Set(unfolded.filter(l => l.startsWith('TZID:')).map(l => l.slice(5)));
  for (const tz of used) assert.ok(defined.has(tz), `no VTIMEZONE for ${tz}`);
  assert.ok(unfolded.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'));
  assert.ok(unfolded.includes('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'));
  // Transitions land on the exact local second (2am), not a rounding off it.
  const starts = unfolded.slice(0, unfolded.indexOf('END:VTIMEZONE')).filter(l => l.startsWith('DTSTART:'));
  for (const l of starts) assert.match(l, /T0[12]0000$/, l);
});

test('wall-clock → UTC follows DST', () => {
  assert.strictEqual(zonedToUtc('2026-07-01', '19:30', TZ).toISOString(), '2026-07-01T23:30:00.000Z');
  assert.strictEqual(zonedToUtc('2026-01-15', '19:30', TZ).toISOString(), '2026-01-16T00:30:00.000Z');
});

test('lines fold at 75 octets without splitting a character', () => {
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(!Buffer.from(ics).toString('utf8').includes('�'));
  assert.ok(unfolded.some(l => l.includes('🎉🎉🎉 so the line must fold')));
});

test('one unwritable event is skipped, not the whole feed', () => {
  const out = buildIcs(settings, [{ id: 'bad', title: 'Bad', date: 'not a date', all_day: 1 }, events[0]], []);
  assert.match(out, /SUMMARY:Minions\/Draft/);
  assert.doesNotMatch(out, /SUMMARY:Bad/);
});
