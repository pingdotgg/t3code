#!/bin/bash
# Copies T3 Code's chats into the T3 Learn server on this Linux machine (t3learn.service, ~/.t3-learn).
# T3 Code's data folder is opened read-only and never changed. The copy replaces T3 Learn's chats,
# side chats and paired devices, so it refuses once a device has paired unless --force is given.
#
# The copy is built and booted in a staging folder with no provider reachable, so runs that were in
# flight in T3 Code are stopped there instead of continuing. Only a copy with nothing in flight is
# swapped in. A failure before the swap leaves T3 Learn as it was.
#
# Run it from a checkout of this repository at the tag of the installed T3 Learn server
# (git checkout v<version>), after `vp i`, or point T3_LEARN_CHECKOUT at such a checkout.
# See docs/user/t3-learn-agent-setup.md.
#
#   T3_LEARN_COPY_FROM   T3 Code's home folder (default ~/.t3)
#   T3_LEARN_CHECKOUT    checkout at the installed tag (default: the one holding this script)
#   T3_LEARN_COPY_TO     T3 Learn's home folder (default ~/.t3-learn)
#   T3_LEARN_UNIT        T3 Learn's systemd user unit (default t3learn.service)
#   T3_LEARN_PORT        port of that unit (default 3780)
set -euo pipefail

CHECKOUT=${T3_LEARN_CHECKOUT:-$(cd "$(dirname "$0")/.." && pwd)}
SOURCE=${T3_LEARN_COPY_FROM:-$HOME/.t3}
LEARN=${T3_LEARN_COPY_TO:-$HOME/.t3-learn}
STAGE=$LEARN-staging
UNIT=${T3_LEARN_UNIT:-t3learn.service}
PORT=${T3_LEARN_PORT:-3780}
SANDBOX_PORT=3781
LOG=$STAGE-boot.log
ME=$(basename "$0")

T3=$(sed -n 's/^ExecStart=\(.*\) __service-launcher$/\1/p' "$HOME/.config/systemd/user/$UNIT" 2>/dev/null || true)
[ -x "$T3" ] || { echo "$ME: $UNIT is not installed; install it first (see the guide)" >&2; exit 1; }
VERSION=$(basename "$(dirname "$T3")")
[ -e "$SOURCE/userdata/statev2.sqlite" ] || { echo "$ME: no T3 Code database at $SOURCE" >&2; exit 1; }

say() { printf '%s %s\n' "$(date +%T)" "$*"; }
count() { sqlite3 -readonly "$1" "$2"; }

# CLI and MCP bearer sessions (subject mcp-client) are not paired devices.
sessions=$(count "$LEARN/userdata/statev2.sqlite" \
  "SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NULL AND subject <> 'mcp-client'")
if [ "$sessions" != 0 ] && [ "${1:-}" != --force ]; then
  echo "$ME: $sessions paired device session(s) would be wiped; pass --force" >&2
  exit 1
fi

# The import runs this checkout's migrations, so they must be the running server's.
tag_tree=$(git -C "$CHECKOUT" rev-parse "v$VERSION^{tree}")
head_tree=$(git -C "$CHECKOUT" rev-parse "HEAD^{tree}")
[ "$tag_tree" = "$head_tree" ] || {
  echo "$ME: $CHECKOUT is not at v$VERSION; check it out first" >&2
  exit 1
}

if ss -H -ltn "sport = :$SANDBOX_PORT" | grep -q .; then
  echo "$ME: port $SANDBOX_PORT is in use (a leftover sandbox?)" >&2
  exit 1
fi

say "Copying T3 Code's chats into $STAGE (read-only source)..."
rm -rf "$STAGE" && mkdir -p "$STAGE/userdata" && chmod 700 "$STAGE"
importer=$CHECKOUT/apps/server/scripts/t3-learn-import.tmp.ts
trap 'rm -f "$importer"' EXIT
# migrate-dev-db without its live-thread filter: running chats come too, then get stopped below.
python3 - "$CHECKOUT/apps/server/scripts/migrate-dev-db.ts" "$importer" <<'EOF'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
anchor = "  // Clone or drop whole thread families"
assert s.count(anchor) == 1, "migrate-dev-db changed; update this script"
open(dst, "w").write(s.replace(anchor, "  yield* sql`DELETE FROM live_threads`;\n" + anchor))
EOF
(cd "$CHECKOUT" && node "$importer" --base-dir "$STAGE" --projects 100000 --threads-per-project 1000000 \
  --source "$SOURCE/userdata/statev2.sqlite") \
  >"$STAGE-import.log" 2>&1 || { echo "import failed; see $STAGE-import.log" >&2; exit 1; }
