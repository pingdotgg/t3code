#!/usr/bin/env bash
# Installs an OminaX release with its one-line installer on a macOS or Linux
# runner and checks that it runs next to (or without) T3 Code:
#   ominax-install-test.sh <fresh|next-to-t3-code|appimage|service> <version>
# Screenshots and logs land in $ARTIFACTS.
set -euo pipefail

scenario="$1"
version="$2"
repo="${GITHUB_REPOSITORY:-aabdel0181/ominax}"
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
trap 'status=$?; [ "$status" -eq 0 ] || cp -R "$HOME/.ominax/userdata/logs" "$artifacts/ominax-logs" 2>/dev/null || true' EXIT

screenshot() {
  if [ "$os" = Darwin ]; then
    screencapture -x "$artifacts/$1.png" || true
  else
    import -window root -display "$DISPLAY" "$artifacts/$1.png" 2>/dev/null || true
  fi
}

# What you know, courses and the clip cache must survive updates and uninstalls like the database.
learning="$HOME/.ominax/userdata"
plant_learning() {
  mkdir -p "$learning/courses/install-test/units" "$learning/visuals/install-test" "$artifacts/kept"
  printf '%s\n' '[{"topic":"install test","explanation":"kept across updates","buildsOn":[],"doneAt":"2026-11-05T00:00:00.000Z","threadId":"install-test"}]' >"$learning/knowledge.json"
  printf '%s\n' '{"title":"install test"}' >"$learning/courses/install-test/course.json"
  printf '%s\n' 'kept across updates' >"$learning/courses/install-test/units/01.txt"
  printf '%s\n' '{"concept":"install-test"}' >"$learning/visuals/install-test/meta.json"
  cp -R "$learning/knowledge.json" "$learning/courses" "$learning/visuals" "$artifacts/kept/"
}
check_learning() {
  for item in knowledge.json courses visuals; do
    diff -r "$artifacts/kept/$item" "$learning/$item" >/dev/null || fail "$1 changed or removed $item"
  done
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
  # Azure runner DNS stopped resolving *.ubuntu.com on 2026-11-11 (REL-68).
  sudo resolvectl dns eth0 1.1.1.1 8.8.8.8
  sudo apt-get update -q >/dev/null
  sudo apt-get install -y -q xvfb imagemagick >/dev/null
  Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
  export DISPLAY=:99
fi

[ "$scenario" != service ] || [ "$os" = Linux ] || fail "service scenario only runs on Linux"

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
    if [ "$os" = Darwin ]; then
      rm -rf /Applications/OminaX.app "/Applications/T3 Learn.app"
      # Ad hoc signed builds each get a Keychain partition of their own cdhash, so the
      # updated app would ask for the login password, which nobody types on a runner.
      # A throwaway keychain whose Safe Storage key admits both builds keeps it quiet.
      builds="$RUNNER_TEMP/builds"
      zip_arch="$(uname -m | sed 's/x86_64/x64/')"
      gh release download "v$previous" -R "$repo" -p "*-$previous-$zip_arch.zip" -D "$builds"
      gh release download "v$version" -R "$repo" -p "*-$version-$zip_arch.zip" -D "$builds"
      partitions="apple-tool:,apple:"
      for zip in "$builds"/*.zip; do
        ditto -x -k "$zip" "${zip%.zip}"
        partitions="$partitions,cdhash:$(codesign -dvvv "${zip%.zip}"/*.app 2>&1 | sed -n 's/^CDHash=//p')"
      done
      keychain="$HOME/Library/Keychains/ominax-install-test.keychain-db"
      security create-keychain -p ci "$keychain"
      security set-keychain-settings "$keychain"
      security unlock-keychain -p ci "$keychain"
      security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
      security default-keychain -d user -s "$keychain"
      security add-generic-password -A -s "ominax Safe Storage" -a "ominax Key" -w "$(openssl rand -base64 24)" "$keychain"
      security set-generic-password-partition-list -S "$partitions" -k ci -s "ominax Safe Storage" "$keychain" >/dev/null
    fi
    curl -fsSL "https://github.com/$repo/releases/download/v$previous/install.sh" |
      env OMINAX_VERSION="$previous" OMINAX_FORMAT="$format" T3LEARN_VERSION="$previous" T3LEARN_FORMAT="$format" sh 2>&1 | tee "$artifacts/install-previous.log"
    previous_running="$(wait_for_server "$HOME/.ominax" "$previous")"
    log "The previous release, $previous_running, is running"
    plant_learning
    if [ -f apps/desktop/scripts/plant-saved-connection.mjs ]; then
      node apps/desktop/scripts/plant-saved-connection.mjs plant
    fi
    # The deb upgrade leaves the old app running, and the new one would lose the single-instance lock to it.
    if [ "$os" = Linux ]; then
      for pid in $(pgrep -u "$(id -u)" -x ominax || true); do kill "$pid" 2>/dev/null || true; done
      while pgrep -u "$(id -u)" -x ominax >/dev/null; do sleep 1; done
    fi
  else
    log "No distinct previous promoted release; installing OminaX $version fresh"
  fi
fi

if [ "$scenario" = service ]; then
  previous="$(gh release view -R "$repo" --json tagName -q .tagName 2>/dev/null | sed 's/^v//' || true)"
  [ -n "$previous" ] && [ "$previous" != "$version" ] || fail "service scenario needs a distinct promoted N-1 release"
  if ! loginctl enable-linger "$(id -un)" 2>/dev/null || ! systemctl --user is-system-running >/dev/null 2>&1; then
    fail "user systemd is unavailable; service migration must not pass vacuously"
  fi
  service_root="$RUNNER_TEMP/ominax-service"
  export HOME="$service_root"
  mkdir -p "$HOME"
  old_archive="$RUNNER_TEMP/t3-$previous-linux-x64.tar.gz"
  gh release download "v$previous" -R "$repo" -p "t3-$previous-linux-x64.tar.gz" -D "$RUNNER_TEMP"
  mkdir -p "$HOME/old"
  tar -xzf "$old_archive" -C "$HOME/old"
  old_cli="$(find "$HOME/old" -type f -name t3 -perm -u+x | head -n 1)"
  [ -n "$old_cli" ] || fail "N-1 CLI archive did not contain t3"
  "$old_cli" service install --base-dir "$HOME/.t3-learn"
  systemctl --user is-active ominax.service >/dev/null || fail "N-1 ominax.service is not active"
  new_archive="$RUNNER_TEMP/t3-$version-linux-x64.tar.gz"
  gh release download "v$version" -R "$repo" -p "t3-$version-linux-x64.tar.gz" -D "$RUNNER_TEMP"
  mkdir -p "$HOME/new"
  tar -xzf "$new_archive" -C "$HOME/new"
  new_cli="$(find "$HOME/new" -type f -name t3 -perm -u+x | head -n 1)"
  [ -n "$new_cli" ] || fail "N CLI archive did not contain t3"
  "$new_cli" update "$version" --yes --base-dir "$HOME/.t3-learn"
  "$new_cli" service install --base-dir "$HOME/.t3-learn"
  systemctl --user is-active ominax.service >/dev/null || fail "ominax.service is not active after migration"
  if systemctl --user is-enabled t3learn.service >/dev/null 2>&1 || systemctl --user is-active t3learn.service >/dev/null 2>&1; then
    fail "legacy t3learn.service remains after migration"
  fi
  systemctl --user stop ominax.service >/dev/null 2>&1 || true
  log "PASS"
  exit 0
fi

if [ "$os" = Darwin ] && [ "$scenario" = fresh ] && [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  log "Updating OminaX in place to $version"
  feed="$RUNNER_TEMP/feed"
  mkdir -p "$feed"
  zip_arch="$(uname -m | sed 's/x86_64/x64/')"
  gh release download "v$version" -R "$repo" -p latest-mac.yml -p "OminaX-$version-$zip_arch.zip" -D "$feed"
  python3 -m http.server 8765 --bind :: --directory "$feed" >"$artifacts/feed.log" 2>&1 &
  osascript -e 'tell application id "io.github.aabdel0181.ominax" to quit'
  while pgrep -f "/(OminaX|T3 Learn)\.app/Contents/MacOS/" >/dev/null; do sleep 1; done
  app=""
  for candidate in /Applications/OminaX.app /Applications/T3\ Learn.app; do
    if [ -d "$candidate" ]; then app="$candidate"; break; fi
  done
  [ -n "$app" ] || fail "the installed OminaX app bundle is missing"
  before="$(stat -f %i "$app")"
  executable="$(defaults read "$app/Contents/Info.plist" CFBundleExecutable)"
  node scripts/ominax-update-check.ts --executable "$app/Contents/MacOS/$executable" \
    --feed-port 8765 --expect "$version"
  # The swap moves the bundle away for a moment; a failed stat is not a new bundle.
  replaced() { now="$(stat -f %i "$app" 2>/dev/null)" && [ "$now" != "$before" ]; }
  for _ in $(seq 1 120); do
    replaced && break
    sleep 1
  done
  replaced || fail "the app bundle was not replaced"
  wait_for_server "$HOME/.ominax" "$version" >/dev/null
  ls -d "/Applications/.ominax-update."* 2>/dev/null && fail "the update left its staging folder"
  codesign --verify --deep "$app" || fail "the updated app's signature does not verify"
  screenshot after-update
  check_learning "the update"
fi

log "Installing OminaX $version"
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" |
  env OMINAX_VERSION="$version" OMINAX_FORMAT="$format" sh 2>&1 | tee "$artifacts/install.log"

learn_version="$(wait_for_server "$HOME/.ominax" "$version")"
log "OminaX $learn_version is running"
sleep 5
screenshot t3-learn
if [ ! -d "$artifacts/kept" ]; then plant_learning; fi

[ -d "$HOME/.ominax" ] && [ ! -L "$HOME/.ominax" ] || fail "~/.ominax is not a folder"
# N-1 is R1 or later, which already lives in ~/.ominax.
[ ! -e "$HOME/.t3-learn" ] || fail "OminaX created ~/.t3-learn"
for launcher_name in ominax t3-learn; do
  launcher=""
  for candidate in "$HOME/.ominax/bin/$launcher_name" "$HOME/.local/bin/$launcher_name" "$HOME/bin/$launcher_name"; do
    if [ -x "$candidate" ]; then launcher="$candidate"; break; fi
  done
  if [ -n "$launcher" ]; then
    "$launcher" --version >/dev/null || fail "$launcher --version failed"
  else
    log "$launcher_name launcher is not reachable until Settings → About installs the CLI; skipping"
  fi
done
check_learning "the install"
if [ -n "${previous_running:-}" ] && [ -f apps/desktop/scripts/plant-saved-connection.mjs ]; then
  # N's renderer migrates saved connections when it loads them, shortly after its server is up.
  secrets_ok=""
  for _ in $(seq 1 30); do
    node apps/desktop/scripts/plant-saved-connection.mjs check && { secrets_ok=1; break; }
    sleep 2
  done
  [ -n "$secrets_ok" ] || fail "the saved connection planted under N-1 does not decrypt under N"
else
  log "saved-connection plant script is not present on this branch; secret check deferred"
fi

if [ "$os" = Darwin ]; then
  app="/Applications/OminaX.app"
  [ -d "$app" ] || app="/Applications/T3 Learn.app"
  [ -d "$app" ] || fail "the OminaX app bundle is missing"
  codesign --verify --deep "$app" || fail "the installed app's signature does not verify"
  [ "$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier)" = io.github.aabdel0181.ominax ] ||
    fail "unexpected bundle id"
  [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleName' "$app/Contents/Info.plist")" = OminaX ] || fail "unexpected CFBundleName"
  display_name="$(/usr/libexec/PlistBuddy -c 'Print CFBundleDisplayName' "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -z "$display_name" ] || [ "$display_name" = OminaX ] || fail "unexpected CFBundleDisplayName"
  url_types="$(plutil -extract CFBundleURLTypes xml1 -o - "$app/Contents/Info.plist")"
  for scheme in ominax t3learn; do
    grep -q "<string>$scheme</string>" <<<"$url_types" || fail "the app does not register $scheme:// links"
  done
elif [ "$scenario" = appimage ]; then
  [ -x "$HOME/.local/share/ominax/OminaX.AppImage" ] || fail "the AppImage is missing"
  grep -q '^Exec=' "$HOME/.local/share/applications/ominax.desktop" || fail "no desktop entry"
  for scheme in ominax t3learn; do
    grep -q "^MimeType=.*x-scheme-handler/$scheme;" "$HOME/.local/share/applications/ominax.desktop" ||
      fail "the desktop entry does not register $scheme:// links"
  done
  [ -s "$HOME/.local/share/icons/hicolor/512x512/apps/ominax.png" ] || fail "no menu icon"
elif [ "$scenario" = service ]; then
  :
else
  installed ominax || fail "the ominax package is not installed"
  ! installed t3learn || fail "the old t3learn package is still installed"
  [ -e /usr/share/applications/ominax.desktop ] || fail "the OminaX desktop entry is missing"
  for scheme in ominax t3learn; do
    grep -q "^MimeType=.*x-scheme-handler/$scheme;" /usr/share/applications/ominax.desktop ||
      fail "the desktop entry does not register $scheme:// links"
  done
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
    ! grep -q "aabdel0181" <<<"$(xdg-mime query default x-scheme-handler/t3code 2>/dev/null || true)" ||
      fail "OminaX took over t3code:// links"
  fi
fi

log "Uninstalling OminaX"
curl -fsSL "https://github.com/$repo/releases/download/v$version/install.sh" | sh -s -- --uninstall
if [ "$os" = Darwin ]; then
  [ ! -d "/Applications/OminaX.app" ] || fail "the OminaX app is still installed"
  [ ! -d "/Applications/T3 Learn.app" ] || fail "the old T3 Learn app is still installed"
elif [ "$scenario" = appimage ]; then
  [ ! -e "$HOME/.local/share/ominax/OminaX.AppImage" ] || fail "the AppImage is still installed"
else
  ! installed ominax || fail "the ominax package is still installed"
fi
[ -d "$HOME/.ominax/userdata" ] || fail "uninstall removed OminaX's data"
check_learning "uninstall"
if [ "$scenario" = next-to-t3-code ]; then
  [ "$(wait_for_server "$HOME/.t3" "$t3code_version")" = "$t3code_version" ] || fail "T3 Code stopped after uninstalling OminaX"
fi
log "PASS"
