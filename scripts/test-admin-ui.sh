#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"
PUBLIC_URL="${PUBLIC_URL:-https://voice.raumdock.org/relay-bots/}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${SERVICE:-voice-relay-bots}"

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  exit 1
}

info() {
  printf 'INFO %s\n' "$1"
}

curl_auth_args() {
  if [ -n "$ADMIN_PASSWORD" ]; then
    printf '%s' "-u ${ADMIN_USER}:${ADMIN_PASSWORD}"
  fi
}

request() {
  url="$1"
  method="${2:-GET}"
  auth_args="$(curl_auth_args)"
  # shellcheck disable=SC2086
  curl -fsS -o /tmp/voice-relay-admin-test.body -w '%{http_code}' -X "$method" $auth_args "$url"
}

info "checking docker compose service '$SERVICE'"
docker compose -f "$COMPOSE_FILE" ps "$SERVICE" >/tmp/voice-relay-admin-test.ps 2>&1 || {
  cat /tmp/voice-relay-admin-test.ps
  fail "docker compose service is not available"
}
cat /tmp/voice-relay-admin-test.ps
pass "docker compose service exists"

info "checking admin listener log"
if docker compose -f "$COMPOSE_FILE" logs --tail=200 "$SERVICE" | grep -q '\[Admin\] listening'; then
  pass "admin server emitted listening log"
else
  docker compose -f "$COMPOSE_FILE" logs --tail=80 "$SERVICE"
  fail "admin server listening log not found"
fi

info "checking local admin UI at $BASE_URL"
local_code="$(request "$BASE_URL/" GET || true)"
if [ "$local_code" = "200" ]; then
  pass "local admin HTML reachable"
elif [ "$local_code" = "401" ] && [ -z "$ADMIN_PASSWORD" ]; then
  fail "local admin requires auth; rerun with ADMIN_PASSWORD set"
else
  cat /tmp/voice-relay-admin-test.body 2>/dev/null || true
  fail "local admin HTML returned HTTP $local_code"
fi

info "checking local config API"
api_code="$(request "$BASE_URL/api/config" GET || true)"
if [ "$api_code" = "200" ]; then
  pass "local config API reachable"
else
  cat /tmp/voice-relay-admin-test.body 2>/dev/null || true
  fail "local config API returned HTTP $api_code"
fi

if command -v jq >/dev/null 2>&1; then
  if jq -e '.config.discord.guildId and .config.livekit.url' /tmp/voice-relay-admin-test.body >/dev/null; then
    pass "config API response shape is valid"
  else
    cat /tmp/voice-relay-admin-test.body
    fail "config API response does not contain expected fields"
  fi
else
  info "jq not installed; skipping JSON shape check"
fi

info "checking public Caddy path at $PUBLIC_URL"
public_code="$(request "$PUBLIC_URL" GET || true)"
if [ "$public_code" = "200" ]; then
  pass "public Caddy path reachable"
elif [ "$public_code" = "401" ] && [ -z "$ADMIN_PASSWORD" ]; then
  fail "public Caddy path requires auth; rerun with ADMIN_PASSWORD set"
else
  cat /tmp/voice-relay-admin-test.body 2>/dev/null || true
  fail "public Caddy path returned HTTP $public_code"
fi

pass "admin UI checks completed"
