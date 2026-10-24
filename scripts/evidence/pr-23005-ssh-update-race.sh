#!/usr/bin/env bash
# Evidence driver for PR #23005 (issue #22990): runs the real SSH launch
# script against a throwaway HOME, with real servers, for one fixture row.
#
#   scripts/evidence/pr-23005-ssh-update-race.sh <checkout> <row> [workdir]
#
# <checkout> is the tree under test (before or after the fix); the launch
# script is generated from its own packages/ssh/src/tunnel.ts. Rows: F1 F2
# F2b F3 F3b F3c F4 F5 F6 F7 F8 F8-archive F8b desktop-warmup F13 F14.
# F8b also needs OLD_CHECKOUT=<pre-fix checkout> for the remote t3 that lacks
# update-remaining. F13/F14 run the dev desktop (`vp run dev:desktop`) under
# headless-desktop with --home-dir $FAKE/.t3 and an isolated
# XDG_CONFIG_HOME; run desktop-warmup first so the build does not eat the
# marker window. Stills land in $WORK/shots.
#
# The launcher's readiness probe wants GET / to answer 2xx, so the checkout
# needs apps/web/dist/index.html (a real web build or a one-line stub).
#
# Safety: every HOME is a fresh mktemp dir under the workdir, never the real
# one, and only PIDs recorded at spawn or in $FAKE/.t3/ssh-launch/k1/pid are
# killed.
set -euo pipefail

CO="$(cd "${1:?checkout}" && pwd)"
ROW="${2:?row}"
WORK="${3:-/tmp/ev-23005/driver}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE_VERSION="9.9.9"
MARKER_REL=".t3/runtime/desktop-update-in-progress"
mkdir -p "$WORK"
# Version-manager shims resolve node under $HOME; pin the real binary so the
# throwaway HOMEs do not each install a runtime.
PATH="$(dirname "$(node -p process.execPath)"):$PATH"
export PATH

ts() { date +%T.%3N; }
say() { printf '[%s] %s\n' "$(ts)" "$*"; }

capture_scripts() {
  local helper="$CO/packages/ssh/src/.ev-capture-launcher.ts"
  cat >"$helper" <<'EV_HELPER'
// @effect-diagnostics nodeBuiltinImport:off - Evidence helper; copied next to tunnel.ts in the checkout under test.
// Prints the exact launch script launchOrReuseRemoteServer sends over SSH.
// Uses only the public launchOrReuseRemoteServer so it runs unchanged on
// checkouts that predate launcherTestHarness.ts.
// Usage: node <checkout>/packages/ssh/src/<this file> <out.sh> node <bin.ts> | archive <version>
// Writes to a file because the Effect logger prints to stdout.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { launchOrReuseRemoteServer } from "./tunnel.ts";

const [out, mode, value] = process.argv.slice(2);
if (!out || (mode !== "node" && mode !== "archive") || !value) {
  console.error("usage: <out.sh> node <bin.ts> | archive <version>");
  process.exit(2);
}

let script = "";
const spawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    if (command._tag === "StandardCommand") {
      const stdin = command.options.stdin;
      if (typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)) {
        script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
      }
    }
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: Stream.make(new TextEncoder().encode('{"remotePort":3773}\n')),
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }),
);

await Effect.runPromise(
  launchOrReuseRemoteServer(
    { alias: "evidence", hostname: "evidence.invalid", username: null, port: null },
    undefined,
    mode === "node" ? { nodeScriptPath: value } : { archiveVersion: value },
  ).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  ),
);
NodeFS.writeFileSync(out, script);
EV_HELPER
  node "$helper" "$WORK/launch-node.sh" node "$CO/apps/server/src/bin.ts" >/dev/null 2>&1
  node "$helper" "$WORK/launch-archive.sh" archive "$ARCHIVE_VERSION" >/dev/null 2>&1
  rm -f "$helper"
}

