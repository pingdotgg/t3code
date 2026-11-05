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
  local home="$1" expected="${2:-}" state="$1/userdata/server-runtime.json" origin="" reported=""
  for _ in $(seq 1 180); do
    if [ -f "$state" ]; then
      origin="$(sed -n 's/.*"origin": *"\([^"]*\)".*/\1/p' "$state")"
      if [ -n "$origin" ] && curl -fsS "$origin/.well-known/t3/environment" -o /dev/null 2>/dev/null; then
        reported="$(sed -n 's/.*"serverVersion": *"\([^"]*\)".*/\1/p' "$state")"
        if [ -z "$expected" ] || [ "$reported" = "$expected" ]; then
          printf '%s\n' "$reported"
          return 0
        fi
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

previous=""
format=""
if [ "$scenario" = appimage ]; then format=appimage; fi
if [ "$scenario" = fresh ]; then
  previous="$(gh release view -R "$repo" --json tagName -q .tagName 2>/dev/null | sed 's/^v//' || true)"
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    log "Installing the previous release, $previous"
    # A leftover bundle from an earlier run on a reused Mac would be updated instead.
    if [ "$os" = Darwin ]; then rm -rf /Applications/OminaX.app "/Applications/T3 Learn.app"; fi
    curl -fsSL "https://github.com/$repo/releases/download/v$previous/install.sh" |
      env T3LEARN_VERSION="$previous" T3LEARN_FORMAT="$format" sh 2>&1 | tee "$artifacts/install-previous.log"
    previous_running="$(wait_for_server "$HOME/.t3-learn" "$previous")"
    log "The previous release, $previous_running, is running"
    knowledge="$HOME/.t3-learn/userdata/knowledge.json"
    printf '%s\n' '[{"topic":"install test","explanation":"kept across updates","buildsOn":[],"doneAt":"2026-11-05T00:00:00.000Z","threadId":"install-test"}]' >"$knowledge"
    cp "$knowledge" "$artifacts/knowledge.json"
    # The deb upgrade leaves the old app running, and the new one would lose the single-instance lock to it.
    if [ "$os" = Linux ]; then
      pkill -u "$(id -u)" -x t3learn || true
      while pgrep -u "$(id -u)" -x t3learn >/dev/null; do sleep 1; done
    fi
  else
    log "No distinct previous promoted release; installing OminaX $version fresh"
  fi
fi

if [ "$os" = Darwin ] && [ "$scenario" = fresh ] && [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  log "Updating OminaX in place to $version"
  feed="$RUNNER_TEMP/feed"
  mkdir -p "$feed"
  zip_arch="$(uname -m | sed 's/x86_64/x64/')"
  gh release download "v$version" -R "$repo" -p latest-mac.yml -p "OminaX-$version-$zip_arch.zip" -D "$feed"
  python3 -m http.server 8765 --bind :: --directory "$feed" >"$artifacts/feed.log" 2>&1 &
  osascript -e 'tell application id "io.github.aabdel0181.t3learn" to quit'
  while pgrep -f "/(OminaX|T3 Learn)\.app/Contents/MacOS/" >/dev/null; do sleep 1; done
  app=""
  for candidate in /Applications/OminaX.app /Applications/T3\ Learn.app; do
    if [ -d "$candidate" ]; then app="$candidate"; break; fi
  done
  [ -n "$app" ] || fail "the installed OminaX app bundle is missing"
  before="$(stat -f %i "$app")"
  executable="$(defaults read "$app/Contents/Info.plist" CFBundleExecutable)"
  node scripts/t3-learn-update-check.ts --executable "$app/Contents/MacOS/$executable" \
    --feed-port 8765 --expect "$version"
  for _ in $(seq 1 120); do
    [ -d "$app" ] && [ "$(stat -f %i "$app")" != "$before" ] && break
    sleep 1
  done
  [ -d "$app" ] && [ "$(stat -f %i "$app")" != "$before" ] || fail "the app bundle was not replaced"
  wait_for_server "$HOME/.t3-learn" "$version" >/dev/null
  ls -d "/Applications/.t3-learn-update."* 2>/dev/null && fail "the update left its staging folder"
  codesign --verify --deep "$app" || fail "the updated app's signature does not verify"
  screenshot after-update
  cmp -s "$knowledge" "$artifacts/knowledge.json" || fail "the update changed or removed knowledge.json"
fi

log "Installing OminaX $version"
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" |
  env T3LEARN_VERSION="$version" T3LEARN_FORMAT="$format" sh 2>&1 | tee "$artifacts/install.log"

learn_version="$(wait_for_server "$HOME/.t3-learn" "$version")"
log "OminaX $learn_version is running"
sleep 5
screenshot t3-learn
# What you know (knowledge.json) must survive updates and uninstalls like the database.
knowledge="$HOME/.t3-learn/userdata/knowledge.json"
if [ ! -f "$artifacts/knowledge.json" ]; then
  printf '%s\n' '[{"topic":"install test","explanation":"kept across updates","buildsOn":[],"doneAt":"2026-11-05T00:00:00.000Z","threadId":"install-test"}]' >"$knowledge"
  cp "$knowledge" "$artifacts/knowledge.json"
fi

if [ "$os" = Darwin ]; then
  app="/Applications/OminaX.app"
  [ -d "$app" ] || fail "$app is missing"
  [ ! -d "/Applications/T3 Learn.app" ] || fail "the old T3 Learn app bundle is still installed"
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

if [ "$scenario" = next-to-t3-code ]; then
  log "Checking that T3 Code is untouched"
  [ "$(wait_for_server "$HOME/.t3" "$t3code_version")" = "$t3code_version" ] || fail "T3 Code's server changed"
  if grep -rlq "t3-learn\|t3learn" "$HOME/.t3/userdata"/*.json 2>/dev/null; then
    fail "OminaX wrote into T3 Code's data"
  fi
  if [ "$os" = Darwin ]; then
    [ -d "$t3code_app" ] || fail "T3 Code's app is gone"
  else
    installed t3code || fail "the t3code package is gone"
    [ "$(xdg-mime query default x-scheme-handler/t3code 2>/dev/null || true)" != io.github.aabdel0181.T3Learn.desktop ] ||
      fail "OminaX took over t3code:// links"
  fi
fi

log "Uninstalling OminaX"
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" | sh -s -- --uninstall
if [ "$os" = Darwin ]; then
  [ ! -d "/Applications/OminaX.app" ] || fail "the OminaX app is still installed"
  [ ! -d "/Applications/T3 Learn.app" ] || fail "the old T3 Learn app is still installed"
elif [ "$scenario" = appimage ]; then
  [ ! -e "$HOME/.local/share/t3-learn/T3-Learn.AppImage" ] || fail "the AppImage is still installed"
else
  ! installed t3learn || fail "the t3learn package is still installed"
fi
[ -d "$HOME/.t3-learn/userdata" ] || fail "uninstall removed OminaX's data"
cmp -s "$knowledge" "$artifacts/knowledge.json" || fail "uninstall changed or removed knowledge.json"
if [ "$scenario" = next-to-t3-code ]; then
  [ "$(wait_for_server "$HOME/.t3" "$t3code_version")" = "$t3code_version" ] || fail "T3 Code stopped after uninstalling OminaX"
fi
log "PASS"
