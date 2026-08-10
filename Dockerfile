FROM node:22-alpine

# python3/make/g++ are needed to build better-sqlite3's native binding when no
# prebuilt binary matches this platform. su-exec lets the entrypoint drop from
# root to the unprivileged `node` user after fixing up volume ownership.
RUN apk add --no-cache python3 make g++ su-exec

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY schema.sql ./schema.sql
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# The SQLite file, its WAL sidecars, and nightly backups all live here — the
# only path that needs a volume. Ownership is fixed up at container start
# (see docker-entrypoint.sh), not here at build time: a host bind mount that
# doesn't exist yet gets created root-owned by Docker itself, which would
# otherwise shadow whatever this image's own copy of the directory was
# chown'd to.
VOLUME /app/data

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