STARTED_PIDS=()
FAKE=""
cleanup() {
  local pid
  if [ -n "$FAKE" ] && [ -f "$FAKE/.t3/ssh-launch/k1/pid" ]; then
    STARTED_PIDS+=("$(cat "$FAKE/.t3/ssh-launch/k1/pid")")
  fi
  if [ -n "${DESKTOP_PGID:-}" ]; then
    kill -TERM -- "-$DESKTOP_PGID" 2>/dev/null || true
    while kill -0 -- "-$DESKTOP_PGID" 2>/dev/null; do sleep 0.2; done
    DESKTOP_PGID=""
  fi
  for pid in "${STARTED_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${STARTED_PIDS[@]}"; do
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  done
  STARTED_PIDS=()
}
trap cleanup EXIT

new_home() {
  cleanup
  FAKE="$(mktemp -d "$WORK/home.XXXX")"
  mkdir -p "$FAKE/.t3/runtime"
  say "fresh HOME=$FAKE"
}

# write_marker <startedAt offset ms> <expiresAt offset ms> | write_raw <text>
write_marker() {
  node -e 'const n=Date.now();process.stdout.write(JSON.stringify({startedAt:n+Number(process.argv[1]),expiresAt:n+Number(process.argv[2])}))' \
    -- "$1" "$2" >"$FAKE/$MARKER_REL"
  say "marker written: $(cat "$FAKE/$MARKER_REL") (now=$(node -p 'Date.now()'))"
}
write_raw() {
  printf '%s' "$1" >"$FAKE/$MARKER_REL"
  say "marker written: $1"
}
show_marker() {
  if [ -e "$FAKE/$MARKER_REL" ]; then say "marker PRESENT: $(cat "$FAKE/$MARKER_REL")"; else say "marker ABSENT"; fi
}

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# Stands in for the updated desktop backend: a real server on the default home.
start_replacement() {
  local port
  port="$(free_port)"
  HOME="$FAKE" T3CODE_NO_BROWSER=1 nohup node "$CO/apps/server/src/bin.ts" serve \
    --host 127.0.0.1 --port "$port" --base-dir "$FAKE/.t3" >"$FAKE/replacement.log" 2>&1 </dev/null &
  REPLACEMENT_PID=$!
  STARTED_PIDS+=("$REPLACEMENT_PID")
  say "replacement server spawned pid=$REPLACEMENT_PID port=$port"
}
runtime_json() { tr -d '\n' <"$FAKE/.t3/userdata/server-runtime.json" 2>/dev/null | cut -c1-120; }
# The launcher's own server shares this base dir, so wait for the file to name
# the replacement's PID, not just to exist.
wait_runtime_file() {
  local i=0
  while ! grep -q "\"pid\":$REPLACEMENT_PID," "$FAKE/.t3/userdata/server-runtime.json" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 300 ]; then
      say "replacement did not publish server-runtime.json within 30 s; file now: $(runtime_json)"
      return 0
    fi
    sleep 0.1
  done
  say "replacement (pid $REPLACEMENT_PID) wrote server-runtime.json: $(runtime_json)"
}

seed_archive() {
  local bin="$1" dir="$FAKE/.t3/runtime/versions/$ARCHIVE_VERSION"
  mkdir -p "$dir"
  printf '#!/bin/sh\nexec node %s "$@"\n' "$bin" >"$dir/t3"
  chmod 755 "$dir/t3"
  printf '%s\n' "$ARCHIVE_VERSION" >"$dir/.install-complete"
  say "seeded archive runtime $ARCHIVE_VERSION -> node $bin"
}

LAUNCH_T0=0
launch_bg() {
  local mode="${1:-node}"
  LAUNCH_T0=$(date +%s%3N)
  say "launcher START ($mode mode)"
  (
    rc=0
    HOME="$FAKE" sh -l -s -- k1 <"$WORK/launch-$mode.sh" >"$FAKE/launch.out" 2>"$FAKE/launch.err" || rc=$?
    printf '%s %s %s\n' "$rc" "$(date +%s%3N)" "$(date +%T.%3N)" >"$FAKE/launch.end"
  ) &
  LAUNCH_PID=$!
}
launch_wait() {
  local rc end_ms end_ts
  wait "$LAUNCH_PID" || true
  read -r rc end_ms end_ts <"$FAKE/launch.end"
  say "launcher EXIT rc=$rc at $end_ts, $(( end_ms - LAUNCH_T0 )) ms after START; stdout: $(tail -n1 "$FAKE/launch.out")"
  if [ "$rc" -ne 0 ]; then say "launcher stderr: $(grep -v '[▀█▄]' "$FAKE/launch.err" | tail -n3 | tr '\n' ' ')"; fi
  report_servers
}
launch_fg() { launch_bg "${1:-node}"; launch_wait; }

