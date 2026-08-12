# Kinboard

A private family calendar — shared events, a meal planner, a chore/to-do list, live iCal
feed subscriptions, and view-only share links — in a single Docker container with a SQLite
database. No account system, no cloud dependency, no subscription: one shared household
password, your data stays on your own disk.

## Quick start

Save [`docker-compose.yml`](docker-compose.yml) somewhere and run:

```sh
docker compose up -d
```

That's the whole install — no source checkout, no `.env`, no build step. Or without
compose:

```sh
docker run -d --name kinboard -p 3200:3200 \
  -v kinboard-data:/app/data --restart unless-stopped \
  raymondoooo/kinboard:latest
```

The compose file tracks `latest` and re-checks the registry each time you bring it
up, so `docker compose up -d` keeps you current. Prefer to stay put? Pin the image
(`raymondoooo/kinboard:0.2.4`) and remove `pull_policy: always`. Settings shows the
version you're actually running, either way.

Also on GHCR as `ghcr.io/raymondoooo/kinboard`. To build from a checkout instead, see
[`docker-compose.dev.yml`](docker-compose.dev.yml).

Open `http://localhost:3200` (or whatever host you're running this on) and follow the
one-time setup screen: pick a calendar name and time zone, and choose the household
password everyone in your family will use to sign in. There are no individual accounts —
anyone who knows the password can view and edit.

## Data & backups

Everything lives under `./data`, which is bind-mounted into the container:

- `kinboard.db` (+ its `-wal`/`-shm` sidecar files) — the whole database
- `backups/` — a timestamped SQLite snapshot taken automatically every night, pruned to the
  last 14

**To back up:** copy the `./data` folder (or just `./data/backups/`) somewhere else. **To move
to a new host:** copy `./data` over and run `docker compose up` there — nothing else to
migrate.

## Configuration

All settings are in `.env` (copy `.env.example` to start). Kinboard runs with none of these
set — they're for hardening and integration.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3200` | The port Kinboard listens on, inside and out. Change the host side of the compose mapping instead if 3200 is taken. |
| `TRUST_PROXY` | *(off)* | **Set this if Kinboard sits behind a reverse proxy.** See below. |
| `SECURE_COOKIES` | *(off)* | Set to `true` if you serve over HTTPS, to mark the session cookie HTTPS-only. Leave off for plain-HTTP LAN use, or you won't be able to log in. |
| `DIGEST_HOUR` | `7` | Hour (0–23, your household's timezone) to send the daily digest. |
| `WEBHOOK_URL` / `WEBHOOK_TYPE` | *(off)* | ntfy / Discord / Slack / JSON notification fallback — see [Notifications](#notifications). |
| `FEED_MAX_MB` | `10` | Largest calendar Kinboard will download from a subscribed feed. Raise it only if you have a genuinely enormous calendar. |
| `DATA_DIR` | `./data` | Where the SQLite database, its WAL sidecars and backups live. The image mounts this as a volume. |
| `DONATE_URL` | the project's Ko-fi | Where the "Support Kinboard" button points. Set it to an empty value to hide the button. |

Everything else (calendar name, time zone, theme, weather ZIP, holidays, family members,
calendar feeds, sharing) is configured from the Settings page inside the app after setup.

### Running behind a reverse proxy

If anything sits in front of Kinboard (Caddy, nginx, Nginx Proxy Manager, Traefik, a
Cloudflare Tunnel), set `TRUST_PROXY` so it can see the real client address:

```
TRUST_PROXY=1          # one proxy hop — the right answer for almost everyone
TRUST_PROXY=true       # trust the whole X-Forwarded-For chain (only if you control it)
TRUST_PROXY=10.0.0.0/8 # trust specific proxy addresses
```

This matters for the login rate limiter. It's **off by default on purpose**: if Kinboard
believed `X-Forwarded-For` without a proxy actually being there, anyone could forge that
header and get unlimited guesses at your household password. The cost of leaving it off
behind a proxy is milder — every request looks like it came from the proxy, so the limiter
becomes household-wide and repeated typos can lock everyone out for a few minutes.

Also set `SECURE_COOKIES=true` once you're on HTTPS.

### Forgotten the household password?

There's no email recovery — Kinboard has no mail server and no accounts. Since you own the
database, reset it directly:

```sh
docker exec kinboard-kinboard-1 node -e "
const bcrypt=require('bcryptjs');
const db=require('/app/server/db.js');
db.raw.prepare('UPDATE household SET password_hash=? WHERE id=1').run(bcrypt.hashSync('your-new-password',10));
console.log('password updated');
"
```

Everyone stays signed in on devices that already have a session; only new sign-ins need the
new password.

## Notifications

Three kinds, all off until someone turns them on:

- **Daily digest** — a morning summary of the day's schedule
- **Event reminders** — a heads-up before an event starts (per-device lead time)
- **New events** — an immediate ping when someone adds an event for you

There are two delivery methods, and you can use either or both.

**Push notifications (recommended).** Real notifications on your phone or desktop, no app to
install — open Settings → Notifications and turn them on per device. Each device gets its own
name, its own reminder lead time, and picks *whose* events it wants to hear about, so Dad's
phone doesn't buzz for every one of the kids' practices. No configuration or API keys are
needed; Kinboard generates its own keys on first use.

> **Push requires HTTPS.** Browsers refuse Web Push on plain HTTP, so this only works if
> you've put Kinboard behind a reverse proxy with TLS (Caddy, nginx, Cloudflare Tunnel,
> Tailscale…). If you're on a bare LAN address, the Notifications card will tell you so and
> point you at the webhook option below. On **iPhone/iPad you must "Add to Home Screen"
> first** and open Kinboard from that icon — iOS only allows push for installed web apps.

**Webhook (works over plain HTTP).** Set `WEBHOOK_URL` and `WEBHOOK_TYPE` in `.env` to send
the same notifications to [ntfy](https://ntfy.sh), Discord, Slack, Home Assistant, or any
JSON endpoint. This is per-household rather than per-person, but it needs no HTTPS and no
browser permissions — the simplest option if you just want your phone to buzz. ntfy in
particular has free iOS and Android apps, so you get real phone notifications without TLS.

## What's different from a multi-tenant SaaS

This is single-household and single-container by design: no sign-up flow, no billing, no
per-person email accounts or invites, no multi-tenant routing. That's the whole point — it's
yours to run, and your family's schedule never leaves your machine.

## Features

- Month grid / agenda views, recurring events (including custom RRULE import), drag-free
  quick add
- Meal planner, and a combined chore/to-do list with repeats, a per-device
  "show me mine" filter, and **chore earnings** — give a chore a value and
  Kinboard tracks what each person is owed, including every time a repeating
  chore comes round
- Live iCal feed subscriptions (school, sports, work) with automatic person/color detection
  from event titles
- One-time calendar import (migrate off a live feed into native, editable events)
- View-only share link + a `.ics` subscription URL, with keyword-based auto-sharing so only
  what you choose leaves the household
- Optional public (no-password) read-only calendar
- Push notifications (per-device, no app install) plus an ntfy/Discord/Slack webhook fallback
- Weather (ZIP-based, via the free Open-Meteo + Zippopotam.us APIs — no API key)
- Seven themes, PWA-installable, mobile-friendly agenda view

## Support

Kinboard is free and always will be. If it's useful to your family and you'd like to chip in,
there's a Ko-fi: **https://ko-fi.com/raymondoooo**

Bug reports and pull requests are welcome.

## License

[AGPL-3.0-or-later](LICENSE). You can run, modify, and share it freely. If you run a modified
version as a network service, the AGPL requires you to make your changes available to its
users too.
