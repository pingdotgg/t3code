#!/bin/bash
# Adds T3 Code's new chats to the T3 Learn server on this Linux machine (t3learn.service, ~/.t3-learn).
# T3 Code's data folder is opened read-only and never changed. Chats T3 Learn already has, including
# ones continued or deleted there, are never replaced; nor are side chats, settings or paired devices.
#
# The copy is built and booted in a staging folder with no provider reachable, so runs that were in
# flight in T3 Code are stopped there instead of continuing, and PR watches are ended. New chats are
# added only from a copy with nothing in flight, and only while T3 Learn is idle; the unit is stopped
# for the few seconds the merge takes. A failure leaves T3 Learn as it was.
#
# Run it from a checkout of this repository at the tag of the installed T3 Learn server
# (git checkout v<version>), after `vp i`, or point T3_LEARN_CHECKOUT at such a checkout.
# See docs/user/t3-learn-agent-setup.md.
#
#   T3_LEARN_COPY_FROM   T3 Code's home folder (default ~/.t3)
#   T3_LEARN_CHECKOUT    checkout at the installed tag (default: the one holding this script)
#   T3_LEARN_COPY_TO     OminaX's home folder (default ~/.ominax, or ~/.t3-learn before the rename)
#   T3_LEARN_UNIT        OminaX's systemd user unit (default ominax.service, or t3learn.service before the rename)
#   T3_LEARN_PORT        port of that unit (default 3780)

# Counts processes in a unit's cgroup other than its launcher, server and resource monitor. Each live
# agent keeps a reaper sh there even between runs, so stopping the unit with any present kills work.
live_agents() {
  local pid argv
  find "$1" -name cgroup.procs -exec cat {} + 2>/dev/null | while read -r pid; do
    argv=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || continue
    case "$argv" in
      "" | *" __service-launcher " | *" serve " | */t3-resource-monitor" ") ;;
      *) echo "$pid" ;;
    esac
  done | wc -l
}
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

set -euo pipefail

CHECKOUT=${T3_LEARN_CHECKOUT:-$(cd "$(dirname "$0")/.." && pwd)}
SOURCE=${T3_LEARN_COPY_FROM:-$HOME/.t3}
LEARN=${T3_LEARN_COPY_TO:-$HOME/.ominax}
[ -n "${T3_LEARN_COPY_TO:-}" ] || [ -e "$LEARN" ] || LEARN=$HOME/.t3-learn
STAGE=$LEARN-staging
UNIT=${T3_LEARN_UNIT:-ominax.service}
[ -n "${T3_LEARN_UNIT:-}" ] || [ -f "$HOME/.config/systemd/user/$UNIT" ] || UNIT=t3learn.service
PORT=${T3_LEARN_PORT:-3780}
SANDBOX_PORT=3781
LOG=$STAGE-boot.log
ME=$(basename "$0")

T3=$(sed -n 's/^ExecStart=\(.*\) __service-launcher$/\1/p' "$HOME/.config/systemd/user/$UNIT" 2>/dev/null || true)
[ -x "$T3" ] || { echo "$ME: $UNIT is not installed; install it first (see the guide)" >&2; exit 1; }
VERSION=$(basename "$(dirname "$T3")")
# After an update the unit's launcher stays put and serves the version the runtime state names.
active=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("activeVersion",""))' \
  "$LEARN/runtime/service-state.json" 2>/dev/null || true)
if [ -n "$active" ] && [ -x "$LEARN/runtime/versions/$active/t3" ]; then
  VERSION=$active T3=$LEARN/runtime/versions/$active/t3
fi
[ -e "$SOURCE/userdata/statev2.sqlite" ] || { echo "$ME: no T3 Code database at $SOURCE" >&2; exit 1; }

say() { printf '%s %s\n' "$(date +%T)" "$*"; }
count() { sqlite3 -readonly "$1" "$2"; }