report_servers() {
  local f="$FAKE/.t3/ssh-launch/k1"
  say "state: managed=$(cat "$f/managed" 2>/dev/null || echo -) pid=$(cat "$f/pid" 2>/dev/null || echo -) port=$(cat "$f/port" 2>/dev/null || echo -)"
  say "server processes on this HOME ($(ps -eo pid=,args= | grep -F -- "--base-dir $FAKE/.t3" | grep -v grep | wc -l)):"
  ps -eo pid=,args= | grep -F -- "--base-dir $FAKE/.t3" | grep -v grep | sed "s|^|    |" || true
  show_marker
}

# Starts the dev desktop with its data dir at $FAKE/.t3, in its own session
# so it stops by the process group captured here.
DESKTOP_PGID=""
start_desktop() {
  local cfg="$WORK/xdg-config"
  mkdir -p "$cfg" "$WORK/shots"
  rm -f "$WORK/display"
  ( cd "$CO" && XDG_CONFIG_HOME="$cfg" exec setsid headless-desktop bash -c \
      'printf "%s %s\n" "$DISPLAY" "$XAUTHORITY" >"$0"; exec vp run dev:desktop --home-dir "$1"' \
      "$WORK/display" "$FAKE/.t3" >"$FAKE/desktop.log" 2>&1 ) &
  DESKTOP_PGID=$!
  say "desktop spawned (pgid=$DESKTOP_PGID, --home-dir $FAKE/.t3, XDG_CONFIG_HOME=$cfg)"
  while [ ! -s "$WORK/display" ]; do sleep 0.2; done
}
shot() {
  local display xauth
  read -r display xauth <"$WORK/display"
  XAUTHORITY="$xauth" import -display "$display" -window root "$WORK/shots/$1.png" 2>/dev/null &&
    say "still: $WORK/shots/$1.png"
}
backend_log_lines() {
  grep -E 'backend start requested|Listening on|backend ready|main window created' "$FAKE/desktop.log" 2>/dev/null | sed 's/^/    /' || true
}
# Polls until the dev desktop's backend has written server-runtime.json and the
# window had a moment to paint, printing the marker state every 0.5 s.
watch_desktop() {
  local limit="$1" t0 n=0 ready_at=""
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "$limit" ]; do
    if [ -z "$ready_at" ] && [ -s "$FAKE/.t3/userdata/server-runtime.json" ]; then ready_at=$(date +%s); fi
    if [ -n "$ready_at" ] && [ $(( $(date +%s) - ready_at )) -ge 8 ]; then break; fi
    if [ $((n % 4)) -eq 0 ]; then
      say "poll: marker $([ -e "$FAKE/$MARKER_REL" ] && echo present || echo ABSENT); runtime.json $([ -s "$FAKE/.t3/userdata/server-runtime.json" ] && echo present || echo absent)"
    fi
    n=$((n + 1))
    sleep 0.5
  done
}

say "checkout=$CO head=$(git -C "$CO" rev-parse --short=10 HEAD) row=$ROW node=$(node -v) $(uname -sr)"
capture_scripts
say "launch scripts: node $(wc -l <"$WORK/launch-node.sh") lines, update_remaining refs: $(grep -c update_remaining "$WORK/launch-node.sh" || true)"

