# Security policy

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue.

Use GitHub's private vulnerability reporting:
**https://github.com/raymondoooo/kinboard/security/advisories/new**

That creates a private thread visible only to the maintainer. Please include what
you found, how to reproduce it, and what an attacker could achieve.

This is a hobby project maintained by one person, so I can't promise a response
time — but I'd rather hear about a problem late than read about it in someone
else's bug tracker. Please give me a reasonable window to ship a fix before
disclosing publicly.

## Supported versions

Only the latest release gets fixes. There are no long-term support branches.

## What Kinboard assumes about your setup

Kinboard is designed to run on a machine **you** control, and it makes a few
assumptions worth being explicit about:

- **One shared household password protects everything.** There are no individual
  accounts and no roles — anyone who knows it can read and edit the whole
  calendar. Treat it like a door key, not a web login.
- **It is not hardened for the open internet.** Exposing it publicly is your
  call; if you do, put it behind HTTPS, set `TRUST_PROXY` so the login rate
  limiter can see real client addresses, and set `SECURE_COOKIES=true`.
- **Share links are unguessable but unauthenticated.** Anyone holding a share URL
  can read what the keyword rules expose, with no password. Revoke from Settings
  if a link gets out.
- **Your data is a plain SQLite file** in the data volume, unencrypted. Disk
  encryption and backup security are yours to arrange.

## Things that are not vulnerabilities

- Being able to log in from anywhere with the correct household password
- A valid share link showing the events it was configured to show
- Missing rate limits on authenticated endpoints (you're already inside the trust
  boundary at that point)
