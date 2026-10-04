#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?Expected app bundle path}"
APP_BUNDLE_ID="${2:?Expected app bundle identifier}"

MAX_ATTEMPTS=50
RETRY_INTERVAL="${T3CODE_ACTIVATION_RETRY_INTERVAL:-0.2}"

open -a "$APP_PATH"

# `open` alone leaves the relaunched app behind other windows when it is run by
# the detached rebuild installer, so request activation explicitly. A freshly
# launched process rejects Apple events (-609 "Connection is invalid") until it
# registers with Launch Services, so retry instead of failing. Focus is a
# convenience: the app is already installed and running, so never fail the
# rebuild over it.
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if osascript -e "tell application id \"${APP_BUNDLE_ID}\" to activate" >/dev/null 2>&1; then
    exit 0
  fi
  sleep "$RETRY_INTERVAL"
done

echo "Could not bring ${APP_BUNDLE_ID} to the foreground; it was launched but is not focused." >&2
