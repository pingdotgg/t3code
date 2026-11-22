#!/usr/bin/env bash
# Drives side-by-side parity verification between current `Conn.app` and `Conn GPUI.app`
# inside `nick-vm` against a single deterministic seeded `:3891` `conn-server`.
#
# Never touches live `~/.t3/userdata`. Everything lives under $DEV (/tmp/conn-gpui-dev).
#
# Usage (inside nick-vm via VMPal `vmpal_exec`):
#   scripts/vm-parity.sh seed                      # create throwaway repos + seeded engine.sqlite
#   scripts/vm-parity.sh start-conn                # launch ref/Conn.app on :3891 (T3CODE_HOME=$DEV)
#   scripts/vm-parity.sh start-gpui [theme]        # launch Conn GPUI.app on the same :3891 server
#   scripts/vm-parity.sh e2e                       # run expanded scripts/e2e.py against Conn GPUI
#   scripts/vm-parity.sh capture <owner> <out.png> # capture native window PNG via screencapture
#   scripts/vm-parity.sh stop                      # stop tracked Conn.app, Conn GPUI.app & server
set -euo pipefail

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${CONN_GPUI_DEV:-/tmp/conn-gpui-dev}"
PORT="${CONN_GPUI_PORT:-3891}"
REF_CONN="${CONN_REF_APP:-$HOME/apps/conn-gpui-vm/ref/Conn.app}"
CONN_SERVER_BIN="${CONN_SERVER_BIN:-$ROOT/target-conn-server/release/conn-server}"

stop_pid_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local pid
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
    fi
    rm -f "$f"
  fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  seed)
    stop_pid_file "$DEV/gpui.pid"
    stop_pid_file "$DEV/conn-app.pid"
    stop_pid_file "$DEV/server.pid"
    rm -rf "$DEV/userdata" "$DEV/state" "$DEV/bearer" "$DEV/automation-port"
    python3 "$ROOT/scripts/seed-parity.py" --dev-dir "$DEV" --state-subdir userdata
    # Keep a symlink `state -> userdata` so dev-server.sh and Conn.app share the exact same DB.
    ln -sfn "$DEV/userdata" "$DEV/state"
    echo "parity seed ready under $DEV/userdata"
    ;;

  start-conn)
    if [[ ! -d "$REF_CONN" ]]; then
      echo "error: reference Conn.app not found at $REF_CONN" >&2
      exit 1
    fi
    stop_pid_file "$DEV/conn-app.pid"
    mkdir -p "$DEV/userdata"
    # Launch current Conn.app against disposable T3CODE_HOME on port $PORT so it owns the
    # embedded conn-server backed by our seeded `$DEV/userdata/engine.sqlite`.
    open -n "$REF_CONN" \
      --env T3CODE_HOME="$DEV" \
      --env T3CODE_PORT="$PORT" \
      --env T3CODE_DISABLE_AUTO_UPDATE=1 \
      --stdout "$DEV/conn-app.log" --stderr "$DEV/conn-app.log"
    for _ in $(seq 1 120); do
      if lsof -nP -ti "TCP:127.0.0.1:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    # Track the Conn.app main process PID.
    pgrep -f "ref/Conn.app/Contents/MacOS/Conn" | tail -1 > "$DEV/conn-app.pid" || true
    # Issue a bearer token against the same userdata dir so Conn GPUI connects to :$PORT too.
    BUNDLED_SERVER="$REF_CONN/Contents/Resources/conn-server"
    if [[ -x "$BUNDLED_SERVER" ]]; then
      "$BUNDLED_SERVER" auth session issue --state-dir "$DEV/userdata" --token-only --label conn-gpui-parity \
        > "$DEV/bearer"
    elif [[ -x "$CONN_SERVER_BIN" ]]; then
      "$CONN_SERVER_BIN" auth session issue --state-dir "$DEV/userdata" --token-only --label conn-gpui-parity \
        > "$DEV/bearer"
    fi
    # Position Conn.app window at 20,41 1440x900 to match Conn GPUI.app pixel-for-pixel.
    osascript -e 'tell application "System Events" to tell process "Conn" to set {position of window 1, size of window 1} to {{20, 41}, {1440, 900}}' 2>/dev/null || true
    echo "Conn.app started (pid $(cat "$DEV/conn-app.pid" 2>/dev/null || echo unknown)) on :$PORT"
    ;;

  start-gpui)
    THEME="${1:-dark-ocean}"
    stop_pid_file "$DEV/gpui.pid"
    if ! lsof -nP -ti "TCP:127.0.0.1:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      "$ROOT/scripts/dev-server.sh" start
    fi
    if [[ ! -s "$DEV/bearer" ]]; then
      BUNDLED_SERVER="$REF_CONN/Contents/Resources/conn-server"
      if [[ -x "$BUNDLED_SERVER" ]]; then
        "$BUNDLED_SERVER" auth session issue --state-dir "$DEV/userdata" --token-only --label conn-gpui-parity > "$DEV/bearer"
      else
        "$CONN_SERVER_BIN" auth session issue --state-dir "$DEV/state" --token-only --label conn-gpui-parity > "$DEV/bearer"
      fi
    fi
    (cd "$ROOT" && cargo build -p conn-app --features automation ${CARGO_FLAGS:-})
    APP_PATH="$("$ROOT/scripts/bundle-app.sh" debug | tail -n 1)"
    rm -f "$DEV/automation-port"
    open -n "$APP_PATH" \
      --env CONN_GPUI_WINDOW=20,41,1440,900 \
      --env CONN_GPUI_SERVER="http://127.0.0.1:$PORT" \
      --env CONN_GPUI_TOKEN_FILE="$DEV/bearer" \
      --env CONN_GPUI_AUTOMATION="$DEV/automation-port" \
      --env CONN_GPUI_CONTROL_STATE_DIR="$DEV/state" \
      --env CONN_GPUI_ORBIT_SYNC=0 \
      --env CONN_GPUI_THEME="$THEME" \
      --stdout "$DEV/app.log" --stderr "$DEV/app.log"
    for _ in $(seq 1 120); do [[ -s "$DEV/automation-port" ]] && break; sleep 0.1; done
    AUTO_PORT="$(cat "$DEV/automation-port" 2>/dev/null || true)"
    if [[ -n "$AUTO_PORT" ]]; then
      lsof -nP -ti "TCP:127.0.0.1:$AUTO_PORT" -sTCP:LISTEN | head -1 > "$DEV/gpui.pid"
    fi
    echo "Conn GPUI.app started (pid $(cat "$DEV/gpui.pid" 2>/dev/null || echo unknown), automation port $AUTO_PORT)"
    ;;

  e2e)
    CONN_GPUI_DEV="$DEV" CONN_E2E_ALLOW_NO_VAULT=1 python3 "$ROOT/scripts/e2e.py"
    ;;

  capture)
    OWNER="${1:?owner name (Conn or conn-app)}"
    OUT="${2:?output png path}"
    "$ROOT/scripts/shot.sh" "$OWNER" "$OUT"
    ;;

  stop)
    stop_pid_file "$DEV/gpui.pid"
    stop_pid_file "$DEV/conn-app.pid"
    stop_pid_file "$DEV/server.pid"
    echo "stopped VM parity processes"
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
