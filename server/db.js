// SQLite connection + a small chainable query builder.
//
// The route code in server/routes/ is written against a narrow, uniform slice of
// a fluent query API: .from().select().eq()/.order()/.single()/.maybeSingle(),
// and .insert()/.update()/.delete() optionally followed by .select(). This file
// implements exactly that subset on top of better-sqlite3, which keeps the route
// handlers declarative and free of hand-written SQL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const raw = new Database(path.join(DATA_DIR, 'kinboard.db'));
raw.pragma('journal_mode = WAL');
raw.pragma('busy_timeout = 5000');

raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
raw.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();

// ── Adding a column to an existing install ──────────────────────────────────
// schema.sql is re-executed on EVERY boot, so it can only contain statements
// that are safe to run repeatedly. `create table if not exists` is; a bare
// `alter table … add column` is NOT — it throws once the column exists, which
// would crash-loop the container for everyone who already has data.
//
// So new columns go in two places: the `create table` above (for fresh
// installs) and a call here (for existing ones). This checks the live table
// shape first, so it applies exactly once and is a no-op on every later boot.
//
// Only ever ADD. Dropping or renaming a column, or adding a NOT NULL without a
// default, would break databases already in the wild.
function ensureColumn(table, column, definition) {
  const exists = raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (exists) return false;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] added column ${table}.${column}`);
  return true;
}

// ── Schema versioning + downgrade protection ────────────────────────────────
// The version lives in SQLite's own `PRAGMA user_version` (an integer in the
// file header), so it needs no table and travels with the database file.
//
// The failure this exists to prevent: a user pulls a newer image, hits a bug,
// and rolls back to the previous tag. Their database has already been upgraded,
// and the older binary knows nothing about the new shape — so it writes happily
// into a schema it doesn't understand and quietly corrupts their data. Refusing
// to start is dramatically better than that, and it's what mature self-hosted
// projects do.
//
// Migrations are forward-only and ordered. Each `up(db)` receives the raw
// database handle and runs inside its own transaction, so it can do schema AND
// data work together — SQLite makes DDL transactional, so a step that adds a
// column and backfills it either fully applies or not at all:
//
//   { version: 3, describe: 'split name into first/last', up(db) {
//       ensureColumn('members', 'first_name', 'text');
//       for (const m of db.prepare('SELECT id, display_name FROM members').all()) {
//         db.prepare('UPDATE members SET first_name = ? WHERE id = ?')
//           .run(String(m.display_name || '').split(' ')[0], m.id);
//       }
//   }}
//
// Each `up()` must be safe to re-run: databases predating this versioning
// scheme report version 0 and may already have some columns from a pre-release
// build, so schema steps go through ensureColumn rather than a bare ALTER.
// A backup is taken before any migration runs on an existing database.
const SCHEMA_VERSION = 3;

const MIGRATIONS = [
  {
    version: 1,
    describe: 'baseline (tables are created by schema.sql)',
    up() { /* schema.sql already ran above; nothing extra for the original shape */ },
  },
  {
    version: 2,
    describe: 'chore points, point value, and the earnings ledger',
    up() {
      ensureColumn('todos', 'points', 'integer not null default 0');
      ensureColumn('settings', 'point_value_cents', 'integer not null default 0');
      ensureColumn('settings', 'currency_symbol', "text not null default '$'");
      // chore_completions itself is created by schema.sql (create table if not exists).
    },
  },
  {
    version: 3,
    describe: 'remember which day the digest was last sent',
    up() {
      // The digest used to fire purely on "local hour == DIGEST_HOUR and minute
      // < 5". On the autumn DST change that hour happens twice, so a digest set
      // to it went out twice; and if the container happened to be down for those
      // five minutes, it didn't go out at all. Recording the day it last went
      // makes both impossible.
      ensureColumn('settings', 'last_digest_date', 'text');

      // Backfill, or upgrading mid-morning sends a duplicate digest: the new
      // column starts NULL, the catch-up window runs for three hours after the
      // digest hour, so an instance restarted at 07:38 immediately decides today
      // has been missed and sends a second one. Only backfill when today's
      // digest would already have gone out under the old code — upgrading
      // *before* the digest hour must still leave today's to fire normally.
      const row = raw.prepare('SELECT time_zone FROM settings WHERE id = 1').get();
      if (!row) return; // fresh install; nothing has been sent yet
      const digestHour = Number.isInteger(+process.env.DIGEST_HOUR) ? +process.env.DIGEST_HOUR : 7;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: row.time_zone || 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date());
      const g = (t) => parts.find((p) => p.type === t).value;
      let hour = +g('hour');
      if (hour === 24) hour = 0;
      if (hour > digestHour) {
        const today = `${g('year')}-${g('month')}-${g('day')}`;
        raw.prepare('UPDATE settings SET last_digest_date = ? WHERE id = 1').run(today);
        console.log(`[db] marked today's digest (${today}) as already sent, so upgrading doesn't repeat it`);
      }
    },
  },
];

// Snapshot the database before touching its shape. Per-migration transactions
// protect a single step, but a run of several steps can still commit two and
// fail on the third — leaving a half-migrated database and no way back. This is
// the "restore a backup" that the downgrade message promises actually exists.
// Uses better-sqlite3's online backup, so WAL is checkpointed into one
// consistent file rather than copied mid-write.
function backupBeforeMigrating(fromVersion, toVersion) {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `pre-upgrade-v${fromVersion}-to-v${toVersion}-${stamp}.db`);

    // VACUUM INTO, not db.backup(): better-sqlite3's backup() is ASYNCHRONOUS
    // and returns a promise. Migrations run synchronously at startup, so an
    // un-awaited backup finishes *after* they do — producing a "pre-upgrade"
    // snapshot of the already-upgraded database, which is worse than useless
    // because it looks like a safety net and isn't. VACUUM INTO is synchronous
    // and writes a consistent, WAL-checkpointed copy before anything changes.
    raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);

    console.log(`[db] pre-upgrade backup written to ${dest}`);
    return dest;
  } catch (err) {
    // A fresh install has nothing worth preserving, so a failure here must not
    // block first boot — but on an existing database it's worth shouting about.
    console.error(`[db] WARNING: could not write pre-upgrade backup: ${err.message}`);
    return null;
  }
}

// Has this database been set up by a real household? schema.sql has already run
// by this point, so the tables exist either way — the presence of the household
// row is what distinguishes "someone's calendar" from "an empty file".
function hasUserData() {
  try {
    return !!raw.prepare('SELECT 1 FROM household WHERE id = 1').get();
  } catch {
    return false;
  }
}

function migrate() {
  const current = raw.pragma('user_version', { simple: true }) || 0;

  if (current > SCHEMA_VERSION) {
    console.error(
      `\n[db] REFUSING TO START — this database was created by a NEWER version of Kinboard.\n` +
      `     database schema version: ${current}\n` +
      `     this image understands:  ${SCHEMA_VERSION}\n\n` +
      `     You have most likely rolled back to an older image. Running this version\n` +
      `     would write into a schema it does not understand and could corrupt your\n` +
      `     data, so it is stopping instead.\n\n` +
      `     Fix: go back to the newer image tag. If you genuinely need to downgrade,\n` +
      `     restore a backup from /app/data/backups taken before the upgrade.\n`
    );
    process.exit(1);
  }

  if (current === SCHEMA_VERSION) return;

  // Back up any database that actually holds something.
  //
  // Do NOT infer that from the version number: databases created before this
  // versioning scheme existed report version 0, which is also what a brand-new
  // file reports. Treating 0 as "new" would skip the backup for every existing
  // user upgrading from an earlier release — precisely the people with data to
  // lose. Completed setup is the honest signal that there's something to
  // protect; a fresh install has no household row and needs no snapshot.
  if (hasUserData()) backupBeforeMigrating(current, SCHEMA_VERSION);

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    console.log(`[db] migrating to schema v${m.version} — ${m.describe}`);
    try {
      // One transaction per step, so a step either fully applies or not at all.
      // SQLite makes DDL transactional, so schema and data changes commit
      // together — a migration can reshape a column AND backfill it safely.
      raw.transaction(() => m.up(raw))();
    } catch (err) {
      console.error(
        `\n[db] MIGRATION FAILED at schema v${m.version} (${m.describe}):\n` +
        `     ${err.message}\n\n` +
        `     That step was rolled back, so the database is still at v${current}.\n` +
        `     A pre-upgrade backup is in /app/data/backups. Please report this at\n` +
        `     https://github.com/raymondoooo/kinboard/issues with the message above.\n`
      );
      process.exit(1);
    }
  }
  raw.pragma(`user_version = ${SCHEMA_VERSION}`);
  console.log(`[db] schema is now v${SCHEMA_VERSION}`);
}

