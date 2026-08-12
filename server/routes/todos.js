const crypto = require('crypto');
const db = require('../db');
const { isValidDate } = require('../validate');
const { dbError } = require('../respond');

const RECUR_PATTERNS = new Set(['daily', 'weekly', 'monthly']);

// A garbage due date doesn't just render wrong — for a repeating chore it is
// the anchor nextDueDate() advances from, so one bad value corrupts every
// future occurrence of that chore.
function badDueDate(row) {
  if (row.due_date === undefined || row.due_date === null) return null;
  return isValidDate(row.due_date) ? null : 'dueDate must be a real calendar date in YYYY-MM-DD form';
}

// Whitelist + coerce a request body into a `todos` row. Shared by
// create/update so both reject the same bad input the same way.
function toRow(body) {
  const row = {};
  if (body.title !== undefined) row.title = String(body.title).trim().slice(0, 200);
  if (body.people !== undefined) {
    row.people = Array.isArray(body.people)
      ? body.people.filter(p => typeof p === 'string' && p).slice(0, 20)
      : [];
  }
  if (body.dueDate !== undefined) row.due_date = body.dueDate || null;
  if (body.recurring !== undefined) row.recurring = RECUR_PATTERNS.has(body.recurring) ? body.recurring : null;
  if (body.notes !== undefined) row.notes = body.notes || null;
  if (body.points !== undefined) {
    const p = Math.trunc(Number(body.points));
    row.points = Number.isFinite(p) ? Math.min(9999, Math.max(0, p)) : 0;
  }
  if (body.done !== undefined) {
    row.done = !!body.done;
    row.completed_at = row.done ? new Date().toISOString() : null;
  }
  return row;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Advance a due date by one cycle of the given pattern. Monthly clamps to the
// last day of the target month rather than rolling into the following month
// (e.g. due Jan 31 + monthly -> Feb 28/29, not Mar 2/3).
function nextDueDate(dateStr, pattern) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (pattern === 'daily') return fmtDate(new Date(y, m - 1, d + 1));
  if (pattern === 'weekly') return fmtDate(new Date(y, m - 1, d + 7));
  if (pattern === 'monthly') {
    const next = new Date(y, m, 1); // 1st of next month
    const daysInNext = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(d, daysInNext));
    return fmtDate(next);
  }
  return dateStr;
}

// Append one ledger entry per assignee when a chore is checked off. Worth zero
// points? Still recorded — "who did what, when" is useful on its own, and it
// means turning points on later doesn't make earlier work look like it never
// happened.
//
// Credited to every assignee rather than split between them: splitting a
// 3-point chore between two kids invents fractions and arguments. An unassigned
// chore credits nobody, so it simply isn't a paid chore.
// Two taps must not pay twice.
//
// Checking a chore off is a read-modify-write spanning two tables: append to the
// ledger, then advance (or close) the to-do. Nothing made that atomic and
// nothing checked the row was actually *changing* state, so:
//
//   - tapping "done" on an already-done chore recorded a second payment, with
//     no concurrency involved at all; and
//   - five simultaneous check-offs wrote five ledger rows AND advanced a weekly
//     chore five weeks into the future, so the kid was paid five times and the
//     chore then vanished for a month.
//
// A recurring chore's `done` flag always returns to false, so "is it already
// done?" can't identify a duplicate there. What does is time: nobody genuinely
// completes the same chore twice within a minute, but a double-tap, a retried
// request, and two phones at once all land inside that.
const DUPLICATE_WINDOW_MS = 60 * 1000;

function recentlyCompleted(todoId) {
  const last = db.raw
    .prepare("SELECT completed_at FROM chore_completions WHERE todo_id = ? ORDER BY completed_at DESC LIMIT 1")
    .get(todoId);
  if (!last || !last.completed_at) return false;
  // SQLite's datetime('now') is UTC and space-separated; make it parseable.
  const t = Date.parse(String(last.completed_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && Date.now() - t < DUPLICATE_WINDOW_MS;
}

function recordCompletion(todo) {
  const people = Array.isArray(todo.people) ? todo.people.filter(Boolean) : [];
  if (!people.length) return;
  const stmt = db.raw.prepare(
    'INSERT INTO chore_completions (id, todo_id, title, person, points) VALUES (?, ?, ?, ?, ?)'
  );
  for (const person of people) {
    stmt.run(crypto.randomUUID(), todo.id, todo.title, person, todo.points || 0);
  }
}

// List todos. Open items first (oldest first), then completed items
// most-recently-completed first — matches how the client renders them.
async function list(req, res) {
  const { data, error } = await db
    .from('todos')
    .select('*')
    .order('done', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ todos: data });
}

async function create(req, res) {
  if (!req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  const row = toRow(req.body);
  const bad = badDueDate(row);
  if (bad) return res.status(400).json({ error: bad });
  delete row.done;
  delete row.completed_at; // new todos always start open
  // A repeat pattern needs an anchor date to advance from — default to today
  // rather than reject, since picking "Daily" is a clearer signal of intent
  // than the due-date field itself.
  if (row.recurring && !row.due_date) row.due_date = fmtDate(new Date());

  const { data, error } = await db.from('todos').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, todo: data });
}

