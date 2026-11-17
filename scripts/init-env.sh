#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Create .env from .env.example with freshly generated secrets.
# Safe to re-run: an existing .env is never overwritten.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists, leaving it untouched."
  exit 0
fi

# 48 hex characters of randomness. Hex only, so the value is safe inside a connection URL.
rand() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

umask 077
mongo_password="$(rand)"
redis_password="$(rand)"
grafana_password="$(rand)"
hash_salt="$(rand)"

sed \
  -e "s|^MONGO_PASSWORD=.*|MONGO_PASSWORD=${mongo_password}|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${redis_password}|" \
  -e "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=${grafana_password}|" \
  -e "s|^HASH_SALT=.*|HASH_SALT=${hash_salt}|" \
  .env.example > .env

echo "Created .env with generated secrets (file mode 600)."
echo "Grafana login:  admin / ${grafana_password}"
echo "Next:           docker compose up -d --build   (or: make up)"
