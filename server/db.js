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
        return { data: null, error: { message: decoded.length === 0 ? 'No rows found' : 'Multiple rows found' } };
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
