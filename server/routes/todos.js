const db = require('../db');

const RECUR_PATTERNS = new Set(['daily', 'weekly', 'monthly']);

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

  // Checking off a recurring to-do advances it to its next due date instead
  // of marking it permanently done — chores repeat, they don't finish.
  if (row.done === true) {
    const { data: existing } = await db
      .from('todos').select('due_date, recurring')
      .eq('id', req.params.id).maybeSingle();
    if (existing && existing.recurring && existing.due_date) {
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

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Todo not found' });
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

module.exports = { list, create, update, remove };
