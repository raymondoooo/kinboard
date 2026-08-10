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
exec su-exec node node server/index.js
