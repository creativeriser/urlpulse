#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Dump the URLPulse database to a compressed archive and prune old ones.
#
#   ./scripts/backup-mongo.sh
#   COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml ./scripts/backup-mongo.sh   # on the server
#
# Environment: BACKUP_DIR (default ./backups), BACKUP_KEEP (default 14 archives)
# Schedule it from cron:   17 2 * * *  cd /opt/urlpulse && ./scripts/backup-mongo.sh >> backup.log 2>&1
# Restore with scripts/restore-mongo.sh. Copy archives off the host: a backup that lives only on
# the machine it protects is not a backup.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

out_dir="${BACKUP_DIR:-backups}"
keep="${BACKUP_KEEP:-14}"
mkdir -p "$out_dir"

file="${out_dir}/urlpulse-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

# Credentials are read inside the container, so they never appear in this host's process list.
docker compose exec -T mongo sh -c \
  'mongodump --quiet --archive --gzip --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/urlpulse?authSource=admin"' \
  > "${file}.partial"

if [ ! -s "${file}.partial" ]; then
  rm -f "${file}.partial"
  echo "Backup produced no data, aborting." >&2
  exit 1
fi
mv "${file}.partial" "$file"
echo "Backup written: ${file} ($(du -h "$file" | cut -f1))"

# Keep the newest $keep archives
# shellcheck disable=SC2012
ls -1t "${out_dir}"/urlpulse-*.archive.gz 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f --