async function update(req, res) {
  const row = toRow(req.body);
  if (Object.keys(row).length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }
  const bad = badDueDate(row);
  if (bad) return res.status(400).json({ error: bad });

  // Checking off a recurring to-do advances it to its next due date instead
  // of marking it permanently done — chores repeat, they don't finish.
  if (row.done === true) {
    // The whole read-decide-write runs inside one SQLite transaction, so two
    // requests arriving together are serialized rather than both acting on the
    // state they each read first. better-sqlite3 transactions are synchronous,
    // which is exactly what makes this safe.
    const settle = db.raw.transaction((id) => {
      const found = db.raw.prepare('SELECT * FROM todos WHERE id = ?').get(id);
      if (!found) return { notFound: true };
      const existing = db.decodeRow('todos', found);

      // Already finished, or the same completion arriving twice — either way
      // there is nothing new to pay for.
      if (existing.done || recentlyCompleted(id)) return { duplicate: true, existing };

      // Record BEFORE the row mutates: a repeating chore is about to forget
      // this ever happened (done flips back to false), so the ledger is the
      // only place the earning survives.
      recordCompletion(existing);
      return { existing };
    })(req.params.id);

    if (settle.notFound) return res.status(404).json({ error: 'To-do not found' });

    if (settle.duplicate) {
      // Answer success with the row as it stands. The tap did land the first
      // time; repeating it simply has no further effect.
      const current = db.decodeRow('todos', db.raw.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id));
      return res.json({ ok: true, todo: current, duplicate: true });
    }

    const existing = settle.existing;
    if (existing.recurring && existing.due_date) {
      row.due_date = nextDueDate(existing.due_date, existing.recurring);
      row.done = false;
      row.completed_at = null;
    }
  }

  row.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('todos')
    .update(row)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return dbError(res, error, 'To-do not found');
  res.json({ ok: true, todo: data });
}

async function remove(req, res) {
  const { error } = await db
    .from('todos')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}

// ── Earnings ────────────────────────────────────────────────────────────────

function settingsRow() {
  return db.raw.prepare('SELECT point_value_cents, currency_symbol FROM settings WHERE id = 1').get()
    || { point_value_cents: 0, currency_symbol: '$' };
}

// Per-person totals, plus the unsettled balance a parent actually owes.
// `outstanding` deliberately counts only completions that haven't been paid
// out, so settling up doesn't erase the history of what was earned.
async function earnings(req, res) {
  const s = settingsRow();
  const rows = db.raw.prepare(`
    SELECT person,
           SUM(points)                                        AS points_total,
           SUM(CASE WHEN paid_out_at IS NULL THEN points ELSE 0 END) AS points_outstanding,
           COUNT(*)                                           AS completions,
           MAX(completed_at)                                  AS last_completed
    FROM chore_completions
    GROUP BY person
    ORDER BY points_outstanding DESC, person ASC
  `).all();

  const cents = (p) => p * (s.point_value_cents || 0);
  res.json({
    pointValueCents: s.point_value_cents || 0,
    currencySymbol: s.currency_symbol || '$',
    people: rows.map((r) => ({
      person: r.person,
      points: r.points_total || 0,
      pointsOutstanding: r.points_outstanding || 0,
      completions: r.completions || 0,
      lastCompleted: r.last_completed || null,
      earnedCents: cents(r.points_total || 0),
      owedCents: cents(r.points_outstanding || 0),
    })),
  });
}

// Recent completion history, optionally for one person.
async function completions(req, res) {
  const person = (req.query.person || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = person
    ? db.raw.prepare('SELECT * FROM chore_completions WHERE person = ? ORDER BY completed_at DESC LIMIT ?').all(person, limit)
    : db.raw.prepare('SELECT * FROM chore_completions ORDER BY completed_at DESC LIMIT ?').all(limit);
  res.json({ completions: rows });
}

// Settle up: stamp everything currently owed to someone as paid. Keeps the rows
// (so history survives) rather than deleting them — "I already paid you for
// that" is exactly the argument this table exists to end.
async function payout(req, res) {
  const person = (req.body && String(req.body.person || '').trim()) || '';
  if (!person) return res.status(400).json({ error: 'person is required' });
  const info = db.raw
    .prepare("UPDATE chore_completions SET paid_out_at = datetime('now') WHERE person = ? AND paid_out_at IS NULL")
    .run(person);
  res.json({ ok: true, settled: info.changes });
}

module.exports = { list, create, update, remove, earnings, completions, payout };
