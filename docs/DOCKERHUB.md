# Kinboard

A private family calendar you host yourself — shared events, a meal planner, a chore list with
allowance tracking, live iCal feed subscriptions, view-only share links, and push notifications.
One container, one SQLite file, no accounts, no cloud, no subscription.

Everyone in the house shares a single password. Your family's schedule never leaves your machine.

**Source:** https://github.com/raymondoooo/kinboard · **License:** AGPL-3.0-or-later

**Architectures:** `linux/amd64`, `linux/arm64` (Raspberry Pi works)

![The month view](https://raw.githubusercontent.com/raymondoooo/kinboard/main/docs/screenshots/calendar-month.png)

---

## Quick start

```bash
docker run -d \
  --name kinboard \
  -p 3200:3200 \
  -v kinboard-data:/app/data \
  --restart unless-stopped \
  raymondoooo/kinboard:latest
```

Open `http://your-host:3200` and follow the one-time setup: pick a calendar name, a time zone,
and the household password everyone will use.

### docker-compose.yml

```yaml
services:
  kinboard:
    image: raymondoooo/kinboard:latest
    # Re-checks the registry on every `up -d`, so you stay current.
    pull_policy: always
    restart: unless-stopped
    ports:
      - "3200:3200"
    volumes:
      - ./data:/app/data
    # environment:
    #   TRUST_PROXY: "1"          # if behind a reverse proxy
    #   SECURE_COOKIES: "true"    # if served over HTTPS
```

Bind mounts and named volumes both work — the container fixes ownership on start and runs as a
non-root user.

---

## What you get

| | |
|---|---|
| ![Chores](https://raw.githubusercontent.com/raymondoooo/kinboard/main/docs/screenshots/chores-earnings.png) | ![Meals](https://raw.githubusercontent.com/raymondoooo/kinboard/main/docs/screenshots/meal-planner.png) |
| *Chores, with what each kid has earned* | *The week's meals* |
| ![Phone](https://raw.githubusercontent.com/raymondoooo/kinboard/main/docs/screenshots/mobile-agenda.png) | ![Settings](https://raw.githubusercontent.com/raymondoooo/kinboard/main/docs/screenshots/settings.png) |
| *Agenda view on a phone* | *Settings, including seven themes* |

- Month grid / agenda views, recurring events (including custom RRULE import)
- Meal planner, and a combined chore/to-do list with repeats, a per-device "show me mine"
  filter, a Skip button for a chore the kids missed, and **chore earnings** — give a chore a
  value and Kinboard tracks what each person is owed
- Live iCal feed subscriptions (school, sports, work) with automatic person/color detection
- View-only share link + an `.ics` subscription URL, with keyword-based auto-sharing
- Optional public (no-password) read-only calendar
- Push notifications (per-device, no app install) plus an ntfy/Discord/Slack webhook fallback
- Weather (ZIP-based, via the free Open-Meteo + Zippopotam.us APIs — no API key)
- Seven themes, PWA-installable, mobile-friendly agenda view

---

## Data

Everything lives in `/app/data`:

- `kinboard.db` (+ its `-wal`/`-shm` sidecars) — the whole database
- `backups/` — an automatic nightly snapshot, pruned to the last 14

Back up that one directory and you've backed up everything. Moving to a new host is copying it.

---

## Configuration

Kinboard runs with none of these set — they're for hardening and integration.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3200` | The port Kinboard listens on, inside and out. |
| `TRUST_PROXY` | *(off)* | **Set this if Kinboard sits behind a reverse proxy**, so the login rate limiter sees real client addresses. `1` is right for almost everyone. |
| `SECURE_COOKIES` | *(off)* | Set to `true` if you serve over HTTPS. Leave off for plain-HTTP LAN use, or you won't be able to log in. |
| `DIGEST_HOUR` | `7` | Hour (0–23, household timezone) to send the daily digest. |
| `WEBHOOK_URL` / `WEBHOOK_TYPE` | *(off)* | ntfy / Discord / Slack / JSON notification fallback. |
| `FEED_MAX_MB` | `10` | Largest calendar Kinboard will download from a subscribed feed. |
| `DATA_DIR` | `/app/data` | Where the database, WAL sidecars and backups live. |
| `DONATE_URL` | the project's Ko-fi | Where the "Support Kinboard" button points. Set empty to hide it. |

Everything else (calendar name, time zone, theme, weather ZIP, holidays, family members,
feeds, sharing) is configured in the app after setup.

> **Push notifications require HTTPS.** Browsers refuse Web Push on plain HTTP, so it only
> works behind a TLS reverse proxy. On a bare LAN address the app says so and points you at
> the webhook option instead. On iPhone/iPad you must "Add to Home Screen" first.

---

## Tags

`latest` tracks the newest release. Every release also publishes `X.Y.Z`, `X.Y` and `X`, so you
can pin as tightly or as loosely as you like. Settings shows the version you're actually running.

Also on GHCR as `ghcr.io/raymondoooo/kinboard` — Docker Hub rate-limits anonymous pulls, which
matters if you redeploy often.

---

## Support

Kinboard is free and always will be. If it's useful to your family and you'd like to chip in,
there's a Ko-fi: **https://ko-fi.com/raymondoooo**

Bug reports and pull requests welcome at
[github.com/raymondoooo/kinboard](https://github.com/raymondoooo/kinboard).
