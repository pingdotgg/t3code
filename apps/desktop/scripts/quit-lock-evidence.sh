#!/usr/bin/env bash
# Runtime evidence for desktop quit releasing the backend's single-writer lock
# (<T3CODE_HOME>/userdata/server-owner.sqlite) before Electron exits.
#
# Usage: apps/desktop/scripts/quit-lock-evidence.sh <checkout> <fixture> <run-dir>
#   checkout  repo root with `vp run build:desktop` done (apps/server/dist + apps/desktop/dist-electron)
#   fixture   F1  SIGTERM to the Electron main process, idle backend
#             F2  UI quit: window.close() over CDP (window-all-closed -> app.quit)
#             F3  backend SIGSTOPped (ignores SIGTERM), then SIGTERM to Electron
#             F4  backend SIGSTOPped, SIGTERM to Electron, SIGCONT after $F4_DELAY (3s)
#             F12 backend SIGKILLed before quit, then SIGTERM to Electron
#   run-dir   fresh directory for the isolated T3CODE_HOME and XDG dirs (never ~/.t3)
#
# Needs headless-desktop (xvfb-run + dbus + keyring), lsof, fuser, node >= 22 (node:sqlite).
# After Electron exits it records the lock holders, a BEGIN EXCLUSIVE probe, and then
# relaunches on the same home to check the new backend acquires the lock. It only signals
# PIDs it spawned or found under its own wrapper whose environ has this run's T3CODE_HOME.
set -uo pipefail

CHECKOUT=$(cd "${1:?checkout}" && pwd)
FIXTURE=${2:?fixture}
RUN=$(mkdir -p "${3:?run-dir}" && cd "$3" && pwd)
F4_DELAY=${F4_DELAY:-3}
CDP_PORT=${CDP_PORT:-9333}
H=$RUN/home
L=$H/userdata/server-owner.sqlite
RT=$H/userdata/server-runtime.json
DESKTOP=$CHECKOUT/apps/desktop
ELECTRON=$(realpath "$DESKTOP/node_modules/electron/dist/electron")
SEEN_PIDS=()

mkdir -p "$RUN"
[ -z "$(ls -A "$RUN" 2>/dev/null)" ] || { echo "run-dir must be empty: $RUN" >&2; exit 2; }
mkdir -p "$H" "$RUN/xdg/config" "$RUN/xdg/data"

ts() { date +%T.%N; }
log() { echo "[$(ts)] $*"; }
now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3fs", b-a}'; }

descendants() {
  ps -e -o pid=,ppid= | awk -v root="$1" '
    { kids[$2]=kids[$2] " " $1 }
    END { q=root; while (q != "") { split(q, a, " "); q=""; for (i in a) { n=split(kids[a[i]], k, " "); for (j=1;j<=n;j++) { print k[j]; q=q " " k[j] } } } }'
}

home_of() { tr '\0' '\n' 2>/dev/null < "/proc/$1/environ" | sed -n 's/^T3CODE_HOME=//p'; }
ours() { [ "$(home_of "$1")" = "$H" ]; }

# Process table: everything under the wrapper plus every member of the backend group.
ptable() {
  local pids
  pids=$( { descendants "$WRAPPER"; [ -n "${BACKEND_PGID:-}" ] && ps -e -o pid=,pgid= | awk -v g="$BACKEND_PGID" '$2==g{print $1}'; } | sort -un | paste -sd, -)
  [ -n "$pids" ] || { echo "    (no processes)"; return; }
  # args reads /proc/<pid>/cmdline, which can stall behind a process in D state on a loaded box.
  timeout 5 ps -o pid,ppid,pgid,stat,etime,args -p "$pids" | cut -c1-200 | sed 's/^/    /'
}

