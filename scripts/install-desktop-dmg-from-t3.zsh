#!/bin/zsh
set -euo pipefail

readonly APP_PATH="/Applications/T3 Code (Alpha).app"
readonly BUNDLE_ID="com.t3tools.t3code"
readonly SCRIPT_PATH="${0:A}"

close_terminal_window() {
  local window_title="${1:?missing window title}"
  (
    sleep 0.75
    /usr/bin/osascript >/dev/null 2>&1 <<APPLESCRIPT || true
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t is "$window_title" then
        close w saving no
        return
      end if
    end repeat
  end repeat
end tell
APPLESCRIPT
  ) &
}

install_dmg() {
  local dmg="${1:?missing dmg path}"
  local window_title="${2:?missing window title}"
  local mount_dir
  mount_dir="$(mktemp -d /tmp/t3-code-dmg.XXXXXX)"

  cleanup() {
    hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
    rmdir "$mount_dir" >/dev/null 2>&1 || true
  }

  trap cleanup EXIT

  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 2

  hdiutil attach "$dmg" -nobrowse -quiet -mountpoint "$mount_dir"
  rm -rf -- "$APP_PATH"
  ditto "$mount_dir/T3 Code (Alpha).app" "$APP_PATH"

  cleanup
  trap - EXIT

  open -a "$APP_PATH"
  close_terminal_window "$window_title"
}

handoff_to_terminal() {
  local dmg="${1:?missing dmg path}"
  local launcher
  local window_title
  local self

  launcher="$(mktemp /tmp/t3-code-launch.XXXXXX.applescript)"
  window_title="T3-Code-Installer-$$-$(date +%s)"
  self="$SCRIPT_PATH"

  cat > "$launcher" <<'APPLESCRIPT'
on run argv
  set scriptPath to item 1 of argv
  set dmgPath to item 2 of argv
  set windowTitle to item 3 of argv

  tell application "Terminal"
    activate
    set installerTab to do script "/bin/zsh " & quoted form of scriptPath & " --install " & quoted form of dmgPath & " " & quoted form of windowTitle
    set custom title of installerTab to windowTitle
  end tell
end run
APPLESCRIPT

  /usr/bin/osascript "$launcher" "$self" "$dmg" "$window_title"
  rm -f -- "$launcher"
}

main() {
  if [[ "${1:-}" == "--install" ]]; then
    install_dmg "${2:?missing dmg path}" "${3:?missing window title}"
    return
  fi

  local dmg
  dmg="$(ls -t "$PWD"/release/T3-Code-*-arm64.dmg 2>/dev/null | head -1)" || true
  if [[ -z "$dmg" || ! -f "$dmg" ]]; then
    print -u2 "No arm64 T3 Code DMG found under $PWD/release"
    return 1
  fi

  handoff_to_terminal "$dmg"
}

main "$@"
