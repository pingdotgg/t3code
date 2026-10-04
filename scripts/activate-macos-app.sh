#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?Expected app bundle path}"
APP_NAME="${2:?Expected app name}"

# Launch the exact installed bundle, then explicitly activate it. `open` can
# leave the app behind another window when invoked from the detached rebuild
# installer, so make foreground activation a separate Launch Services request.
open -a "$APP_PATH"
osascript -e "tell application \"${APP_NAME}\" to activate"
