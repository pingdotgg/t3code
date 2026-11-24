#!/usr/bin/env bash
# Live Rust hot-patching dev loop via GPUI's built-in Subsecond integration + Dioxus CLI (`dx`).
#
# Edits inside `crates/conn-app` (render bodies, layout, copy, styling, handlers) compile and
# hot-patch directly into the running macOS app window in ~2-3s while keeping the PID, window
# position, WebSocket connection, active thread, and open right-panel tabs alive.
#
# Caveats (Subsecond 0.7.10):
# - Only the executable tip crate (`crates/conn-app`) hot-patches live; edits in workspace library
#   crates (`conn-theme`, `conn-state`, `conn-client`, `conn-desktop`, `conn-web`) or struct layout
#   changes require a full rebuild (press `r` inside `dx serve`).
# - `hot-reload` is gated on `debug_assertions` inside `gpui-pre/build.rs` and never enters release.
# - Uses `$HOME/.cargo/bin/dx` explicitly so Homebrew's Deno `dx` (`/opt/homebrew/bin/dx`) does not
#   shadow Dioxus CLI.
#
# Usage:
#   scripts/dev-hot.sh                                  # live mode: connects to saved Orbit/nick server
#   scripts/dev-hot.sh --sandbox                        # isolated disposable :3891 dev server + automation
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${CONN_GPUI_DEV:-/tmp/conn-gpui-dev}"
PORT="${CONN_GPUI_PORT:-3891}"
DX_BIN="${DX_BIN:-$HOME/.cargo/bin/dx}"
DX_PORT="${CONN_GPUI_DX_PORT:-18743}"

SANDBOX=0
for arg in "$@"; do
  case "$arg" in
    --sandbox) SANDBOX=1 ;;
    --live) SANDBOX=0 ;;
    *)
      echo "usage: $0 [--live|--sandbox]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$DX_BIN" ]] || ! "$DX_BIN" --version 2>/dev/null | grep -qi "dioxus"; then
  echo "error: Dioxus CLI (dx 0.7.10) not found at $DX_BIN" >&2
  echo "Install with:" >&2
  echo "  curl -fsSL https://github.com/DioxusLabs/dioxus/releases/download/v0.7.10/dx-aarch64-apple-darwin.tar.gz | tar -xz -C /tmp && install -m 755 /tmp/dx \"$DX_BIN\"" >&2
  exit 1
fi

FEATURES="hot-reload"
if [[ "$SANDBOX" == "1" ]]; then
  if [[ -z "${CONN_GPUI_SERVER:-}" ]]; then
    "$ROOT/scripts/dev-server.sh" start >/dev/null
    BIN_SERVER="$ROOT/target-conn-server/release/conn-server"
    if [[ ! -s "$DEV/bearer" ]]; then
      "$BIN_SERVER" auth session issue --state-dir "$DEV/state" --token-only --label conn-gpui \
        > "$DEV/bearer"
    fi
    export CONN_GPUI_SERVER="http://127.0.0.1:$PORT"
    export CONN_GPUI_TOKEN_FILE="$DEV/bearer"
  fi
  export CONN_GPUI_AUTOMATION="${CONN_GPUI_AUTOMATION:-$DEV/automation-port}"
  export CONN_GPUI_ORBIT_SYNC="${CONN_GPUI_ORBIT_SYNC:-0}"
  export CONN_GPUI_THEME="${CONN_GPUI_THEME:-dark-mono}"
  FEATURES="$FEATURES automation"
else
  # Live mode: let conn-app auto-connect to the saved Orbit Node / direct server and
  # adopt the live Orbit profile & theme without overriding env vars.
  unset CONN_GPUI_AUTOMATION
fi

if [[ -n "${CONN_GPUI_EXTRA_FEATURES:-}" ]]; then
  FEATURES="$FEATURES $CONN_GPUI_EXTRA_FEATURES"
fi

INTERACTIVE_ARGS=()
if [[ ! -t 0 ]]; then
  INTERACTIVE_ARGS+=(--interactive false)
fi

cd "$ROOT"
exec "$DX_BIN" serve \
  --platform macos \
  --package conn-app \
  --bin conn-app \
  --features "$FEATURES" \
  --hot-patch \
  --open false \
  "${INTERACTIVE_ARGS[@]}" \
  --addr 127.0.0.1 \
  --port "$DX_PORT"
