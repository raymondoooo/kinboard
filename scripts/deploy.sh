#!/usr/bin/env bash
# Rebuild and restart a Kinboard you build from this checkout (a
# docker-compose.override.yml with `build: .`), but only from code that's been
# released: a clean `main` that matches origin/main.
#
# Why: it's easy to run `docker compose up -d --build` while a feature branch is
# checked out. The household then runs unmerged code, Settings shows whatever
# version that branch's package.json says, and a schema migration from the
# branch can make the next real release refuse to start.
#
#   scripts/deploy.sh             deploy main (refuses anything else)
#   scripts/deploy.sh --branch    deploy the current branch anyway, on purpose
#
# Set KINBOARD_CONTAINER if your container isn't called "kinboard".
set -euo pipefail

cd "$(dirname "$0")/.."
CONTAINER="${KINBOARD_CONTAINER:-kinboard}"
ALLOW_BRANCH=0
[ "${1:-}" = "--branch" ] && ALLOW_BRANCH=1

die() { echo "deploy: $*" >&2; exit 1; }

[ -f docker-compose.override.yml ] || die "no docker-compose.override.yml — this script is for instances built from this checkout"

branch=$(git rev-parse --abbrev-ref HEAD)
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes — commit or stash them first"

if [ "$ALLOW_BRANCH" = 0 ]; then
  [ "$branch" = "main" ] || die "on '$branch', not main. Check out main, or pass --branch to deploy it deliberately."
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || die "main isn't the same as origin/main — run 'git pull --ff-only' (or push) first"
else
  echo "deploy: deploying branch '$branch' on purpose (--branch)"
fi

want=$(node -p "require('./package.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
echo "deploy: building $want from $branch @ $(git rev-parse --short HEAD)"
docker compose up -d --build

for i in $(seq 1 60); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$status" in
    healthy|running) break ;;
    unhealthy|exited|dead|missing) docker logs --tail 40 "$CONTAINER" >&2 || true; die "container is $status" ;;
  esac
  sleep 2
done
[ "$status" = healthy ] || [ "$status" = running ] || die "container still '$status' after 2 minutes"

got=$(docker exec "$CONTAINER" node -p "require('/app/package.json').version")
[ "$got" = "$want" ] || die "container reports $got, expected $want"
echo "deploy: $CONTAINER is $status, running $got"
docker logs --since 2m "$CONTAINER" 2>&1 | grep -E '^\[db\]' || true