case "$ROW" in
  F1)
    new_home; show_marker; launch_fg node
    new_home; seed_archive "$CO/apps/server/src/bin.ts"; show_marker; launch_fg archive
    ;;
  F2)
    new_home; write_marker 0 60000
    launch_bg node
    sleep 8; say "8 s elapsed: desktop replacement backend comes up"
    start_replacement; wait_runtime_file
    launch_wait
    ;;
  F2b)
    new_home; write_marker 0 60000
    launch_bg node
    sleep 8; start_replacement; wait_runtime_file
    rm -f "$FAKE/$MARKER_REL"; say "backend ready: marker removed (as DesktopBackendPool onReady does)"
    launch_wait
    ;;
  F3)
    new_home; write_marker 0 60000
    launch_fg node
    ;;
  F3b)
    new_home; write_marker 0 1000
    launch_fg node
    ;;
  F3c)
    new_home; write_marker 0 600000
    launch_fg node
    ;;
  F4)
    new_home; write_marker -120000 -60000
    launch_fg node
    ;;
  F5)
    for variant in broken future empty numeric; do
      new_home
      case "$variant" in
        broken) write_raw 'broken' ;;
        future) write_marker 60000 120000 ;;
        empty) write_raw '{}' ;;
        numeric) write_raw '{"startedAt":"0","expiresAt":"99999999999999"}' ;;
      esac
      launch_fg node
    done
    ;;
  F6)
    new_home; start_replacement; wait_runtime_file; sleep 3
    write_marker 0 60000
    launch_fg node
    ;;
  F7)
    new_home; say "first launch: starts a managed server"; launch_fg node
    say "second launch, no marker: reuses the recorded managed server"; launch_fg node
    ;;
  F8)
    m="$WORK/m.json"
    for variant in fresh partial expired future malformed missing; do
      rm -f "$m"
      now=$(node -p 'Date.now()')
      case "$variant" in
        fresh) printf '{"startedAt":%s,"expiresAt":%s}' "$now" $((now + 60000)) >"$m" ;;
        partial) printf '{"startedAt":%s,"expiresAt":%s}' $((now - 45000)) $((now + 15000)) >"$m" ;;
        expired) printf '{"startedAt":%s,"expiresAt":%s}' $((now - 120000)) $((now - 60000)) >"$m" ;;
        future) printf '{"startedAt":%s,"expiresAt":%s}' $((now + 60000)) $((now + 120000)) >"$m" ;;
        malformed) printf 'broken' >"$m" ;;
        missing) : ;;
      esac
      say "variant=$variant marker=$(cat "$m" 2>/dev/null || echo '<none>')"
      rc=0; out=$(node "$CO/apps/server/src/bin.ts" __ssh-helper update-remaining "$m" 2>&1) || rc=$?
      say "  rc=$rc output=[$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)] file-after=$([ -e "$m" ] && echo present || echo absent)"
    done
    ;;
  F8-archive)
    new_home; seed_archive "$CO/apps/server/src/bin.ts"; write_marker 0 3000
    launch_fg archive
    ;;
  F8b)
    : "${OLD_CHECKOUT:?OLD_CHECKOUT must point at a pre-fix checkout}"
    new_home; seed_archive "$(cd "$OLD_CHECKOUT" && pwd)/apps/server/src/bin.ts"; write_marker 0 60000
    launch_fg archive
    ;;
  desktop-warmup)
    new_home; start_desktop
    while [ ! -s "$FAKE/.t3/userdata/server-runtime.json" ]; do sleep 1; done
    say "desktop backend wrote server-runtime.json; warm-up done"
    sleep 5; shot warmup
    ;;
  F13)
    new_home; write_marker 0 600000
    show_marker
    start_desktop
    watch_desktop 150
    shot F13
    say "desktop log lines about backend readiness:"; backend_log_lines
    show_marker
    ;;
  F14)
    new_home; write_marker 0 60000
    say "desktop backend is down for the update (marker written); remote client connects now"
    launch_bg node
    sleep 1; start_desktop
    launch_wait
    say "desktop runtime: $(tr -d '\n' <"$FAKE/.t3/userdata/server-runtime.json" 2>/dev/null | cut -c1-200)"
    sleep 5; shot F14
    say "desktop log lines about backend readiness:"; backend_log_lines
    ;;
  *)
    echo "unknown row $ROW" >&2; exit 2 ;;
esac
say "row $ROW done"