migrate();

// ── Column type maps ────────────────────────────────────────────────────────
// SQLite has no array/JSON or boolean types. JSON columns round-trip through
// TEXT (JSON.stringify on write, JSON.parse on read); boolean columns round-
// trip through INTEGER 0/1. Every other column passes through unchanged.
const JSON_COLUMNS = {
  settings: new Set(['holidays', 'share_keywords']),
  events: new Set(['people', 'exdates']),
  meals: new Set(['people']),
  todos: new Set(['people']),
  push_subscriptions: new Set(['notify_people']),
};
const BOOL_COLUMNS = {
  settings: new Set(['is_public']),
  events: new Set(['all_day']),
  feeds: new Set(['never_share']),
  todos: new Set(['done']),
  push_subscriptions: new Set(['digest_enabled', 'reminders_enabled', 'on_add_enabled']),
};

function encodeRow(table, row) {
  const jsonCols = JSON_COLUMNS[table];
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value != null && jsonCols && jsonCols.has(key)) out[key] = JSON.stringify(value);
    else if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else out[key] = value;
  }
  return out;
}

function decodeRow(table, row) {
  if (!row) return row;
  const jsonCols = JSON_COLUMNS[table];
  const boolCols = BOOL_COLUMNS[table];
  const out = { ...row };
  if (jsonCols) {
    for (const key of jsonCols) {
      if (key in out) {
        try { out[key] = out[key] == null ? [] : JSON.parse(out[key]); }
        catch { out[key] = []; }
      }
    }
  }
  if (boolCols) {
    for (const key of boolCols) {
      if (key in out) out[key] = !!out[key];
    }
  }
  return out;
}

