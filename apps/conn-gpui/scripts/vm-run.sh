#!/usr/bin/env bash
# Runs inside nick-vm (from a private nckrtl/conn checkout, in apps/conn-gpui): builds
# conn-app with automation, bundles it, and opens it against the VM's disposable
# conn-server at a fixed window frame for side-by-side captures with real Conn.
#
#   scripts/vm-run.sh [theme]      # default theme t3-code-light
#   scripts/vm-run.sh stop
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV=/tmp/conn-gpui-dev
APP="$ROOT/target/debug/Conn GPUI.app"

stop() {
  if [[ -f "$DEV/app.pid" ]] && kill -0 "$(cat "$DEV/app.pid")" 2>/dev/null; then
    kill "$(cat "$DEV/app.pid")"
    sleep 1
  fi
  rm -f "$DEV/app.pid"
}

if [[ "${1:-}" == "stop" ]]; then
  stop
  exit 0
fi

THEME="${1:-t3-code-light}"
stop
(cd "$ROOT" && cargo build -p conn-app --features automation 2>&1 | tail -1)
"$ROOT/scripts/bundle-app.sh" debug >/dev/null
rm -f "$DEV/automation-port"
EXTRA=()
[[ -n "${CONN_GPUI_VIBRANCY_MATERIAL:-}" ]] && EXTRA+=(--env "CONN_GPUI_VIBRANCY_MATERIAL=$CONN_GPUI_VIBRANCY_MATERIAL")
[[ -n "${CONN_GPUI_VIBRANCY_STATE:-}" ]] && EXTRA+=(--env "CONN_GPUI_VIBRANCY_STATE=$CONN_GPUI_VIBRANCY_STATE")
[[ -n "${CONN_GPUI_METAL_DISPLAY_LINK:-}" ]] && EXTRA+=(--env CONN_GPUI_METAL_DISPLAY_LINK=1)
open -n "$APP" ${EXTRA[@]+"${EXTRA[@]}"} \
  --env CONN_WEB_TRACE=1 \
  --env CONN_GPUI_FRAME_LOG=1 \
  --env CONN_GPUI_WINDOW=20,41,1440,900 \
  --env CONN_GPUI_SERVER=http://127.0.0.1:3891 \
  --env CONN_GPUI_TOKEN_FILE="$DEV/bearer" \
  --env CONN_GPUI_AUTOMATION="$DEV/automation-port" \
  --env CONN_GPUI_THEME="$THEME" \
  --stdout "$DEV/app.log" --stderr "$DEV/app.log"
for _ in $(seq 1 100); do [[ -s "$DEV/automation-port" ]] && break; sleep 0.1; done
pgrep -f "Conn GPUI.app/Contents/MacOS/conn-app" | tail -1 > "$DEV/app.pid"
echo "conn-gpui pid $(cat "$DEV/app.pid"), automation port $(cat "$DEV/automation-port" 2>/dev/null)"
