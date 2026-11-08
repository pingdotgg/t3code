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

[ "$#" -ge 1 ] || fail "Expected prepare or install."
phase=$1; shift
case "$phase" in
  prepare)
    [ "$#" -eq 3 ] || fail "Expected prepare ARCHIVE APP VERSION."
    archive=$1; app=$2; version=$3
    case "$app" in /*.app) ;; *) fail "Expected an absolute app bundle path." ;; esac
    [ -d "$app" ] && [ ! -L "$app" ] || fail "Invalid app bundle."
    codesign --verify --deep --strict "$app" >&2
    signer=$(team "$app"); bundle_id=$(identifier "$app")
    [ -n "$signer" ] && [ "$signer" != 'not set' ] || fail "Installed app has no signing team."
    stage=$(mktemp -d "$(dirname "$app")/.t3-update.XXXXXXXX")
    trap 'rm -rf "$stage"' EXIT
    trap 'exit 1' HUP INT TERM
    ditto -x -k "$archive" "$stage/extracted" >&2
    candidate="$stage/extracted/$(basename "$app")"
    verify "$candidate"
    actual=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate/Contents/Info.plist")
    [ "$actual" = "$version" ] || fail "Downloaded update version does not match T3's selected version."
    # Stock nightlies would remove this integration on the next restart.
    grep -a -q 'T3CODE_DESKTOP_UPDATE_INSTALLER' "$candidate/Contents/Resources/app.asar" ||
      fail "Downloaded build lacks external installer support; a signed build containing the patch is required."
    spctl --assess --type execute "$candidate" >&2
    mv "$candidate" "$stage/candidate.app"
    rm -rf "$stage/extracted"
    printf '%s\n' "$stage/candidate.app"
    trap - EXIT HUP INT TERM
    ;;
  install)
    [ "$#" -eq 4 ] || fail "Expected install CANDIDATE APP PARENT_PID RELAUNCH."
    candidate=$1; app=$2; parent_pid=$3; relaunch=$4
    case "$parent_pid" in ''|*[!0-9]*|0|1) fail "Invalid parent PID." ;; esac
    case "$relaunch" in true|false) ;; *) fail "Invalid relaunch value." ;; esac
    stage=$(dirname "$candidate")
    case "$stage" in "$(dirname "$app")"/.t3-update.*) ;; *) fail "Invalid staging directory." ;; esac
    [ "$candidate" = "$stage/candidate.app" ] || fail "Invalid staged app path."
    [ -d "$app" ] && [ ! -L "$app" ] && [ ! -L "$stage" ] || fail "Invalid app or staging directory."
    signer=$(team "$app"); bundle_id=$(identifier "$app")
    [ -n "$signer" ] && [ "$signer" != 'not set' ] || fail "Installed app has no signing team."
    verify "$candidate"
    shlock -p "$$" -f "$app.update-lock" || fail "Another installation is running."
    moved_old=false
    rollback() {
      status=$?
      if [ "$moved_old" = true ]; then
        if [ -e "$app" ]; then mv "$app" "$stage/failed.app"; fi
        mv "$stage/previous.app" "$app"
      fi
      if [ "$status" -ne 0 ] && [ "$relaunch" = true ] && ! kill -0 "$parent_pid" 2>/dev/null; then
        launch || true
      fi
      rm -f "$app.update-lock"
      exit "$status"
    }
    trap rollback EXIT
    trap 'exit 1' HUP INT TERM
    exec 3>&1
    exec >> "$stage/install.log" 2>&1
    printf 'ready\n' >&3
    exec 3>&-
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
    ;;
  *) fail "Unknown installer phase: $phase" ;;
esac