grep -E "ready|threads$" "$STAGE-import.log"
rm -f "$importer"

# T3 Learn keeps its own settings once it has them; the first copy starts from T3 Code's.
settings=$LEARN/userdata/settings.json
[ -e "$settings" ] || settings=$SOURCE/userdata/settings.json
python3 - "$settings" "$STAGE/userdata/settings.json" <<'EOF'
import json, os, sys
settings = json.load(open(sys.argv[1])) if os.path.exists(sys.argv[1]) else {}
settings.pop("providerInstances", None)
settings["continueThreadsAfterServerUpdate"] = False
json.dump(settings, open(sys.argv[2], "w"), indent=2)
EOF

say "Booting the copy with no providers reachable, to stop runs that were in flight..."
since=$(date -u +%Y-%m-%dT%H:%M:%S)
# Run directly, not in a function: a backgrounded function is a subshell, and $! must be the server.
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=C.UTF-8 PATH=/usr/bin:/bin \
  T3CODE_TELEMETRY_ENABLED=false T3CODE_HOME="$STAGE" \
  "$T3" serve --base-dir "$STAGE" --port "$SANDBOX_PORT" --host 127.0.0.1 >"$LOG" 2>&1 &
pid=$!
for _ in $(seq 1 180); do
  grep -q "orchestration recovery completed" "$LOG" && break
  kill -0 "$pid" 2>/dev/null || { echo "sandbox server exited; see $LOG" >&2; exit 1; }
  sleep 1
done
grep -q "orchestration recovery completed" "$LOG" || { kill "$pid"; echo "sandbox boot timed out; see $LOG" >&2; exit 1; }
sleep 10
kill "$pid"
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if ss -H -ltn "sport = :$SANDBOX_PORT" | grep -q .; then
  echo "sandbox server still holds port $SANDBOX_PORT; not swapping" >&2
  exit 1
fi

db=$STAGE/userdata/statev2.sqlite
in_flight=$(count "$db" "SELECT
  (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting'))
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status='queued' AND json_extract(payload_json,'\$.queueHeld') IS NOT 1)
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE json_valid(payload_json) AND json_type(payload_json,'\$.delegatedCompletion.delivery')='object')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads WHERE status='active')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE requested_at >= '$since')
+ (SELECT COUNT(*) FROM scheduled_tasks)")
[ "$in_flight" = 0 ] || { echo "copy still has $in_flight in-flight items; not swapping" >&2; exit 1; }

say "Swapping the new copy into $UNIT..."
systemctl --user stop "$UNIT"
mkdir -p "$LEARN/userdata/attachments" "$LEARN/userdata/browser-artifacts"
rm -f "$LEARN"/userdata/statev2.sqlite.previous*
for suffix in "" -wal -shm; do
  if [ -e "$LEARN/userdata/statev2.sqlite$suffix" ]; then
    mv "$LEARN/userdata/statev2.sqlite$suffix" "$LEARN/userdata/statev2.sqlite.previous$suffix"
  fi
  if [ -e "$db$suffix" ]; then mv "$db$suffix" "$LEARN/userdata/statev2.sqlite$suffix"; fi
done
[ -e "$LEARN/userdata/settings.json" ] || cp "$STAGE/userdata/settings.json" "$LEARN/userdata/settings.json"
cp -a "$SOURCE/userdata/attachments/." "$LEARN/userdata/attachments/"
cp -a "$SOURCE/userdata/browser-artifacts/." "$LEARN/userdata/browser-artifacts/"
started=$(date -u +%Y-%m-%dT%H:%M:%S)
systemctl --user start "$UNIT"
for _ in $(seq 1 120); do
  ss -H -ltn "sport = :$PORT" | grep -q . && break
  sleep 1
done
sleep 5
rm -rf "$STAGE"
started_runs=$(count "$LEARN/userdata/statev2.sqlite" \
  "SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE requested_at >= '$started'")
say "Done. $UNIT is $(systemctl --user is-active "$UNIT"); runs started since swap: $started_runs."
say "Previous copy kept at $LEARN/userdata/statev2.sqlite.previous."
