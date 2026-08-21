# ── Build stage ─────────────────────────────────────────────────────────────
# better-sqlite3 has a native binding that must be compiled when no prebuilt
# binary matches the platform (notably on arm64). The toolchain that does that
# is ~160MB of gcc and python3 — it belongs here and nowhere near the image
# users actually run.
FROM node:26-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Lockfile-driven install: `npm ci` installs exactly what package-lock.json
# pins, so an image built today matches one built next year.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:26-alpine

# su-exec only — it lets the entrypoint fix volume ownership as root and then
# drop to an unprivileged user. The compiler stays behind in the build stage.
RUN apk add --no-cache su-exec

# npm is a build-time tool and nothing in this runtime invokes it (the
# entrypoint execs `node server/index.js` directly). It is not free to keep,
# though — it vendors its own dependency tree, and a vulnerability scan
# reports those CVEs against this image for as long as it sits here,
# unfixable until upstream Node bundles a newer npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Stamped by CI from the git tag. Without it — a plain `docker build` — the app
# falls back to package.json and marks itself as a dev build, so a hand-built
# image is never mistaken for a release.
ARG KINBOARD_VERSION=""
ENV KINBOARD_VERSION=${KINBOARD_VERSION}

# The compiled native binding lives inside node_modules, so copying the tree
# across is all that's needed — no rebuild, no toolchain.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY schema.sql ./schema.sql
# Migration/maintenance tooling ships with the image so it can be run with
# `docker exec kinboard node scripts/...` — someone moving their data in
# shouldn't have to clone the repo to do it.
COPY scripts ./scripts
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# The SQLite file, its WAL sidecars, and nightly backups all live here — the
# only path that needs a volume. Ownership is fixed at container start (see
# docker-entrypoint.sh), not at build time: a host bind mount that doesn't
# exist yet is created root-owned by Docker itself, which would otherwise
# shadow whatever this image's own copy of the directory was chown'd to.
VOLUME /app/data

EXPOSE 3200

# Reports unhealthy if the process is up but can't answer — e.g. the database
# file became unreadable. Uses Node's built-in fetch so the image needs no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Static fallbacks; CI overrides these with richer values from
# docker/metadata-action (revision, created, version).
LABEL org.opencontainers.image.title="Kinboard" \
      org.opencontainers.image.description="Self-hosted family calendar — events, meals, chores, iCal feeds, push notifications" \
      org.opencontainers.image.source="https://github.com/raymondoooo/kinboard" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENTRYPOINT ["/docker-entrypoint.sh"]
