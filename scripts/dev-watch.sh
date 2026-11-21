#!/usr/bin/env bash
# Dev loop: rebuild and relaunch conn-app whenever a source file changes, and put the app
# back where it was (thread, theme, right panel tab) through the automation hook.
# Theme colors reload without any of this: run with CONN_GPUI_THEME_FILE=<theme.json>.
#
#   scripts/dev-watch.sh                 # uses scripts/run-app.sh (Mac) to launch
#   CARGO_FLAGS="--features cef" scripts/dev-watch.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${CONN_GPUI_DEV:-/tmp/conn-gpui-dev}"
STAMP="$DEV/dev-watch.stamp"
export CONN_GPUI_AUTOMATION="$DEV/automation-port"
mkdir -p "$DEV"

automate() { python3 "$ROOT/scripts/automate.py" "$@" 2>/dev/null; }

snapshot() {
  automate '{"cmd":"dump"}' | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)["result"]
except Exception:
    sys.exit(0)
print(json.dumps({"selected": d.get("selected"), "theme": d.get("theme"),
                  "panel": (d.get("rightPanel") or "").lower()}))' || true
}

restore() {
  local state="$1"
  [[ -n "$state" ]] || return 0
  python3 - "$state" <<'PY' | while read -r cmd; do automate "$cmd" >/dev/null || true; done
import json, sys
s = json.loads(sys.argv[1])
if s.get("theme"): print(json.dumps({"cmd": "theme", "id": s["theme"]}))
if s.get("selected"): print(json.dumps({"cmd": "select", "id": s["selected"]}))
if s.get("panel") in ("files", "diff", "terminal", "browser"):
    print(json.dumps({"cmd": "panel", "tab": s["panel"]}))
PY
}

changed() {
  [[ ! -f "$STAMP" ]] && return 0
  [[ -n "$(find "$ROOT/crates" "$ROOT/Cargo.toml" -newer "$STAMP" \( -name '*.rs' -o -name '*.toml' -o -name '*.svg' -o -name '*.json' \) -print -quit)" ]]
}

echo "watching $ROOT/crates (Ctrl+C to stop)"
while true; do
  if changed; then
    touch "$STAMP"
    if (cd "$ROOT" && cargo build -p conn-app --features automation ${CARGO_FLAGS:-} 2>&1 | tail -3); then
      state="$(snapshot)"
      "$ROOT/scripts/run-app.sh" stop >/dev/null || true
      "$ROOT/scripts/run-app.sh" | tail -1
      sleep 1.5
      restore "$state"
      echo "relaunched $(date +%H:%M:%S)"
    else
      echo "build failed; app left running"
    fi
  fi
  sleep 0.5
done
