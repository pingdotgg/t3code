#!/usr/bin/env bash
# Builds conn-app with the automation hook and runs it against the disposable dev server
# (scripts/dev-server.sh). Writes the app PID to $DEV/app.pid; stop with `scripts/run-app.sh stop`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${CONN_GPUI_DEV:-/tmp/conn-gpui-dev}"
PORT="${CONN_GPUI_PORT:-3891}"
if [[ "${1:-}" == "stop" ]]; then
  if [[ -f "$DEV/app.pid" ]] && kill -0 "$(cat "$DEV/app.pid")" 2>/dev/null; then
    kill "$(cat "$DEV/app.pid")"; echo "stopped app $(cat "$DEV/app.pid")"
  fi
  rm -f "$DEV/app.pid"; exit 0
fi
"$ROOT/scripts/dev-server.sh" start >/dev/null
BIN_SERVER="$ROOT/target-conn-server/release/conn-server"
if [[ ! -s "$DEV/bearer" ]]; then
  "$BIN_SERVER" auth session issue --state-dir "$DEV/state" --token-only --label conn-gpui \
    > "$DEV/bearer"
fi
(cd "$ROOT" && cargo build -p conn-app --features automation ${CARGO_FLAGS:-})
# A bundled .app activates like a normal app (clicks and keys reach it); a bare binary does not.
"$ROOT/scripts/bundle-app.sh" debug >/dev/null
rm -f "$DEV/automation-port"
open -n "$ROOT/target/debug/Conn GPUI.app" \
  --env CONN_GPUI_SERVER="http://127.0.0.1:$PORT" \
  --env CONN_GPUI_TOKEN_FILE="$DEV/bearer" \
  --env CONN_GPUI_AUTOMATION="$DEV/automation-port" \
  --env CONN_GPUI_THEME="${CONN_GPUI_THEME:-dark-mono}" \
  --env CONN_GPUI_BROWSER_URL="${CONN_GPUI_BROWSER_URL:-}" \
  --stdout "$DEV/app.log" --stderr "$DEV/app.log"
for _ in $(seq 1 100); do [[ -s "$DEV/automation-port" ]] && break; sleep 0.1; done
pgrep -f "Conn GPUI.app/Contents/MacOS/conn-app" | tail -1 > "$DEV/app.pid"
echo "app pid $(cat "$DEV/app.pid"), automation port $(cat "$DEV/automation-port" 2>/dev/null)"
