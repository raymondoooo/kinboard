#!/usr/bin/env node
/**
 * Import one kinevents tenant into a Kinboard database.
 *
 *   node scripts/import-kinevents.js --file export.json [--data-dir ./data] [--force]
 *
 * Kinboard was forked from a multi-tenant Postgres app, so the tables are still
 * close to 1:1. What genuinely changes shape:
 *
 *   - The tenant row becomes the single `settings` row. Billing, plan, trial and
 *     subdomain columns are dropped; they mean nothing when you host it yourself.
 *   - Members keep their name, colour, emoji and type but lose their logins.
 *     Kinboard has one shared household password, so nine accounts become nine
 *     labels — the people are still there, they just don't sign in separately.
 *   - Postgres arrays/JSONB become JSON text and booleans become 0/1, which is
 *     what server/db.js already expects.
 *
 * What cannot come across, by nature rather than laziness:
 *   - Push subscriptions. They're bound to the origin that created them, and the
 *     origin is changing. Everyone re-enables notifications once.
 *   - Auth. You set the household password during Kinboard's /setup.
 *
 * Import is idempotent per source row: every record carries its original UUID,
 * so re-running skips what's already there instead of duplicating it.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const FILE = arg('file');
const DATA_DIR = arg('data-dir', path.join(__dirname, '..', 'data'));
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');

if (!FILE) {
  console.error('Usage: node scripts/import-kinevents.js --file export.json [--data-dir ./data] [--dry-run] [--force]');
  process.exit(1);
}

process.env.DATA_DIR = DATA_DIR;
const db = require('../server/db');
const raw = db.raw;

const src = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (!src.tenant) {
  console.error('That file has no `tenant` object — is it a kinevents export?');
  process.exit(1);
}

// ── helpers ────────────────────────────────────────────────────────────────
const jsonArr = (v) => JSON.stringify(Array.isArray(v) ? v : (v == null ? [] : [v]));
const bool = (v) => (v ? 1 : 0);
// Postgres returns timestamptz as ISO; SQLite stores text. Times are already
// wall-clock strings in both, so dates and times pass straight through.
const txt = (v) => (v == null ? null : String(v));

function exists(table, id) {
  return !!raw.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

let inserted = { members: 0, events: 0, feeds: 0, meals: 0, todos: 0 };
let skipped = { members: 0, events: 0, feeds: 0, meals: 0, todos: 0 };

// ── preflight ──────────────────────────────────────────────────────────────
const household = raw.prepare('SELECT 1 FROM household WHERE id = 1').get();
if (!household) {
  console.error(
    '\nThis Kinboard has not been set up yet.\n' +
    'Start the container, complete /setup (that is where the household password\n' +
    'is chosen — it cannot be imported), then run this again.\n'
  );
  process.exit(1);
}

const existingEvents = raw.prepare('SELECT COUNT(*) c FROM events').get().c;
if (existingEvents > 0 && !FORCE) {
  console.error(
    `\nThis Kinboard already has ${existingEvents} event(s).\n` +
    'Importing on top of real data is allowed but rarely what you want, so it\n' +
    'needs --force. Rows are matched on their original IDs, so a repeat import\n' +
    'of the same export is safe and will simply skip everything.\n'
  );
  process.exit(1);
}

console.log(`\nImporting "${src.tenant.name}" into ${path.resolve(DATA_DIR)}`);
console.log(`  ${(src.members || []).length} members · ${(src.events || []).length} events · ` +
            `${(src.feeds || []).length} feeds · ${(src.meals || []).length} meals · ${(src.todos || []).length} todos`);
if (DRY) console.log('  (dry run — nothing will be written)\n');

// Everything in one transaction: a partial import that half-populated someone's
// calendar would be worse than a clean failure.
const run = raw.transaction(() => {
  const t = src.tenant;

  // Settings: the tenant row minus everything that only means something to a
  // hosted, billed, multi-tenant service.
  raw.prepare(`
    UPDATE settings SET
      name = ?, time_zone = ?, weeks_to_show = ?, first_day_of_week = ?, theme = ?,
      zip = ?, latitude = ?, longitude = ?, weather_units = ?, holidays = ?,
      is_public = ?, share_token = ?, share_keywords = ?
    WHERE id = 1
  `).run(
    txt(t.name) || 'Our Family',
    txt(t.time_zone) || 'America/New_York',
    t.weeks_to_show ?? 4,
    t.first_day_of_week ?? 0,
    txt(t.theme) || 'dark',
    txt(t.zip),
    t.latitude ?? null,
    t.longitude ?? null,
    txt(t.weather_units) || 'fahrenheit',
    jsonArr(t.holidays),
    bool(t.is_public),
    // The share token carries over so existing share/.ics links keep working —
    // but only if the host stays the same, which it usually won't. Regenerate
    // from Settings if the old links are dead.
    txt(t.share_token),
    jsonArr(t.share_keywords)
  );

  for (const m of src.members || []) {
    if (!m.display_name) continue;              // pending invites have no name yet
    if (exists('members', m.id)) { skipped.members++; continue; }
    raw.prepare(`INSERT INTO members (id, display_name, color, emoji, member_type, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`)
      .run(m.id, txt(m.display_name), txt(m.color), txt(m.emoji),
           txt(m.member_type) || 'person', txt(m.created_at) || new Date().toISOString());
    inserted.members++;
  }

  for (const e of src.events || []) {
    if (exists('events', e.id)) { skipped.events++; continue; }
    raw.prepare(`INSERT INTO events
      (id, title, date, start_time, end_time, all_day, people, location, recurring,
       ends_on, exdates, rrule, share_override, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, txt(e.title), txt(e.date), txt(e.start_time), txt(e.end_time),
           bool(e.all_day), jsonArr(e.people), txt(e.location), txt(e.recurring),
           txt(e.ends_on), jsonArr(e.exdates), txt(e.rrule), txt(e.share_override),
           txt(e.created_at) || new Date().toISOString(),
           txt(e.updated_at) || new Date().toISOString());
    inserted.events++;
  }

  for (const f of src.feeds || []) {
    if (exists('feeds', f.id)) { skipped.feeds++; continue; }
    raw.prepare(`INSERT INTO feeds
      (id, name, url, fixed_person, color, last_synced_at, emoji, display_name, category, never_share)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(f.id, txt(f.name), txt(f.url), txt(f.fixed_person), txt(f.color),
           txt(f.last_synced_at), txt(f.emoji), txt(f.display_name),
           txt(f.category) || 'personal', bool(f.never_share));
    inserted.feeds++;
  }

  for (const m of src.meals || []) {
    if (exists('meals', m.id)) { skipped.meals++; continue; }
    raw.prepare(`INSERT INTO meals (id, date, meal_type, title, people, notes, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?)`)
      .run(m.id, txt(m.date), txt(m.meal_type), txt(m.title), jsonArr(m.people),
           txt(m.notes), txt(m.created_at) || new Date().toISOString(),
           txt(m.updated_at) || new Date().toISOString());
    inserted.meals++;
  }

  for (const td of src.todos || []) {
    if (exists('todos', td.id)) { skipped.todos++; continue; }
    // points has no source column — kinevents has no chore values. Everything
    // arrives worth nothing, which is correct: the parent prices chores after
    // the move rather than having values invented for them.
    raw.prepare(`INSERT INTO todos
      (id, title, done, people, due_date, recurring, notes, points, created_at, updated_at, completed_at)
      VALUES (?,?,?,?,?,?,?,0,?,?,?)`)
      .run(td.id, txt(td.title), bool(td.done), jsonArr(td.people), txt(td.due_date),
           txt(td.recurring), txt(td.notes),
           txt(td.created_at) || new Date().toISOString(),
           txt(td.updated_at) || new Date().toISOString(), txt(td.completed_at));
    inserted.todos++;
  }

  if (DRY) throw new Error('__DRY_RUN__');
});

try {
  run();
} catch (err) {
  if (err.message === '__DRY_RUN__') {
    console.log('Dry run complete — would have inserted:');
    for (const k of Object.keys(inserted)) console.log(`  ${k}: ${inserted[k]}`);
    process.exit(0);
  }
  console.error('\nImport failed and was rolled back — nothing was written.\n', err.message);
  process.exit(1);
}

console.log('\nImported:');
for (const k of Object.keys(inserted)) {
  console.log(`  ${k}: ${inserted[k]}${skipped[k] ? ` (${skipped[k]} already present, skipped)` : ''}`);
}
console.log(
  '\nNot imported, by nature:\n' +
  '  - Logins. Everyone now uses the one household password.\n' +
  '  - Push notifications. Each device re-enables once from Settings.\n' +
  '  - Chore values. Price chores in the To-Do tab whenever you like.\n' +
  '\nRestart the container so it picks up the imported data.\n'
);
