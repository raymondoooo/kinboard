# Changelog

Notable changes to Kinboard. Versions follow [SemVer](https://semver.org); `0.x`
means the shape of things can still change between minor releases.

## [0.2.3] — 2026-08-12

### Fixed
- **The settings page was broken in 0.2.2.** Seven sections rendered above the
  header, full-width and outside the page container — they had been moved into
  `<head>`. The reorder script that produced 0.2.2 used a multi-line regex to
  pick up each section's leading comment, and it swallowed everything from the
  `<head>` icon comment down to the first section: `</head>`, `<body>`, the
  container and the header all travelled with that section when it moved. The
  page's tags stayed perfectly balanced, so the check in place at the time saw
  nothing wrong. CI now verifies where elements sit, not just that they close.

## [0.2.2] — 2026-08-12

### Changed
- **Settings sections reordered and renamed.** Setup leads and the donation card
  trails, with the calendar-source sections grouped together near the bottom:
  Calendar → **Setup**, Share & subscribe → **Sharing**, Calendars → **Subscribe
  to calendar**, Import a calendar → **Ingest a calendar**. "Sharing" also
  settles a collision the page had, where two adjacent sections both said
  "subscribe" while meaning opposite directions — one pulls a school calendar
  in, the other hands a read-only link out. A first visit opens Setup and leaves
  the rest closed.

## [0.2.1] — 2026-08-12

### Changed
- **BREAKING: Kinboard now listens on port 3200 inside the container, not 3000.**
  The published port and the internal port are the same number, the way
  established self-hosted products do it (Plex 32400, Home Assistant 8123,
  Jellyfin 8096) — so the README, the healthcheck, a reverse-proxy config and
  `docker ps` all say one number instead of two. **If you run
  `-p 3200:3000`, change it to `-p 3200:3200`**, or the container will start
  and nothing will answer. A reverse proxy pointing at the *host* port is
  unaffected; one pointing at `kinboard:3000` on a Docker network needs
  updating to `kinboard:3200`.
- `docker-compose.yml` is now the file to copy to a server: a pinned published
  image, no build step, no `.env` required. Building from a checkout moved to
  `docker-compose.dev.yml`.


### Fixed
- **Upgrading mid-morning sent a second daily digest.** The new
  `last_digest_date` column starts empty, and the catch-up window runs for three
  hours after the digest hour, so an instance restarted at 07:38 decided the day
  had been missed and repeated it. The migration now backfills today's date when
  the digest would already have gone out — and deliberately doesn't when you
  upgrade before the digest hour, so today's still fires.
- **The Home Screen icon was a plain letter tile on iPhone.** iOS uses the icon
  declared by the page you add to the Home Screen, and only the calendar page
  declared one — so installing from Settings, which is exactly where the "add to
  Home Screen first" instruction sends iPhone users, produced a generated "K"
  tile and named the app after that page. Every page now carries the icon set,
  the manifest and an explicit app title.
- **Notification titles were too long to read.** The daily digest led with the
  household name, which the push service already displays, so a lock screen
  showed "Kinboard-DeChristie — today..." and nothing useful. It is now "Today",
  or "Today · 3 events" when there's more than one.
- **Push never worked on iPhones or iPads.** The default VAPID subject was
  `mailto:kinboard@localhost`. Apple validates that claim and rejects it with a
  403; Google and Microsoft accept it, so notifications worked on Android and
  Windows and failed silently on every Apple device — the only symptom being
  "Nothing was sent" in Settings and a bare `403` in the log. The default is now
  an https URL, which every push service accepts. An invalid `VAPID_SUBJECT`
  override is ignored with a warning instead of half-breaking, and a 403 now
  logs which service rejected it and why.
- **Subscribed calendars never triggered notifications.** The calendar page
  merged iCal feed events and so did the share page, but the digest and
  reminders only ever read events typed into Kinboard. Subscribe to a school or
  team calendar — the reason the feed feature exists — and you were reminded
  about none of it, with nothing in the logs to say so. Feed occurrences are
  now merged into both, converted from the UTC instant a feed carries to the
  household-local wall clock the rest of the notification code assumes; without
  that conversion a feed event lands on the wrong day and is silently dropped.
- **Checking a chore off twice paid twice.** Nothing verified the chore was
  actually changing state, so a second tap on an already-done chore wrote a
  second ledger entry — no concurrency needed. Worse, five simultaneous
  check-offs (two phones, or one retrying on a bad connection) wrote five
  entries *and* advanced a weekly chore five weeks, so the child was overpaid
  and the chore then vanished for a month. Completion is now one atomic
  transaction that only records a genuine transition. A real repeat completion
  the following week still pays normally.
- **Reminders could fire twice on the night the clocks go back.** The window
  compared wall-clock minutes, which assumes every hour is 60 minutes long;
  01:30 local happens twice that night, so a reminder due then went out twice —
  an hour apart, the first an hour early. Reminders now compare real instants,
  which makes duplicates impossible by construction. Verified as exactly one
  reminder per day for all 365 days of 2026 across eight timezones, including
  both hemispheres' DST and the 30- and 45-minute offset zones.
- **The daily digest could go out twice, or not at all.** It fired on "local
  hour equals the digest hour" — an hour that occurs twice on the autumn change,
  and not at all if the container happened to be restarting during those five
  minutes. It now records the day it last went out, so it goes exactly once,
  with a bounded catch-up if the machine was down at the time.
- **Timezone offsets are cached.** The offset lookup built a fresh
  `Intl.DateTimeFormat` every call — thousands per tick for a household with
  several devices, forever, often on a Raspberry Pi.
- **Editing something another device just deleted returned 500.** The database
  shim reports "no rows" as an error, and every update handler mapped that to a
  server fault — so a routine race on a shared family calendar (delete on the
  phone, edit on the tablet) looked like the app had broken. Those now answer
  404 with a clear message; genuine database failures still answer 500.
- **Malformed request bodies were logged as server errors.** Anything scanning
  the box filled the log with `[error]` lines and stack traces, which is how a
  real fault goes unnoticed. Client mistakes now get one quiet line.
- **One field on the public share page was interpolated into HTML unescaped.**
  Not reachable today, but that page is unauthenticated and renders event
  titles that can come straight from a third-party calendar feed, so it should
  not have been one new write path away from an injection. Every interpolation
  on every page is now escaped, and CI fails if that stops being true.
- **One malformed event in a subscribed calendar killed the whole calendar.**
  A feed containing an unparseable date (a real school-district feed emitted
  `DTSTART:TBD`) threw during expansion, and because that happens inside an
  async handler the request never got a response at all — the page just spun,
  on every load, permanently, until the feed was removed. The Docker
  healthcheck reported `healthy` the entire time. Feeds are now isolated from
  each other and from your own events: a bad event is skipped and the rest of
  that feed still shows.
- **A high-frequency repeat rule could pin the CPU indefinitely.**
  `FREQ=MINUTELY` expands to ~570,000 occurrences across the display window,
  and every browser refresh started another expansion. Expansion is now capped
  per event.
- **Importing a calendar could permanently break the instance.** The import
  path wrote whatever repeat rule the calendar carried straight into the
  database, bypassing the validation applied to rules you type. Such a row hung
  every page load with no feed left to unsubscribe from. Imported rules are now
  held to the same standard, and an already-affected instance recovers by
  upgrading.
- **Calendar downloads are now bounded.** No size limit and no working timeout
  meant a large or slow URL could tie up memory and a request indefinitely.
  Capped at 10MB (`FEED_MAX_MB`), with a real abort.
- **Feed URLs can no longer reach cloud instance metadata**
  (`169.254.169.254`), which hands out host credentials to anything that can
  make an HTTP request. Private LAN addresses are still allowed — subscribing
  to your own Nextcloud is the point of self-hosting.
- **Changing the household password now signs out other devices.** Only the
  password hash was being replaced, so existing session cookies kept working —
  including the one belonging to whoever you changed the password because of.
  Settings claimed otherwise.
- **A malformed date could crash the container and keep it crashing.** An event
  posted with an invalid date was stored, then threw while being formatted for
  display, taking the process down — and the stored row crashed it again on
  every subsequent load. Dates are validated on write and tolerated on read,
  and the process no longer exits on an unhandled rejection.
- `/api/setup` is rate limited, and an instance left un-set-up now says so
  loudly at boot: until you complete setup, whoever reaches the port first can
  claim it.

## [0.2.0]

### Added
- **Chore earnings.** Chores can carry a point value, with a money rate set in
  Settings. The family only ever sees money — points are the parent's dial for
  setting what a chore is worth relative to the others.
- **Earnings ledger.** Every completion is recorded, so repeating chores
  accumulate properly. Values and titles are snapshotted at completion time, so
  re-pricing or deleting a chore can't rewrite what someone already earned.
  Settling up marks entries paid rather than deleting them.
- **"Show me mine".** A per-device filter for whose chores to display, plus an
  All / Chores / To-dos segmented filter. Both remembered per device, so a
  kid's phone and the kitchen tablet can show different things.
- **`/api/health`** endpoint and a Docker `HEALTHCHECK` that verifies the
  database is readable, not just that the port is open.
- Images now publish to **GHCR** as well as Docker Hub, with the full tag ladder
  (`:0.2.0`, `:0.2`, `:0`, `:latest`).
- `SECURITY.md`, Dependabot, and a `CHANGELOG`.

### Changed
- **Image is 63% smaller** — 736MB to 274MB. The C toolchain needed to compile
  the SQLite binding now stays in a build stage instead of shipping to every
  user.
- Schema changes are versioned (`PRAGMA user_version`) with forward-only
  migrations and an automatic backup before any upgrade.

### Fixed
- **Login rate limiting could be bypassed.** `trust proxy` was hardcoded on, so
  a forged `X-Forwarded-For` header defeated the per-IP limit entirely —
  unlimited guesses at the household password. It is now off by default and
  enabled explicitly with `TRUST_PROXY`. If you run Kinboard behind a reverse
  proxy, **set `TRUST_PROXY=1`**.
- **The sign-in form did nothing.** Its handler was attached after an early
  return that fires when nobody is logged in, so the button fell through to a
  plain form submit and reloaded straight back to the password prompt.
- **Enabling notifications hung silently** on the settings page, which relied on
  the calendar page having registered a service worker. It now registers its own.
- Notification titles containing non-ASCII characters (an em dash, an emoji, an
  accented name) crashed the ntfy webhook, since HTTP headers can't carry them.
- `SECURE_COOKIES` is an explicit opt-in rather than being inferred, so
  plain-HTTP LAN users can still sign in.

### Upgrading
Nothing to do — the schema upgrades itself on first start and takes a backup
into `data/backups/` beforehand. Rolling *back* to 0.1.0 after upgrading will
refuse to start (by design, to avoid corrupting the newer database); restore that
backup if you need to.

## [0.1.0]

First public release. Calendar with recurring events, meal planner, chore list,
live iCal feed subscriptions, one-time calendar import, view-only share links
with a `.ics` feed, optional public read-only mode, Web Push notifications with
an ntfy/Discord/Slack webhook fallback, weather, and seven themes.

[Unreleased]: https://github.com/raymondoooo/kinboard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/raymondoooo/kinboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/raymondoooo/kinboard/releases/tag/v0.1.0
