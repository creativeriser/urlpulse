#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restore a backup made by backup-mongo.sh. DESTRUCTIVE: existing collections in the
# urlpulse database are dropped and replaced.
#
#   ./scripts/restore-mongo.sh backups/urlpulse-20260101T020000Z.archive.gz --yes
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:?Usage: restore-mongo.sh <archive.gz> --yes}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
if [ "${2:-}" != "--yes" ]; then
  echo "This replaces the current urlpulse database with the contents of $file." >&2
  echo "Re-run with --yes to confirm." >&2
  exit 1
fi

docker compose exec -T mongo sh -c \
  'mongorestore --quiet --drop --archive --gzip --nsInclude="urlpulse.*" --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin"' \
  < "$file"

echo "Restore complete. Redis may still hold cached redirects for deleted links; they expire on their own,"
echo "or flush now with: docker compose exec redis sh -c 'redis-cli -a \"\$REDIS_PASSWORD\" --no-auth-warning flushall'"