target=$LEARN/userdata/statev2.sqlite
[ -e "$target" ] || { echo "$ME: no OminaX database at $LEARN; start $UNIT once first" >&2; exit 1; }

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
db=$STAGE/userdata/statev2.sqlite

# A copied PR watch or armed usage-limit resume would wake the copy and resume T3 Code's own session.
sqlite3 -bail "$db" "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '\$.pullRequests',
  (SELECT json_group_array(CASE WHEN json_type(p.value, '\$.watch') = 'object'
     THEN json_set(json_remove(p.value, '\$.watch'), '\$.endedWatch', json(json_extract(p.value, '\$.watch')))
     ELSE json(p.value) END ORDER BY p.key) FROM json_each(payload_json, '\$.pullRequests') p))
  WHERE EXISTS (SELECT 1 FROM json_each(payload_json, '\$.pullRequests') p WHERE json_type(p.value, '\$.watch') = 'object');
  UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '\$.limitRecovery.autoResume', json('false'))
  WHERE json_extract(payload_json, '\$.limitRecovery.autoResume') = 1"

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

in_flight=$(count "$db" "SELECT
  (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting'))
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status='queued' AND json_extract(payload_json,'\$.queueHeld') IS NOT 1)
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE json_valid(payload_json) AND json_type(payload_json,'\$.delegatedCompletion.delivery')='object')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads WHERE status='active')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE requested_at >= '$since')
+ (SELECT COUNT(*) FROM orchestration_v2_projection_threads t, json_each(t.payload_json,'\$.pullRequests') p WHERE json_type(p.value,'\$.watch')='object')
+ (SELECT COUNT(*) FROM scheduled_tasks)")
[ "$in_flight" = 0 ] || { echo "copy still has $in_flight in-flight items; not swapping" >&2; exit 1; }

# Families T3 Learn lacks. One that ran in the last hour may still be going in T3 Code, and one with a
# usage-limit stop could auto-resume in T3 Learn; both wait for a later sync.
new_where="WHERE COALESCE(json_extract(payload_json, '\$.lineage.rootThreadId'), thread_id)
    NOT IN (SELECT thread_id FROM main.orchestration_v2_projection_threads)
  AND COALESCE(json_extract(payload_json, '\$.lineage.rootThreadId'), thread_id) NOT IN (
    SELECT COALESCE(json_extract(payload_json, '\$.lineage.rootThreadId'), thread_id) FROM src.orchestration_v2_projection_threads
    WHERE thread_id IN (SELECT thread_id FROM src.orchestration_v2_projection_runs
                        WHERE requested_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'))
       OR thread_id IN (SELECT thread_id FROM src.orchestration_v2_projection_turn_items
                        WHERE type = 'error' AND json_extract(payload_json, '\$.failure.class') = 'usage_limit'
                          AND julianday(json_extract(payload_json, '\$.failure.resetAt')) > julianday('now', '-1 day')))"
# Whole thread families (a chat with its forks and subagents) whose root T3 Learn lacks are added.
# Rows keep their ids; event logs get fresh sequence numbers. Outbox effects are left behind.
inserts=$(count "$db" "SELECT 'INSERT OR IGNORE INTO main.\"' || m.name || '\" (' || cols || ') SELECT ' || cols
    || ' FROM src.\"' || m.name || '\" WHERE thread_id IN (SELECT thread_id FROM new_threads)'
    || CASE WHEN cols NOT LIKE '%\"sequence\"%' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'sequence') THEN ' ORDER BY sequence' ELSE '' END || ';'
  FROM (SELECT name, (SELECT group_concat('\"' || name || '\"', ',') FROM pragma_table_info(t.name)
                      WHERE NOT (pk = 1 AND name = 'sequence')) AS cols
        FROM sqlite_master t WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%') m
  WHERE EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'thread_id')
    AND m.name NOT IN ('orchestration_v2_effect_outbox', 'scheduled_tasks')")
event_cols=$(count "$db" "SELECT group_concat('\"' || name || '\"', ',') FROM pragma_table_info('orchestration_events') WHERE name <> 'sequence'")
merge_sql="
ATTACH DATABASE '$db' AS src;
BEGIN IMMEDIATE;
CREATE TEMP TABLE new_threads AS SELECT thread_id FROM src.orchestration_v2_projection_threads
  $new_where;
CREATE TEMP TABLE new_projects AS SELECT project_id FROM src.projection_projects
  WHERE project_id IN (SELECT project_id FROM src.orchestration_v2_projection_threads
                       WHERE thread_id IN (SELECT thread_id FROM new_threads))
    AND project_id NOT IN (SELECT project_id FROM main.projection_projects);
INSERT INTO main.projection_projects SELECT * FROM src.projection_projects
  WHERE project_id IN (SELECT project_id FROM new_projects);
INSERT OR IGNORE INTO main.orchestration_events ($event_cols) SELECT $event_cols FROM src.orchestration_events
  WHERE (aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM new_threads))
     OR (aggregate_kind = 'project' AND stream_id IN (SELECT project_id FROM new_projects))
  ORDER BY sequence;
