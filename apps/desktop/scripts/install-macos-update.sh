#!/bin/sh
# Keep the publisher's signed bundle intact; never patch or re-sign downloaded apps.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

fail() { echo "$*" >&2; exit 1; }
team() { codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
identifier() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
launch() { open --env "T3CODE_DESKTOP_UPDATE_INSTALLER=$0" --env T3CODE_DISABLE_AUTO_UPDATE=false "$app"; }
verify() {
  codesign --verify --deep --strict "$1" >&2
  [ "$(team "$1")" = "$signer" ] || fail "Update publisher does not match the installed app."
  [ "$(identifier "$1")" = "$bundle_id" ] || fail "Update bundle identifier does not match the installed app."
}

[ "$#" -eq 5 ] || fail "Expected ARCHIVE APP VERSION PARENT_PID RELAUNCH."
archive=$1; app=$2; version=$3; parent_pid=$4; relaunch=$5
case "$app" in /*.app) ;; *) fail "Expected an absolute app bundle path." ;; esac
case "$parent_pid" in ''|*[!0-9]*|0|1) fail "Invalid parent PID." ;; esac
case "$relaunch" in true|false) ;; *) fail "Invalid relaunch value." ;; esac
[ -d "$app" ] && [ ! -L "$app" ] || fail "Invalid app bundle."
codesign --verify --deep --strict "$app" >&2
signer=$(team "$app"); bundle_id=$(identifier "$app")
[ -n "$signer" ] && [ "$signer" != 'not set' ] || fail "Installed app has no signing team."
exec 4>&2
stage=$(mktemp -d "$(dirname "$app")/.t3-update.XXXXXXXX")
candidate="$stage/candidate.app"
moved_old=false; locked=false; ready=false
cleanup() {
  status=$?
  if [ "$moved_old" = true ]; then
    if [ -e "$app" ]; then mv "$app" "$stage/failed.app"; fi
    mv "$stage/previous.app" "$app"
  fi
  if [ "$status" -ne 0 ]; then
    rm -rf "$candidate" "$stage/extracted"
    if [ "$ready" = true ] && [ "$relaunch" = true ] && ! kill -0 "$parent_pid" 2>/dev/null; then
      launch || true
    fi
  fi
  if [ "$locked" = true ]; then rm -f "$app.update-lock"; fi
  if [ "$ready" = false ]; then cat "$stage/install.log" >&4 || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
exec 2>> "$stage/install.log"

ditto -x -k "$archive" "$stage/extracted" >&2
selected=
for bundle in "$stage/extracted/"*.app; do
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || continue
  bundle_identifier=$(identifier "$bundle" 2>/dev/null) || continue
  [ "$bundle_identifier" = "$bundle_id" ] || continue
  [ -z "$selected" ] || fail "Multiple update bundles match the installed bundle identifier."
  selected=$bundle
done
[ -n "$selected" ] || fail "Update bundle identifier does not match the installed app."
verify "$selected"
actual=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$selected/Contents/Info.plist")
[ "$actual" = "$version" ] || fail "Downloaded update version does not match T3's selected version."
# Stock nightlies would remove this integration on the next restart.
grep -a -q 'T3CODE_DESKTOP_UPDATE_INSTALLER' "$selected/Contents/Resources/app.asar" ||
  fail "Downloaded build lacks external installer support; a signed build containing the patch is required."
spctl --assess --type execute "$selected" >&2
mv "$selected" "$candidate"
rm -rf "$stage/extracted"
shlock -p "$$" -f "$app.update-lock" || fail "Another installation is running."
locked=true
exec 3>&1
exec >> "$stage/install.log"
ready=true
printf 'ready\n' >&3
exec 3>&- 4>&-
attempts=0
while kill -0 "$parent_pid" 2>/dev/null; do
  [ "$attempts" -lt 120 ] || fail "T3 did not exit; update was not installed."
  sleep 1
  attempts=$((attempts + 1))
done
mv "$app" "$stage/previous.app"
moved_old=true
mv "$candidate" "$app"
verify "$app"
if [ "$relaunch" = true ]; then launch; fi
moved_old=false
printf '%s\n' "$app" > "$stage/installed-app"
# Keep one verified rollback bundle, leaving unrelated backups untouched.
for previous in "$(dirname "$app")"/.t3-update.*; do
  [ "$previous" != "$stage" ] || continue
  [ ! -L "$previous" ] && [ -f "$previous/installed-app" ] || continue
  [ "$(cat "$previous/installed-app")" = "$app" ] || continue
  rm -rf "$previous"
done
