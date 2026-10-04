#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?Expected app bundle path}"
APP_BUNDLE_ID="${2:?Expected app bundle identifier}"

# Launch the exact installed bundle, then explicitly activate it. `open` can
# leave the app behind another window when invoked from the detached rebuild
# installer, so make foreground activation a separate Launch Services request.
open -a "$APP_PATH"
osascript -e "tell application id \"${APP_BUNDLE_ID}\" to activate"
