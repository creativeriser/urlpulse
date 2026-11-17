#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deploy a published image on the production host, with automatic rollback.
#
#   IMAGE_TAG=sha-abc1234 ./scripts/deploy.sh
#
# What it does
#   1. records the tag that is running now
#   2. writes the new tag into .env and pulls the new app image
#   3. recreates only the containers that changed
#   4. waits for the app container to report healthy
#   5. if it never does, puts the previous tag back and recreates the app
#
# Downtime: Compose replaces the single app container, so there is a gap of a few
# seconds. nginx answers 502 during it. For true zero-downtime use the Kubernetes
# manifests (rolling update behind readiness probes). See DOCUMENTATION.md.
#
# Everything lives inside main() so that a `git pull` that rewrites this file while
# it runs cannot confuse bash, which reads scripts incrementally.
# ---------------------------------------------------------------------------
set -euo pipefail

compose() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

set_tag() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Refusing unsafe image tag: $1" >&2; return 1; }
  if grep -q '^IMAGE_TAG=' .env; then
    sed -i.bak "s|^IMAGE_TAG=.*|IMAGE_TAG=$1|" .env && rm -f .env.bak
  else
    echo "IMAGE_TAG=$1" >> .env
  fi
}

wait_healthy() {
  local timeout="${DEPLOY_HEALTH_TIMEOUT:-120}" waited=0 cid status
  while [ "$waited" -lt "$timeout" ]; do
    cid="$(compose ps -q app || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo missing)"
      [ "$status" = "healthy" ] && return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

main() {
  cd "$(dirname "$0")/.."
  local new_tag="${IMAGE_TAG:?IMAGE_TAG is required, e.g. IMAGE_TAG=sha-abc1234}"
  # Compose gives the process environment priority over .env. Drop it, so that a
  # rollback (which edits .env) is not silently overridden by the new tag.
  unset IMAGE_TAG

  [ -f .env ] || { echo ".env is missing. Run scripts/init-env.sh first." >&2; exit 1; }

  local previous_tag
  previous_tag="$(grep -E '^IMAGE_TAG=' .env | tail -n1 | cut -d= -f2- || true)"
  echo "Deploying ${new_tag} (currently: ${previous_tag:-nothing})"

  set_tag "$new_tag"
  compose pull app
  compose up -d --remove-orphans

  if wait_healthy; then
    echo "Deploy succeeded: ${new_tag} is healthy."
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi

  echo "App did not become healthy. Recent logs:" >&2
  compose logs --tail=40 app >&2 || true

  if [ -n "$previous_tag" ] && [ "$previous_tag" != "$new_tag" ]; then
    echo "Rolling back to ${previous_tag}" >&2
    set_tag "$previous_tag"
    compose up -d app
    if wait_healthy; then
      echo "Rollback succeeded: ${previous_tag} is healthy again." >&2
    else
      echo "Rollback target is not healthy either. Manual intervention needed." >&2
    fi
  else
    echo "No previous tag to roll back to." >&2
  fi
  exit 1
}

main "$@"
exit 0