function encodeCondVal(val) {
  return typeof val === 'boolean' ? (val ? 1 : 0) : val;
}

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.mode = null; // 'select' | 'insert' | 'update' | 'delete'
    this.selectCols = '*';
    this.conditions = [];
    this.orderBys = [];
    this.limitN = null;
    this.insertRows = null;
    this.updateRow = null;
    this.wantSingle = false;
    this.wantMaybeSingle = false;
    this.returning = false;
  }

  select(cols = '*') {
    if (this.mode === 'insert' || this.mode === 'update') { this.returning = true; return this; }
    this.mode = this.mode || 'select';
    this.selectCols = cols;
    return this;
  }
  insert(row) { this.mode = 'insert'; this.insertRows = Array.isArray(row) ? row : [row]; return this; }
  update(row) { this.mode = 'update'; this.updateRow = row; return this; }
  delete() { this.mode = 'delete'; return this; }

  eq(col, val) { this.conditions.push({ col, op: '=', val }); return this; }
  neq(col, val) { this.conditions.push({ col, op: '!=', val }); return this; }
  in(col, arr) { this.conditions.push({ col, op: 'IN', val: arr }); return this; }
  gte(col, val) { this.conditions.push({ col, op: '>=', val }); return this; }
  lte(col, val) { this.conditions.push({ col, op: '<=', val }); return this; }
  gt(col, val) { this.conditions.push({ col, op: '>', val }); return this; }
  lt(col, val) { this.conditions.push({ col, op: '<', val }); return this; }

  order(col, opts = {}) { this.orderBys.push({ col, ascending: opts.ascending !== false }); return this; }
  limit(n) { this.limitN = n; return this; }

  single() { this.wantSingle = true; return this._exec(); }
  maybeSingle() { this.wantMaybeSingle = true; return this._exec(); }
  then(resolve, reject) { return this._exec().then(resolve, reject); }
  catch(reject) { return this._exec().catch(reject); }

  _where() {
    if (!this.conditions.length) return { sql: '', params: [] };
    const parts = [];
    const params = [];
    for (const c of this.conditions) {
      if (c.op === 'IN') {
        parts.push(`${c.col} IN (${c.val.map(() => '?').join(',')})`);
        params.push(...c.val.map(encodeCondVal));
      } else {
        parts.push(`${c.col} ${c.op} ?`);
        params.push(encodeCondVal(c.val));
      }
    }
    return { sql: ' WHERE ' + parts.join(' AND '), params };
  }

  _finish(rows) {
    const decoded = rows.map((r) => decodeRow(this.table, r));
    if (this.wantSingle) {
      if (decoded.length !== 1) {
        // `notFound` lets a caller tell "that row is gone" apart from "the
        // database failed". Without it, updating a deleted row answered 500 —
        // which is what a family got when one phone deleted an event and
        // another edited it a moment later, a routine race on a shared
        // calendar. (`code` mirrors PostgREST, matching the supabase-js shape
        // the rest of this shim imitates.)
        return {
          data: null,
          error: decoded.length === 0
            ? { message: 'No rows found', code: 'PGRST116', notFound: true }
            : { message: 'Multiple rows found' },
        };
      }
      return { data: decoded[0], error: null };
    }
    if (this.wantMaybeSingle) return { data: decoded[0] || null, error: null };
    return { data: decoded, error: null };
  }

  async _exec() {
    try {
      const table = this.table;
      if (this.mode === 'insert') {
        const ids = [];
        for (const row of this.insertRows) {
          const withId = row.id ? row : { ...row, id: crypto.randomUUID() };
          ids.push(withId.id);
          const encoded = encodeRow(table, withId);
          const cols = Object.keys(encoded);
          const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          raw.prepare(sql).run(...cols.map((c) => encoded[c]));
        }
        if (!this.returning) return { data: null, error: null };
        const placeholders = ids.map(() => '?').join(',');
        const rows = raw.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...ids);
        return this._finish(rows);
      }

      if (this.mode === 'update') {
        const encoded = encodeRow(table, this.updateRow);
        const cols = Object.keys(encoded);
        const { sql: whereSql, params: whereParams } = this._where();
        const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}${whereSql}`;
        raw.prepare(sql).run(...cols.map((c) => encoded[c]), ...whereParams);
        if (!this.returning) return { data: null, error: null };
        const { sql: selWhereSql, params: selParams } = this._where();
        const rows = raw.prepare(`SELECT * FROM ${table}${selWhereSql}`).all(...selParams);
        return this._finish(rows);
      }

      if (this.mode === 'delete') {
        const { sql: whereSql, params } = this._where();
        raw.prepare(`DELETE FROM ${table}${whereSql}`).run(...params);
        return { data: null, error: null };
      }

      // select (default mode)
      const { sql: whereSql, params } = this._where();
      let sql = `SELECT ${this.selectCols} FROM ${table}${whereSql}`;
      if (this.orderBys.length) {
        sql += ' ORDER BY ' + this.orderBys.map((o) => `${o.col} ${o.ascending ? 'ASC' : 'DESC'}`).join(', ');
      }
      if (this.limitN != null) sql += ` LIMIT ${this.limitN}`;
      const rows = raw.prepare(sql).all(...params);
      return this._finish(rows);
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }
}

module.exports = {
  from(table) { return new QueryBuilder(table); },
  raw,
  decodeRow,
  DATA_DIR,
};
