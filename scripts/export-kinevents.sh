#!/usr/bin/env bash
# Export one kinevents tenant to a JSON file that import-kinevents.js can read.
#
#   ./scripts/export-kinevents.sh <tenant-slug> [output.json]
#
# Run this ON the box hosting kinevents' Postgres. It is READ-ONLY — it opens no
# transaction, writes nothing, and touches only the one tenant you name.
#
# Deliberately a separate step from the import: a JSON file can be inspected,
# diffed and kept before anything is written to the new database, which a direct
# database-to-database copy never lets you do.
set -euo pipefail

SLUG="${1:?Usage: export-kinevents.sh <tenant-slug> [output.json]}"
OUT="${2:-kinevents-${SLUG}.json}"
CONTAINER="${PG_CONTAINER:-supabase-db}"
DB_USER="${PG_USER:-postgres}"
DB_NAME="${PG_DB:-postgres}"

# NOTE: filter on the `public` schema explicitly. A Supabase stack also has a
# `realtime.tenants` table, and an unqualified query silently mixes the two.
SQL=$(cat <<'EOSQL'
WITH t AS (SELECT * FROM public.tenants WHERE slug = :'slug')
SELECT json_build_object(
  'exportedAt', now(),
  'source', 'kinevents',
  'tenant', (SELECT row_to_json(x) FROM (
      SELECT name, time_zone, weeks_to_show, first_day_of_week, theme, zip,
             latitude, longitude, weather_units, holidays, is_public,
             share_token, share_keywords
      FROM t) x),
  'members', COALESCE((SELECT json_agg(row_to_json(m)) FROM (
      SELECT id, display_name, color, emoji, member_type, created_at
      FROM public.tenant_members WHERE tenant_id = (SELECT id FROM t)
        AND display_name IS NOT NULL) m), '[]'::json),
  'events', COALESCE((SELECT json_agg(row_to_json(e)) FROM (
      SELECT id, title, date, start_time, end_time, all_day, people, location,
             recurring, ends_on, exdates, rrule, share_override, created_at, updated_at
      FROM public.events WHERE tenant_id = (SELECT id FROM t)) e), '[]'::json),
  'feeds', COALESCE((SELECT json_agg(row_to_json(f)) FROM (
      SELECT id, name, url, fixed_person, color, last_synced_at, emoji,
             display_name, category, never_share
      FROM public.feeds WHERE tenant_id = (SELECT id FROM t)) f), '[]'::json),
  'meals', COALESCE((SELECT json_agg(row_to_json(ml)) FROM (
      SELECT id, date, meal_type, title, people, notes, created_at, updated_at
      FROM public.meals WHERE tenant_id = (SELECT id FROM t)) ml), '[]'::json),
  'todos', COALESCE((SELECT json_agg(row_to_json(td)) FROM (
      SELECT id, title, done, people, due_date, recurring, notes,
             created_at, updated_at, completed_at
      FROM public.todos WHERE tenant_id = (SELECT id FROM t)) td), '[]'::json)
);
EOSQL
)

echo "Exporting tenant '${SLUG}' from ${CONTAINER}..." >&2
# SQL goes in on stdin (-f -) rather than via -c: psql only interpolates
# :'variables' when reading from a file or stdin, so -c would send the literal
# text ":'slug'" to the server and fail. Passing the slug as a psql variable
# (rather than pasting it into the SQL) also keeps it correctly quoted.
printf '%s\n' "$SQL" | docker exec -i "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -t -A -v slug="$SLUG" -f - > "$OUT"

if [ ! -s "$OUT" ] || ! grep -q '"tenant"' "$OUT"; then
  echo "Export produced nothing usable — is '${SLUG}' a real tenant slug?" >&2
  rm -f "$OUT"
  exit 1
fi

python3 - "$OUT" <<'EOPY' 2>/dev/null || echo "Wrote $OUT" >&2
import json,sys
d=json.load(open(sys.argv[1]))
print(f"Wrote {sys.argv[1]}: {d['tenant']['name']} — "
      f"{len(d['members'])} members, {len(d['events'])} events, "
      f"{len(d['feeds'])} feeds, {len(d['meals'])} meals, {len(d['todos'])} todos",
      file=sys.stderr)
EOPY

echo "" >&2
echo "Next: copy it next to your Kinboard data and run" >&2
echo "  node scripts/import-kinevents.js --file $OUT --dry-run" >&2
