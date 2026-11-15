#!/usr/bin/env bash
# Checks a Continuum IDE macOS build the way users install it: through the Homebrew cask.
# Usage: verify-macos-install.sh CASK_FILE
# Installs the cask from a throwaway local tap, launches the app with `contin`, checks it runs
# (and that a second `contin` reuses it), then uninstalls and checks nothing is left behind.
set -euo pipefail
cask_file="$1"
bundle_id="io.github.swashxdev.continuumide"
app="/Applications/Continuum IDE.app"

brew style "$cask_file"

tap="continuum-verify/local"
brew untap "$tap" >/dev/null 2>&1 || true
brew tap-new --no-git "$tap" >/dev/null
tap_dir="$(brew --repository)/Library/Taps/continuum-verify/homebrew-local"
mkdir -p "$tap_dir/Casks"
cp "$cask_file" "$tap_dir/Casks/continuum-ide.rb"
cleanup() { brew untap "$tap" >/dev/null 2>&1 || true; }
trap cleanup EXIT

brew install --cask "$tap/continuum-ide"
test -d "$app" || { echo "::error::$app was not installed"; exit 1; }
actual_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
test "$actual_id" = "$bundle_id" || { echo "::error::wrong app installed: $actual_id"; exit 1; }
codesign --verify --deep --verbose=2 "$app"
if xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then
  echo "::error::the app is still quarantined"; exit 1
fi
contin_path="$(command -v contin)"
echo "contin is at $contin_path"

running() { pgrep -f "Continuum IDE.app/Contents/MacOS/" >/dev/null; }
count() { pgrep -f "Continuum IDE.app/Contents/MacOS/Continuum IDE$" | wc -l | tr -d ' '; }
(cd / && contin)
for _ in $(seq 1 60); do running && break; sleep 1; done
running || { echo "::error::contin did not start Continuum IDE"; exit 1; }
sleep 10
running || { echo "::error::Continuum IDE quit right after starting"; exit 1; }
before="$(count)"
(cd "$HOME" && contin)
sleep 5
after="$(count)"
test "$after" = "$before" || { echo "::error::a second contin started another copy ($before -> $after)"; exit 1; }
echo "Continuum IDE is running ($after main process); contin works from any folder"

osascript -e "quit app id \"$bundle_id\"" || true
for _ in $(seq 1 30); do running || break; sleep 1; done

brew uninstall --cask "$tap/continuum-ide"
test ! -d "$app" || { echo "::error::uninstall left $app"; exit 1; }
if command -v contin >/dev/null 2>&1; then echo "::error::uninstall left contin on PATH"; exit 1; fi
echo "Homebrew install, contin launch, and uninstall all passed"
