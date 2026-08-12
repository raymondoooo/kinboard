# Moving a kinevents calendar into Kinboard

Kinboard was forked from kinevents, so the two schemas are still close to 1:1 and
almost everything comes across unchanged. This is the order to do it in, and the
things that genuinely don't transfer.

The migration is deliberately two steps — export to a JSON file, inspect it, then
import — rather than a direct database-to-database copy. A file can be read,
diffed, and kept as a backup; a direct copy can't.

**Nothing in this process writes to kinevents.** The export opens no transaction
and touches only the one tenant you name.

---

## One tenant per Kinboard instance

kinevents is multi-tenant: one deployment serves `smiths`, `testfam`,
`thedechristiefamily` and so on. Kinboard is the opposite by design — one
household per container, no tenant column anywhere.

So **each tenant you want to keep becomes its own Kinboard container**, with its
own data volume, its own household password, and its own port or hostname. Run
the export once per tenant.

---

## 1. Export the tenant

Run on the box hosting kinevents' Postgres:

```bash
./scripts/export-kinevents.sh <tenant-slug> kinevents-<slug>.json
```

It prints a summary — members, events, feeds, meals, to-dos — so you can sanity
check the counts before going further. If the slug is wrong it fails loudly
rather than writing an empty file.

Open the JSON. It's the last chance to see the data in a form you can read.

## 2. Stand up a Kinboard instance and complete setup

```bash
docker run -d --name kinboard-<slug> -p 3200:3000 \
  -v kinboard-<slug>-data:/app/data raymondoooo/kinboard:latest
```

Open it and finish `/setup` — pick the household password there. **The import
refuses to run before setup**, because it writes into a `settings` row that
setup creates.

Don't bother configuring anything else on the Settings page; the import brings
the calendar name, timezone, theme, week layout, weather location and holiday
selections over from the tenant row.

## 3. Dry run

`scripts/` ships inside the image, so this needs no repo checkout:

```bash
docker cp kinevents-<slug>.json kinboard-<slug>:/tmp/import.json
docker exec kinboard-<slug> node scripts/import-kinevents.js \
  --file /tmp/import.json --data-dir /app/data --dry-run
```

It reports exactly what it would write and what it would skip, without touching
the database.

## 4. Import

Same command without `--dry-run`. It runs in a single transaction: either all of
it lands or none of it does.

Every record keeps its original kinevents UUID, so the import is **idempotent** —
re-running it skips what's already there instead of duplicating it. If something
looks wrong, fix it and run again.

No restart is needed. The running server reads the same database file the import
just wrote, so the calendar shows the imported data immediately.

If the instance already has events in it, the import stops and asks for
`--force`. That guard is there because importing on top of real data is rarely
what you meant; re-importing the *same* export is always safe.

## 5. Check it

- Events on the right days, recurring series still repeating, edited/moved
  occurrences still where you moved them
- Each person's colour and emoji intact
- Subscribed calendar feeds listed and syncing
- Meals and to-dos present; repeating chores still repeating
- The share page shows the same events it did before — share keywords and
  per-event *always*/*never* overrides both carry across

The share **token** carries across too, so the path is unchanged even though the
hostname isn't. Anyone you gave the old link to needs the new URL regardless; if
you'd rather the old token stopped working entirely, revoke and regenerate it in
Settings once you've migrated.

Then re-enable notifications on each device (see below), and only after that
shut the tenant down on kinevents.

---

## What doesn't come across

**Push notification subscriptions.** A subscription is bound to the origin that
created it, and the origin is changing. There is no way to move one. Everyone
opens the new Kinboard on their phone and taps *Enable notifications* once.

**Logins.** kinevents gives each family member their own account with an email
invite and a role. Kinboard has a single shared household password and no
per-person accounts — that's the deliberate trade for having no mail server, no
magic links and no user table. Members keep their name, colour, emoji and type;
they just don't sign in separately any more. `invite_email` and `role` are
dropped because there is nothing on the other side to hold them.

**Billing.** Plan, trial, Stripe customer and subscription, and the subdomain
slug are all dropped. They mean nothing when you host it yourself.

Everything else — every column on events, feeds, meals, to-dos, members, and the
tenant's own settings — is carried across. Nothing else is silently lost.

## After the last tenant is out

Cancel any live Stripe subscriptions before shutting the kinevents deployment
down, so nobody is billed for something that no longer exists.
