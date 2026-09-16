#!/bin/sh
# Runs as root (the container's default user) so it can fix ownership of
# whatever got bind-mounted onto /app/data — Docker creates a host bind mount
# owned by root the first time it doesn't already exist on the host, which
# would otherwise shadow the image's own chown and leave the app unable to
# write its SQLite file. Then drops to the unprivileged `node` user to
# actually run the app.
set -e
mkdir -p /app/data
chown -R node:node /app/data

# With no arguments, start the server — the normal case, and what
# `docker run kinboard` / compose does. With arguments, run those instead, still
# as the unprivileged user: `docker run --rm kinboard sh -c 'apk info -v'` or
# `... node scripts/import.js` should do what it says rather than silently
# ignoring the command and booting a second server. This used to exec the server
# unconditionally, so every diagnostic one-liner against the image started the
# app and printed its log instead of an answer.
if [ "$#" -eq 0 ]; then
  set -- node server/index.js
fi

exec su-exec node "$@"
