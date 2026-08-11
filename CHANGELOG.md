# Changelog

Notable changes to Kinboard. Versions follow [SemVer](https://semver.org); `0.x`
means the shape of things can still change between minor releases.

## [Unreleased]

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
