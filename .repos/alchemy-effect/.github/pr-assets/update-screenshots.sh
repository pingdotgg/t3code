#!/usr/bin/env bash
# Regenerate the PR screenshots from the built site and commit them if changed.
# Usage: .github/pr-assets/update-screenshots.sh [pr-number]
# Assumes website/dist is freshly built (DOCS_FAST=1 bun astro build).
set -euo pipefail

PR="${1:-721}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.github/pr-assets/$PR"
DIST="$ROOT/website/dist"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=4899

[ -d "$DIST" ] || { echo "website/dist missing — build first"; exit 1; }
mkdir -p "$OUT"

python3 -m http.server "$PORT" --directory "$DIST" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1

shot() { # shot <file> <path> [extra chrome flags...]
  local file="$1" path="$2"; shift 2
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1600,1000 --virtual-time-budget=6000 \
    "$@" --screenshot="$OUT/$file" "http://localhost:$PORT$path" 2>/dev/null
  echo "$file: $(wc -c <"$OUT/$file" | tr -d ' ') bytes"
}

shot landing.png /
shot docs-tab.png /getting-started/
shot cloudflare-hub.png /cloudflare/
shot aws-hub.png /aws/
shot planetscale-hub.png /planetscale/
shot axiom-hub.png /axiom/
shot reference.png /providers/cloudflare/workers/durableobject/
shot cloudflare-hub-dark.png /cloudflare/ --force-dark-mode --blink-settings=preferredColorScheme=2

cd "$ROOT"
if git status --porcelain -- ".github/pr-assets/$PR" | grep -q .; then
  git add ".github/pr-assets/$PR"
  git commit -q -m "chore(website): refresh PR screenshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push
  echo "screenshots refreshed and pushed"
else
  echo "screenshots unchanged"
fi