lockstate() {
  log "lsof $L:"; lsof "$L" 2>/dev/null | cut -c1-160 | sed 's/^/    /' || true
  log "fuser:"; fuser -v "$L" 2>&1 | sed 's/^/    /' || true
  log "P1 probe: $(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);
try{d.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");d.exec("ROLLBACK");console.log("LOCK FREE")}
catch(e){console.log("LOCK HELD: "+e.message)}' "$L")"
  log "server-runtime.json: $(cat "$RT" 2>/dev/null || echo '(absent)')"
}

launch() { # $1 = label
  local extra=()
  [ "$FIXTURE" = F2 ] && [ "$1" = primary ] && extra=(--remote-debugging-port="$CDP_PORT")
  (cd "$DESKTOP" && exec env -u VITE_DEV_SERVER_URL -u ELECTRON_RUN_AS_NODE -u T3CODE_PORT \
    T3CODE_HOME="$H" XDG_CONFIG_HOME="$RUN/xdg/config" XDG_DATA_HOME="$RUN/xdg/data" \
    T3CODE_DISABLE_AUTO_UPDATE=1 ELECTRON_ENABLE_LOGGING=1 \
    headless-desktop "$ELECTRON" --no-sandbox --disable-gpu "${extra[@]}" dist-electron/boot.cjs \
    > "$RUN/$1-stdout.log" 2>&1) &
  WRAPPER=$!
  MAIN=""; BACKEND=""; BACKEND_PGID=""
  log "[$1] spawned wrapper pid=$WRAPPER"
  local i p
  for i in $(seq 1 120); do
    for p in $(descendants "$WRAPPER"); do
      local args; args=$(tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline")
      case "$args" in
        "$ELECTRON "*boot.cjs*) [[ "$args" == *--type=* ]] || MAIN=$p ;;
        *apps/server/dist/bin.mjs*) ours "$p" && BACKEND=$p ;;
      esac
    done
    [ -n "$MAIN" ] && [ -n "$BACKEND" ] && lsof -t "$L" 2>/dev/null | grep -qx "$BACKEND" && break
    sleep 0.5
  done
  [ -n "$BACKEND" ] && ! lsof -t "$L" 2>/dev/null | grep -qx "$BACKEND" && { log "[$1] backend $BACKEND never acquired the lock (holders: $(lsof -t "$L" 2>/dev/null | paste -sd, -))"; return 1; }
  if [ -z "$MAIN" ] || [ -z "$BACKEND" ]; then log "[$1] FAILED to find main=$MAIN backend=$BACKEND"; return 1; fi
  BACKEND_PGID=$(ps -o pgid= -p "$BACKEND" | tr -d ' ')
  BACKEND_PGID=$(ps -o pgid= -p "$BACKEND" | tr -d ' ')
  SEEN_PIDS+=("$BACKEND")
  log "[$1] electron main pid=$MAIN pgid=$(ps -o pgid= -p "$MAIN" | tr -d ' ') backend pid=$BACKEND pgid=$BACKEND_PGID T3CODE_HOME=$(home_of "$BACKEND")"
}

wait_main_exit() { # samples the table every 0.5s until the Electron main process is gone
  local i=0
  while kill -0 "$MAIN" 2>/dev/null; do
    if (( i % 5 == 0 )); then log "sample (main alive):"; ptable; fi
    i=$((i+1)); sleep 0.1
  done
}

relaunch_check() {
  local old_owner; old_owner=$(sed -n 's/.*"ownerId":"\([^"]*\)".*/\1/p' "$RT" 2>/dev/null)
  log "P2 relaunch on the same home (previous ownerId=${old_owner:-none})"
  rm -f "$RUN/relaunch.ok"
  if launch relaunch; then
    local owner; owner=$(sed -n 's/.*"ownerId":"\([^"]*\)".*/\1/p' "$RT")
    log "P2 relaunch: backend pid=$BACKEND holds lock: $(lsof -t "$L" 2>/dev/null | paste -sd, -) ownerId=$owner"
  else
    log "P2 relaunch: no backend acquired the lock within 60s"
  fi
  log "P2 'already running' lines in relaunch logs: $(grep -ci 'already running\|ServerAlreadyRunning' "$RUN/relaunch-stdout.log" "$H/userdata/logs/server.trace.ndjson" 2>/dev/null | paste -sd' ' -)"
  grep -i 'already running\|ServerAlreadyRunning' "$RUN/relaunch-stdout.log" 2>/dev/null | head -3 | cut -c1-240 | sed 's/^/    /'
  if [ -n "$MAIN" ]; then
    log "stopping relaunch: SIGTERM electron main $MAIN"; kill -TERM "$MAIN"
    wait_main_exit; wait "$WRAPPER" 2>/dev/null
    log "relaunch exited"; lockstate
  else
    kill -TERM "$WRAPPER" 2>/dev/null; wait "$WRAPPER" 2>/dev/null
  fi
}

