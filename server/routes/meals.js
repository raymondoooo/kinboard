const db = require('../db');

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);

// Whitelist + coerce a request body into a `meals` row. Shared by create/update
// so both reject the same bad input the same way.
function toRow(body) {
  const row = {};
  if (body.title !== undefined) row.title = String(body.title).trim().slice(0, 200);
  if (body.date !== undefined) row.date = body.date;
  if (body.mealType !== undefined) row.meal_type = body.mealType;
  if (body.people !== undefined) {
    row.people = Array.isArray(body.people)
      ? body.people.filter(p => typeof p === 'string' && p).slice(0, 20)
      : [];
  }
  if (body.notes !== undefined) row.notes = body.notes || null;
  return row;
}

async function list(req, res) {
  const { data, error } = await db
    .from('meals')
    .select('*')
    .order('date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ meals: data });
}

async function create(req, res) {
  if (!req.body.title || !req.body.date) {
    return res.status(400).json({ error: 'title and date are required' });
  }
  if (!MEAL_TYPES.has(req.body.mealType)) {
    return res.status(400).json({ error: 'mealType must be breakfast, lunch, dinner, or snack' });
  }
  const row = toRow(req.body);

  const { data, error } = await db.from('meals').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, meal: data });
}

async function update(req, res) {
  const row = toRow(req.body);
  if (row.meal_type !== undefined && !MEAL_TYPES.has(row.meal_type)) {
    return res.status(400).json({ error: 'mealType must be breakfast, lunch, dinner, or snack' });
  }
  if (Object.keys(row).length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }
  row.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('meals')
    .update(row)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Meal not found' });
  res.json({ ok: true, meal: data });
}

async function remove(req, res) {
  const { error } = await db
    .from('meals')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}

module.exports = { list, create, update, remove };
