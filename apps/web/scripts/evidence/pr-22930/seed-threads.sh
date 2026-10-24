#!/usr/bin/env bash
# usage: seed-threads.sh <worktree> <home-dir>   (its dev server must be running)
# Adds projects A (review-a) and B (review-b), one idle thread in each (no message, so no provider
# turn; the model is only a label the launch requires), and links PR #1 to thread A and PR #2 to thread B. Prints shell assignments for driver.mjs.
set -euo pipefail
EV_DIR=${EV_DIR:-/tmp/ev-22930}
WT=$1 HOME_DIR=$2
here=$(cd "$(dirname "$0")" && pwd)
# mcp-call.ts imports the server through relative paths, so it runs from the target worktree.
mkdir -p "$WT/apps/web/scripts/evidence/pr-22930"
[ "$here" = "$WT/apps/web/scripts/evidence/pr-22930" ] || cp "$here/mcp-call.ts" "$WT/apps/web/scripts/evidence/pr-22930/"
cd "$WT"
t3() { node apps/server/src/bin.ts "$@" --base-dir "$HOME_DIR"; }
call() { node apps/web/scripts/evidence/pr-22930/mcp-call.ts "$HOME_DIR" "$@"; }
id() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
pa=$(t3 project add "$EV_DIR/fixture/review-a" --title review-a | grep -o '[0-9a-f-]\{36\}' | head -1)
pb=$(t3 project add "$EV_DIR/fixture/review-b" --title review-b | grep -o '[0-9a-f-]\{36\}' | head -1)
ta=$(call t3_thread_launch "{\"projectId\":\"$pa\",\"title\":\"Thread A\",\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"gpt-5.5\"},\"workspaceStrategy\":{\"type\":\"root\",\"branch\":\"review-l\"}}" | id threadId)
tb=$(call t3_thread_launch "{\"projectId\":\"$pb\",\"title\":\"Thread B\",\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"gpt-5.5\"},\"workspaceStrategy\":{\"type\":\"root\",\"branch\":\"review-s\"}}" | id threadId)
pr=http://forgejo.127.0.0.1.nip.io:3000/fixture/review/pulls
call link_pull_request "{\"threadId\":\"$ta\",\"url\":\"$pr/1\"}" >/dev/null
call link_pull_request "{\"threadId\":\"$tb\",\"url\":\"$pr/2\"}" >/dev/null
port=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("devUrl") or "")' "$HOME_DIR/userdata/server-runtime.json")
printf 'BASE_URL=%s\nENV_ID=%s\nTHREAD_A=%s\nTHREAD_B=%s\n' "${port%/}" "$(cat "$HOME_DIR/userdata/environment-id")" "$ta" "$tb"