cleanup_orphans() {
  local p
  for p in "${SEEN_PIDS[@]}"; do
    if kill -0 "$p" 2>/dev/null && ours "$p"; then
      log "CLEANUP: captured backend pid=$p still alive ($(ps -o stat=,ppid= -p "$p")); SIGCONT+SIGKILL"
      kill -CONT "$p"; kill -KILL "$p"
    fi
  done
  sleep 0.5
  local leftover
  # Electron's setproctitle clobbers its own /proc/<pid>/environ, so also list the wrapper's tree.
  leftover=$( { descendants "$WRAPPER"; for p in /proc/[0-9]*; do [ "$(home_of "${p#/proc/}")" = "$H" ] && echo "${p#/proc/}"; done; } | sort -un | paste -sd, -)
  log "leftover processes with T3CODE_HOME=$H: ${leftover:-none}"
}

cdp_close() {
  node -e '
const port = process.argv[1];
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  console.log("CDP page:", page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.close()" } }));
  ws.onmessage = () => { console.log("CDP window.close() sent"); process.exit(0); };
  ws.onclose = () => { console.log("CDP socket closed"); process.exit(0); };
  setTimeout(() => process.exit(0), 3000);
})();' "$CDP_PORT"
}

echo "fixture=$FIXTURE checkout=$CHECKOUT head=$(git -C "$CHECKOUT" rev-parse HEAD) run=$RUN"
echo "host=$(hostname) kernel=$(uname -r) node=$(node -v) electron=v$(cat "$(dirname "$ELECTRON")/version") cpus=$(nproc)"
launch primary || { [ -n "$MAIN" ] && kill -TERM "$MAIN"; sleep 20; cleanup_orphans; exit 1; }
[ -n "${SCREENSHOT:-}" ] && {
  sleep 4
  # Electron's environ is clobbered, so take the display and auth file from Xvfb's argv.
  xvfb=$(for p in $(descendants "$WRAPPER"); do [ "$(cat /proc/$p/comm 2>/dev/null)" = Xvfb ] && tr '\0' ' ' < /proc/$p/cmdline; done)
  DISPLAY=$(awk '{print $2}' <<< "$xvfb") XAUTHORITY=$(sed -n 's/.*-auth \([^ ]*\).*/\1/p' <<< "$xvfb") \
    import -window root "$SCREENSHOT" && log "screenshot: $SCREENSHOT"
}
log "running state:"; ptable; lockstate

case "$FIXTURE" in
  F1) t0=$(now); log "QUIT: SIGTERM electron main $MAIN"; kill -TERM "$MAIN" ;;
  F2) t0=$(now); log "QUIT: CDP window.close()"; cdp_close 2>&1 | sed 's/^/    /' ;;
  F3) log "SIGSTOP backend $BACKEND"; kill -STOP "$BACKEND"; sleep 0.3
      t0=$(now); log "QUIT: SIGTERM electron main $MAIN"; kill -TERM "$MAIN" ;;
  F4) log "SIGSTOP backend $BACKEND"; kill -STOP "$BACKEND"; sleep 0.3
      t0=$(now); log "QUIT: SIGTERM electron main $MAIN"; kill -TERM "$MAIN"
      (sleep "$F4_DELAY"; log "SIGCONT backend $BACKEND (t0+${F4_DELAY}s)"; kill -CONT "$BACKEND") & ;;
  F12) log "SIGKILL backend $BACKEND before quit"; kill -KILL "$BACKEND"
       for _ in $(seq 1 40); do kill -0 "$BACKEND" 2>/dev/null || break; sleep 0.1; done
       sleep 2; log "after backend kill:"; ptable
       for p in $(descendants "$MAIN"); do
         [[ "$(tr '\0' ' ' 2>/dev/null < /proc/$p/cmdline)" == *apps/server/dist/bin.mjs* ]] && ours "$p" \
           && { log "backend respawned as pid=$p"; SEEN_PIDS+=("$p"); BACKEND_PGID=$(ps -o pgid= -p "$p" | tr -d ' '); }
       done
       t0=$(now); log "QUIT: SIGTERM electron main $MAIN"; kill -TERM "$MAIN" ;;
  *) echo "unknown fixture $FIXTURE" >&2; exit 2 ;;
esac

wait_main_exit
t1=$(now)
log "ELECTRON MAIN EXITED after $(elapsed "$t0" "$t1")"
log "table at electron exit:"; ptable
lockstate
wait "$WRAPPER" 2>/dev/null; wait
log "wrapper exited after $(elapsed "$t0" "$(now)")"
log "backend $BACKEND alive at wrapper exit: $(kill -0 "$BACKEND" 2>/dev/null && ps -o stat=,ppid= -p "$BACKEND" || echo no)"
log "desktop log quit lines:"
grep -iE 'before-quit|shutdown|exceeded|backend.*(exit|stop)|signal' "$RUN/primary-stdout.log" | tail -n 12 | cut -c1-200 | sed 's/^/    /'
relaunch_check
cleanup_orphans