$inserts
-- Marks copies so OminaX blocks their main box; never set it to null, which breaks the thread.
UPDATE main.orchestration_v2_projection_threads
  SET payload_json = json_set(payload_json, '\$.t3CodeCopiedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE thread_id IN (SELECT thread_id FROM new_threads);
INSERT OR IGNORE INTO main.orchestration_v2_projection_provider_sessions
  SELECT * FROM src.orchestration_v2_projection_provider_sessions
  WHERE provider_session_id IN (SELECT provider_session_id FROM src.orchestration_v2_projection_provider_session_bindings
                                WHERE thread_id IN (SELECT thread_id FROM new_threads));
INSERT OR IGNORE INTO main.orchestration_v2_projection_context_transfers
  SELECT * FROM src.orchestration_v2_projection_context_transfers
  WHERE target_thread_id IN (SELECT thread_id FROM new_threads);
SELECT (SELECT COUNT(*) FROM new_threads) || ' chats, ' || (SELECT COUNT(*) FROM new_projects) || ' projects';
COMMIT;"

new=$(sqlite3 -readonly "$target" "ATTACH DATABASE '$db' AS src;
  SELECT COUNT(*) FROM src.orchestration_v2_projection_threads $new_where")
if [ "$new" = 0 ]; then
  say "OminaX has every T3 Code chat that is not active or usage-limited; nothing to add."
  rm -rf "$STAGE"
  exit 0
fi

# Files are copied before the stop, so a missing folder or full disk can't leave the unit down.
for dir in attachments browser-artifacts; do
  mkdir -p "$LEARN/userdata/$dir"
  [ ! -d "$SOURCE/userdata/$dir" ] || cp -a "$SOURCE/userdata/$dir/." "$LEARN/userdata/$dir/"
done
[ -e "$LEARN/userdata/settings.json" ] || cp "$STAGE/userdata/settings.json" "$LEARN/userdata/settings.json"

# Stopping cuts off whatever OminaX is running, including idle agents, so a busy OminaX waits for the next run.
# Not provider_threads: a row can stay 'active' long after its run was cancelled.
busy=$(count "$target" "SELECT
  (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting'))
+ (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending')")
cgroup=$(systemctl --user show -p ControlGroup --value "$UNIT")
[ -z "$cgroup" ] || busy=$((busy + $(live_agents "/sys/fs/cgroup$cgroup")))
if [ "$busy" != 0 ]; then
  say "OminaX has $busy item(s) running; nothing added. Run again when it is idle."
  rm -rf "$STAGE"
  exit 0
fi

say "Adding new chats to $UNIT..."
trap 'systemctl --user start "$UNIT"' EXIT
systemctl --user stop "$UNIT"
added=$(sqlite3 -bail "$target" "$merge_sql")
trap - EXIT
systemctl --user start "$UNIT"
rm -rf "$STAGE"
say "Done. Added $added. $UNIT is $(systemctl --user is-active "$UNIT")."
