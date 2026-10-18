#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
project="mcp-live-$(basename "$work" | tr '[:upper:].' '[:lower:]-')"
compose=(docker compose -p "$project" -f test/live/compose.yaml)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up -d --wait db redis
"${compose[@]}" run --rm -T backend bash -euc '
  ls -1 apps > sites/apps.txt
  bench set-config -g db_host db
  bench set-config -g redis_cache redis://redis:6379
  bench set-config -g redis_queue redis://redis:6379
  bench set-config -g redis_socketio redis://redis:6379
  bench new-site mcp.localhost --mariadb-user-host-login-scope="%" --admin-password=ci-only --db-root-password=ci-only --install-app erpnext --set-default
  bench --site mcp.localhost execute frappe.live_mcp_seed.run
'
# Copy generated API credentials to a private temporary file.
"${compose[@]}" run --rm -T --entrypoint cat backend /home/frappe/frappe-bench/sites/live-fixtures.json > "$work/fixtures.json"
chmod 600 "$work/fixtures.json"
"${compose[@]}" up -d backend
port=$("${compose[@]}" port backend 8000)
export LIVE_FRAPPE_URL="http://$port"
export LIVE_FRAPPE_FIXTURES="$work/fixtures.json"
node test/live/tools.mjs
