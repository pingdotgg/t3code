#!/usr/bin/env bash
# Runs inside headless-desktop: records the display, then runs desktop dev in the given worktree.
set -u
WT="$1"; OUT="$2"
echo "export DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" > "$OUT/display.env"
cd "$WT"
export T3CODE_DEV_SEED=0 T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT="${CDP_PORT:-9333}"
exec vp run dev:desktop
