#!/usr/bin/env bash
# Installs a T3 Learn release with its one-line installer on a macOS or Linux
# runner and checks that it runs next to (or without) T3 Code:
#   t3-learn-install-test.sh <fresh|next-to-t3-code|appimage> <version>
# Screenshots and logs land in $ARTIFACTS.
set -euo pipefail

scenario="$1"
version="$2"
repo="${GITHUB_REPOSITORY:-aabdel0181/t3-learn}"
artifacts="${ARTIFACTS:-$PWD/install-test}"
mkdir -p "$artifacts"
os="$(uname -s)"

log() { printf '\n== %s\n' "$*"; }
# `dpkg -s` also succeeds for a removed package that left its config behind.
installed() { dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}
# Keep the app's logs with the screenshots when anything fails.
trap 'status=$?; [ "$status" -eq 0 ] || cp -R "$HOME/.t3-learn/userdata/logs" "$artifacts/t3-learn-logs" 2>/dev/null || true' EXIT

screenshot() {
  if [ "$os" = Darwin ]; then
    screencapture -x "$artifacts/$1.png" || true
  else
    import -window root -display "$DISPLAY" "$artifacts/$1.png" 2>/dev/null || true
  fi
}

# Waits for the desktop app's server under a T3 home and prints its version.
wait_for_server() {
  local home="$1" state="$1/userdata/server-runtime.json" origin=""
  for _ in $(seq 1 180); do
    if [ -f "$state" ]; then
      origin="$(sed -n 's/.*"origin": *"\([^"]*\)".*/\1/p' "$state")"
      if [ -n "$origin" ] && curl -fsS "$origin/.well-known/t3/environment" -o /dev/null 2>/dev/null; then
        sed -n 's/.*"serverVersion": *"\([^"]*\)".*/\1/p' "$state"
        return 0
      fi
    fi
    sleep 1
  done
  ls -laR "$home" > "$artifacts/$(basename "$home")-tree.txt" 2>&1 || true
  fail "no server answered under $home"
}

if [ "$os" = Linux ]; then
  sudo apt-get update -q >/dev/null
  sudo apt-get install -y -q xvfb imagemagick >/dev/null
  Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
  export DISPLAY=:99
fi

t3code_version=""
if [ "$scenario" = next-to-t3-code ]; then
  log "Installing upstream T3 Code"
  if [ "$os" = Darwin ]; then
    # Homebrew refuses to run under Rosetta (Intel rows on an Apple silicon runner).
    if [ "$(sysctl -in sysctl.proc_translated)" = 1 ]; then arch -arm64 brew install --cask t3-code; else brew install --cask t3-code; fi
    t3code_app="$(ls -d /Applications/T3\ Code*.app | head -n 1)"
    # Gatekeeper's first-launch prompt would hold `open` on a CI runner.
    xattr -dr com.apple.quarantine "$t3code_app"
    open "$t3code_app"
  else
    arch="$(dpkg --print-architecture)"
    gh release download -R pingdotgg/t3code --pattern "T3-Code-*-${arch}.deb" --dir "$RUNNER_TEMP"
    sudo apt-get install -y -q "$RUNNER_TEMP"/T3-Code-*-"${arch}".deb >/dev/null
    nohup t3code >"$artifacts/t3code.log" 2>&1 &
  fi
  t3code_version="$(wait_for_server "$HOME/.t3")"
  log "T3 Code $t3code_version is running"
  screenshot t3-code
fi

log "Installing T3 Learn $version"
format=""
if [ "$scenario" = appimage ]; then format=appimage; fi
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" |
  env T3LEARN_VERSION="$version" T3LEARN_FORMAT="$format" sh 2>&1 | tee "$artifacts/install.log"

learn_version="$(wait_for_server "$HOME/.t3-learn")"
[ "$learn_version" = "$version" ] || fail "T3 Learn's server reports $learn_version, expected $version"
log "T3 Learn $learn_version is running"
sleep 5
screenshot t3-learn

if [ "$os" = Darwin ]; then
  app="/Applications/T3 Learn.app"
  [ -d "$app" ] || fail "$app is missing"
  codesign --verify --deep "$app" || fail "the installed app's signature does not verify"
  [ "$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier)" = io.github.aabdel0181.t3learn ] ||
    fail "unexpected bundle id"
elif [ "$scenario" = appimage ]; then
  [ -x "$HOME/.local/share/t3-learn/T3-Learn.AppImage" ] || fail "the AppImage is missing"
  grep -q '^Exec=' "$HOME/.local/share/applications/t3learn.desktop" || fail "no desktop entry"
  [ -s "$HOME/.local/share/icons/hicolor/512x512/apps/t3learn.png" ] || fail "no menu icon"
else
  installed t3learn || fail "the t3learn package is not installed"
fi

if [ "$os" = Darwin ] && [ "$scenario" = fresh ]; then
  # Squirrel cannot update an unsigned app, so T3 Learn swaps its own bundle.
  # A local feed offers this same build as a newer version.
  log "Updating T3 Learn in place"
  feed="$RUNNER_TEMP/feed"
  mkdir -p "$feed"
  zip_arch="$(uname -m | sed 's/x86_64/x64/')"
  gh release download "v$version" -R "$repo" -p latest-mac.yml -p "T3-Learn-$version-$zip_arch.zip" -D "$feed"
  next="$version.1"
  sed -i '' "s/^version: .*/version: $next/" "$feed/latest-mac.yml"
  # The app's mock feed is http://localhost, which can resolve to ::1 or 127.0.0.1.
  python3 -m http.server 8765 --bind :: --directory "$feed" >"$artifacts/feed.log" 2>&1 &
  osascript -e 'tell application id "io.github.aabdel0181.t3learn" to quit'
  while pgrep -f "/T3 Learn.app/Contents/MacOS/" >/dev/null; do sleep 1; done
  app="/Applications/T3 Learn.app"
  before="$(stat -f %i "$app")"
  node scripts/t3-learn-update-check.ts --executable "$app/Contents/MacOS/T3 Learn" \
    --feed-port 8765 --expect "$next"
  for _ in $(seq 1 120); do
    [ -d "$app" ] && [ "$(stat -f %i "$app")" != "$before" ] && break
    sleep 1
  done
  [ -d "$app" ] && [ "$(stat -f %i "$app")" != "$before" ] || fail "the app bundle was not replaced"
  # The instance that installed the update has quit, so a server now is the reopened app.
  wait_for_server "$HOME/.t3-learn" >/dev/null
  ls -d "/Applications/.t3-learn-update."* 2>/dev/null && fail "the update left its staging folder"
  codesign --verify --deep "$app" || fail "the updated app's signature does not verify"
  screenshot after-update
fi

if [ "$scenario" = next-to-t3-code ]; then
  log "Checking that T3 Code is untouched"
  [ "$(wait_for_server "$HOME/.t3")" = "$t3code_version" ] || fail "T3 Code's server changed"
  if grep -rlq "t3-learn\|t3learn" "$HOME/.t3/userdata"/*.json 2>/dev/null; then
    fail "T3 Learn wrote into T3 Code's data"
  fi
  if [ "$os" = Darwin ]; then
    [ -d "$t3code_app" ] || fail "T3 Code's app is gone"
  else
    installed t3code || fail "the t3code package is gone"
    [ "$(xdg-mime query default x-scheme-handler/t3code 2>/dev/null || true)" != io.github.aabdel0181.T3Learn.desktop ] ||
      fail "T3 Learn took over t3code:// links"
  fi
fi

log "Uninstalling T3 Learn"
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" | sh -s -- --uninstall
if [ "$os" = Darwin ]; then
  [ ! -d "/Applications/T3 Learn.app" ] || fail "the app is still installed"
elif [ "$scenario" = appimage ]; then
  [ ! -e "$HOME/.local/share/t3-learn/T3-Learn.AppImage" ] || fail "the AppImage is still installed"
else
  ! installed t3learn || fail "the t3learn package is still installed"
fi
[ -d "$HOME/.t3-learn/userdata" ] || fail "uninstall removed T3 Learn's data"
if [ "$scenario" = next-to-t3-code ]; then
  [ "$(wait_for_server "$HOME/.t3")" = "$t3code_version" ] || fail "T3 Code stopped after uninstalling T3 Learn"
fi
log "PASS"
