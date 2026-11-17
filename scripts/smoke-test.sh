#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end smoke test against a running URLPulse instance.
#
#   scripts/smoke-test.sh http://127.0.0.1:5000
#   scripts/smoke-test.sh https://pulse.example.com
#
# It exercises the real request path: health, website, create a link, follow the
# redirect, read it back, then delete it again (so a production run leaves no trace).
#
# Environment:
#   CHECK_METRICS=1       also require GET /metrics (only works against the app, not through nginx)
#   SMOKE_TARGET_URL      URL to shorten            (default https://example.com)
#   SMOKE_WAIT_SECONDS    how long to wait for the instance to become healthy (default 90)
# ---------------------------------------------------------------------------
set -euo pipefail

base="${1:?Usage: smoke-test.sh <base-url>}"
base="${base%/}"
target="${SMOKE_TARGET_URL:-https://example.com}"
wait_seconds="${SMOKE_WAIT_SECONDS:-90}"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }

# curl wrapper: prints "<http_code>" on stdout and the body to $body_file
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
http() { curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 "$@"; }

echo "Smoke test: $base"

# 1. wait for health (tolerates restarts and slow starts)
deadline=$((SECONDS + wait_seconds))
until [ "$(http "$base/health" 2>/dev/null || true)" = "200" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail "/health did not return 200 within ${wait_seconds}s"
  sleep 2
done
pass "/health returns 200 ($(tr -d '\n' < "$body_file" | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p'))"

[ "$(http "$base/livez")" = "200" ] && pass "/livez returns 200" || fail "/livez"

# 2. website
[ "$(http "$base/")" = "200" ] && grep -q "URLPulse" "$body_file" && pass "home page renders" || fail "home page"
[ "$(http "$base/status")" = "200" ] && pass "status page renders" || fail "/status"
[ "$(http "$base/assets/css/tokens.css")" = "200" ] && pass "static assets are served" || fail "static assets"
[ "$(http "$base/definitely-not-a-real-page-404")" = "404" ] && pass "unknown route returns 404" || fail "404 handling"

# 3. API: create
code="$(http -X POST "$base/api/url/shorten" -H 'Content-Type: application/json' \
  -d "{\"originalUrl\":\"$target\"}")"
[ "$code" = "201" ] || fail "create link returned $code: $(cat "$body_file")"
short_code="$(sed -n 's/.*"shortCode":"\([^"]*\)".*/\1/p' "$body_file" | head -n1)"
token="$(sed -n 's/.*"manageToken":"\([^"]*\)".*/\1/p' "$body_file" | head -n1)"
[ -n "$short_code" ] && [ -n "$token" ] || fail "create response is missing shortCode or manageToken"
pass "link created ($short_code)"

# 4. redirect (do not follow: we want to see the 302 itself)
headers="$(curl -sS -o /dev/null -D - --max-time 15 "$base/$short_code")"
echo "$headers" | head -n1 | grep -q " 302" || fail "redirect is not a 302: $(echo "$headers" | head -n1)"
echo "$headers" | tr -d '\r' | grep -qi "^location: ${target%/}/\?$" || fail "redirect Location header does not match the target"
pass "short link redirects (302) to the target"

# 5. read back + stats
[ "$(http "$base/api/url/$short_code")" = "200" ] && grep -q "\"shortCode\":\"$short_code\"" "$body_file" \
  && pass "link can be read back" || fail "read link"
[ "$(http "$base/api/stats")" = "200" ] && pass "/api/stats returns 200" || fail "/api/stats"

# 6. authorisation: deleting without the token must be refused, with it must work
code="$(http -X DELETE "$base/api/url/$short_code")"
case "$code" in 401|403) pass "delete without token is refused ($code)";; *) fail "delete without token returned $code";; esac
code="$(http -X DELETE "$base/api/url/$short_code" -H "X-Manage-Token: $token")"
case "$code" in 200|204) pass "delete with token succeeds ($code)";; *) fail "delete with token returned $code";; esac
[ "$(http "$base/$short_code")" = "404" ] && pass "deleted link is gone (404)" || fail "deleted link still resolves"

# 7. optional: metrics
if [ "${CHECK_METRICS:-0}" = "1" ]; then
  [ "$(http "$base/metrics")" = "200" ] && grep -q "^http_requests_total" "$body_file" \
    && pass "/metrics exposes Prometheus metrics" || fail "/metrics"
fi

echo "All smoke checks passed."
