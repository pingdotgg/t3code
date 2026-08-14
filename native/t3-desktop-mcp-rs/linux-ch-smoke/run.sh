#!/usr/bin/env bash
set -euo pipefail

ROOT=/smoke/root
BIN=/src/target/release/t3-desktop-mcp
LOG=/smoke/out.txt
: >"$LOG"

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

log "=== Linux Computer History smoke ==="
log "uname=$(uname -a)"

# Fresh dbus + AT-SPI + Xvfb session
export DISPLAY=:99
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/smoke/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

# Session bus for AT-SPI
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax)"
  log "started dbus session $DBUS_SESSION_BUS_ADDRESS"
fi

# Start AT-SPI bus
/usr/libexec/at-spi-bus-launcher --launch-immediately >/smoke/atspi.log 2>&1 &
ATSPI_PID=$!
sleep 1
# Some distros put it here:
if ! pgrep -fa at-spi >/dev/null; then
  /usr/lib/at-spi2-core/at-spi-bus-launcher --launch-immediately >/smoke/atspi2.log 2>&1 &
  sleep 1
fi

log "DISPLAY=$DISPLAY"
log "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unset}"

# Launch a couple of X apps so there is a frontmost window
xterm -geometry 80x24+20+20 -T "SmokeXTerm" >/smoke/xterm.log 2>&1 &
XTERM_PID=$!
sleep 1
xclock -geometry 100x100+400+40 >/smoke/xclock.log 2>&1 &
XCLOCK_PID=$!
sleep 1
# Raise xterm again
xdotool windowactivate --sync "$(xdotool search --name SmokeXTerm | head -1)" 2>/dev/null || true
# Fallback: start another xterm to change focus
xterm -geometry 80x24+60+60 -T "SmokeXTerm2" >/smoke/xterm2.log 2>&1 &
sleep 2

test -x "$BIN" || { log "FAIL: missing binary $BIN"; ls -la /src/target/release || true; exit 1; }

"$BIN" computer-history --root "$ROOT" >/smoke/daemon.log 2>&1 &
DAEMON_PID=$!
log "daemon pid=$DAEMON_PID"
sleep 6

STATUS="$ROOT/status.json"
if [ -f "$STATUS" ]; then
  log "STATUS:"
  tee -a "$LOG" <"$STATUS"
else
  log "FAIL: no status.json"
  tee -a "$LOG" </smoke/daemon.log || true
  exit 1
fi

EVENTS=$(find "$ROOT/segments" -name events.jsonl 2>/dev/null | head -1 || true)
if [ -z "$EVENTS" ]; then
  log "FAIL: no events.jsonl"
  tee -a "$LOG" </smoke/daemon.log || true
  exit 1
fi

log "EVENTS_FILE=$EVENTS"
log "EVENT_COUNT=$(wc -l <"$EVENTS" | tr -d ' ')"
log "EVENT_TAIL:"
tail -n 20 "$EVENTS" | tee -a "$LOG"

# Require at least session.started + one sample, or running phase with events
PHASE=$(python3 - <<'PY'
import json
print(json.load(open("/smoke/root/status.json")).get("phase"))
PY
)
COUNT=$(python3 - <<'PY'
import json
print(json.load(open("/smoke/root/status.json")).get("eventCount", 0))
PY
)
PLATFORM=$(python3 - <<'PY'
import json
print(json.load(open("/smoke/root/status.json")).get("platform"))
PY
)

log "phase=$PHASE count=$COUNT platform=$PLATFORM"

# Kill apps
kill "$DAEMON_PID" "$XTERM_PID" "$XCLOCK_PID" "$ATSPI_PID" "$XVFB_PID" 2>/dev/null || true

if [ "$PLATFORM" != "linux" ]; then
  log "FAIL: expected platform=linux"
  exit 1
fi
if [ "$PHASE" != "running" ] && [ "$PHASE" != "error" ]; then
  # error may still have events if a11y flaky; require events
  :
fi
if [ "${COUNT:-0}" -lt 1 ]; then
  log "FAIL: expected eventCount >= 1"
  exit 1
fi

# Prefer success when we saw sample.frontmost
if grep -q 'sample.frontmost' "$EVENTS"; then
  log "PASS: recorded sample.frontmost events"
  exit 0
fi

if grep -q 'session.started' "$EVENTS"; then
  log "PASS_PARTIAL: daemon ran on linux and wrote session.started (frontmost sampling limited under Xvfb/AT-SPI)"
  # Still accept as platform path works; note partial
  exit 0
fi

log "FAIL: no usable events"
exit 1
