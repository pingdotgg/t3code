#!/usr/bin/env bash
# Starts a disposable conn-server for conn-gpui development. Never touches ~/.t3.
#
#   scripts/dev-server.sh start   # build if needed, start, print pairing url
#   scripts/dev-server.sh stop    # stop the server this script started (by PID)
#   scripts/dev-server.sh status
#
# State lives in $CONN_GPUI_DEV (default /tmp/conn-gpui-dev): state/, projects/, server.pid,
# server.log, pairing-url. The app reads pairing-url (or a saved bearer) from there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${CONN_GPUI_DEV:-/tmp/conn-gpui-dev}"
SERVER_SRC="$ROOT/../conn-server"
TARGET="$ROOT/target-conn-server"
BIN="$TARGET/release/conn-server"
PORT="${CONN_GPUI_PORT:-3891}"

cmd="${1:-start}"

running() {
  [[ -f "$DEV/server.pid" ]] && kill -0 "$(cat "$DEV/server.pid")" 2>/dev/null
}

case "$cmd" in
  start)
    if running; then
      echo "already running: pid $(cat "$DEV/server.pid"), $(cat "$DEV/pairing-url" 2>/dev/null)"
      exit 0
    fi
    # conn-server lives next to this app; cargo rebuilds only what changed.
    (cd "$SERVER_SRC" && CARGO_TARGET_DIR="$TARGET" cargo build --release -p conn-server)
    mkdir -p "$DEV/state" "$DEV/projects"
    # Demo projects: throwaway clones, so threads can never edit a real checkout.
    # A snapshot of this app only (not the whole monorepo), in its own throwaway repo.
    if [[ ! -d "$DEV/projects/conn-gpui/.git" ]]; then
      mkdir -p "$DEV/projects/conn-gpui"
      git -C "$ROOT" archive HEAD . | tar -x -C "$DEV/projects/conn-gpui"
      git -C "$DEV/projects/conn-gpui" init -q -b main
      git -C "$DEV/projects/conn-gpui" add .
      git -C "$DEV/projects/conn-gpui" -c user.name=demo -c user.email=demo@example.com \
        -c commit.gpgsign=false commit -qm "init"
    fi
    if [[ ! -d "$DEV/projects/hello-rust/.git" ]]; then
      mkdir -p "$DEV/projects/hello-rust/src"
      printf '[package]\nname = "hello-rust"\nversion = "0.1.0"\nedition = "2024"\n' \
        > "$DEV/projects/hello-rust/Cargo.toml"
      printf 'fn main() {\n    println!("hello from conn-gpui");\n}\n' \
        > "$DEV/projects/hello-rust/src/main.rs"
      printf '# hello-rust\n\nA tiny demo project for conn-gpui.\n' > "$DEV/projects/hello-rust/README.md"
      printf '/target\n' > "$DEV/projects/hello-rust/.gitignore"
      git -C "$DEV/projects/hello-rust" init -q -b main
      git -C "$DEV/projects/hello-rust" add .
      git -C "$DEV/projects/hello-rust" -c user.name=demo -c user.email=demo@example.com \
        -c commit.gpgsign=false commit -qm "init"
    fi
    # A private copy of the Claude SDK host with its npm deps, so the conn-server source stays untouched.
    if [[ ! -d "$DEV/sdk-host/node_modules/@anthropic-ai/claude-agent-sdk" ]]; then
      mkdir -p "$DEV/sdk-host"
      cp -R "$SERVER_SRC/helpers/sdk-host/"{index.mjs,drivers,package.json,package-lock.json} "$DEV/sdk-host/"
      (cd "$DEV/sdk-host" && npm install --ignore-scripts --no-audit --no-fund >/dev/null)
    fi
    # Codex stays off so this machine's codex never runs; Claude stays on for cheap Haiku turns.
    if [[ ! -f "$DEV/state/settings.json" ]]; then
      echo '{"providerInstances":{"codex":{"driver":"codex","enabled":false}}}' \
        > "$DEV/state/settings.json"
    fi
    CONN_MODEL_MANIFEST_URL=off nohup "$BIN" serve \
      --host 127.0.0.1 --port "$PORT" \
      --state-dir "$DEV/state" \
      --label conn-gpui-dev \
      --sdk-host "$DEV/sdk-host/index.mjs" \
      --project "$DEV/projects/conn-gpui" \
      --project "$DEV/projects/hello-rust" \
      > "$DEV/server.log" 2>&1 &
    echo $! > "$DEV/server.pid"
    for _ in $(seq 1 100); do
      if url=$(grep -o 'pairingUrl: [^ ]*' "$DEV/server.log" | head -1 | cut -d' ' -f2) && [[ -n "$url" ]]; then
        echo "$url" > "$DEV/pairing-url"
        echo "started pid $(cat "$DEV/server.pid") at $url"
        exit 0
      fi
      if ! running; then
        echo "server exited:"; cat "$DEV/server.log"; exit 1
      fi
      sleep 0.1
    done
    echo "no pairing url yet; see $DEV/server.log"; exit 1
    ;;
  stop)
    if running; then
      kill "$(cat "$DEV/server.pid")"
      echo "stopped pid $(cat "$DEV/server.pid")"
    else
      echo "not running"
    fi
    rm -f "$DEV/server.pid"
    ;;
  status)
    if running; then echo "running pid $(cat "$DEV/server.pid")"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status"; exit 2
    ;;
esac
