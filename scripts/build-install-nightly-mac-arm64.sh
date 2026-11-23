#!/bin/sh
# Builds this checkout as an unsigned macOS arm64 Nightly DMG and installs it
# over T3 Code (Nightly).app without touching the stable app.
#
# When the Nightly app is running, the script asks before quitting it. A
# detached helper then waits for the app to exit, replaces it, and reopens it;
# quitting the app would otherwise kill the installer along with its terminal.
#
#   ./scripts/build-install-nightly-mac-arm64.sh
#
# Environment:
#   T3CODE_DESKTOP_VERSION      full nightly version to build
#                               (default: <base>-nightly.<YYYYMMDD>.<timestamp>)
#   T3CODE_NIGHTLY_BUILD_ID     suffix after the date (default: UTC timestamp)
#   T3CODE_INSTALL_DIR          where the app goes (default: /Applications, then
#                               ~/Applications when /Applications is not writable)
#   T3CODE_NIGHTLY_DRY_RUN      print the resolved build and install paths only
#   T3CODE_NIGHTLY_SKIP_BUILD   install an existing DMG for this version
#   T3CODE_NIGHTLY_ASSUME_YES   skip the quit confirmation dialog
#   T3CODE_NIGHTLY_NO_LAUNCH    do not reopen the app after installing
#   T3CODE_NIGHTLY_VERBOSE      stream electron-builder output
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SELF="$SCRIPT_DIR/$(basename -- "$0")"
APP_NAME="T3 Code (Nightly).app"
OUTPUT_DIR="$REPO_ROOT/release"

fail() {
  printf '\nbuild-install-nightly: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '==> %s\n' "$1"
}

is_true() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

app_is_running() {
  [ -d "$1" ] || return 1
  # comm is the executable path, so this neither matches the checking process
  # nor a shell whose arguments happen to contain the app path.
  ps -Aww -o state= -o comm= | awk -v path="$1/Contents/MacOS/" '
    $1 !~ /^Z/ && index($0, path) { found = 1; exit }
    END { exit found ? 0 : 1 }
  '
}

wait_for_quit() {
  waited=0
  while app_is_running "$1"; do
    [ "$waited" -ge 120 ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

install_app() {
  dmg=$1
  version=$2
  dir=$3
  target=$4

  [ -f "$dmg" ] || fail "DMG not found: $dmg"

  say "Mounting $dmg"
  mount_point=$(mktemp -d "${TMPDIR:-/tmp}/t3-nightly-dmg.XXXXXX")
  attached=false
  stage_dir=
  backup_dir=

  cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
      # The new app never landed; put the old one back.
      rm -rf "$target"
      mv "$backup_dir" "$target" 2>/dev/null || true
    fi
    if [ -n "$stage_dir" ]; then rm -rf "$stage_dir"; fi
    if "$attached"; then hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; fi
    rmdir "$mount_point" 2>/dev/null || true
    exit "$status"
  }
  trap cleanup EXIT INT TERM

  hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mount_point" "$dmg" >/dev/null ||
    fail "could not mount $dmg"
  attached=true

  app_source=
  for candidate in "$mount_point"/*.app; do
    [ -d "$candidate" ] || continue
    app_source="$candidate"
    break
  done
  [ -n "$app_source" ] || fail "the DMG contains no .app bundle"
  [ "$(basename "$app_source")" = "$APP_NAME" ] ||
    fail "expected $APP_NAME in the DMG, found $(basename "$app_source")"

  built_version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$app_source/Contents/Info.plist" 2>/dev/null) || built_version=
  [ "$built_version" = "$version" ] ||
    fail "built app reports version '${built_version:-unknown}', expected $version"

  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" || fail "could not create $dir"
  fi

  say "Staging $(basename "$app_source")"
  stage_dir="$dir/.t3-nightly-stage.$$"
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  ditto "$app_source" "$stage_dir/$APP_NAME" || fail "could not copy the app out of the DMG"
  xattr -dr com.apple.quarantine "$stage_dir/$APP_NAME" 2>/dev/null || true

  if [ -d "$target" ]; then
    say "Replacing the installed Nightly"
    backup_dir="$dir/.t3-nightly-backup.$$"
    rm -rf "$backup_dir"
    mv "$target" "$backup_dir" || fail "could not move the installed app aside"
  fi

  mv "$stage_dir/$APP_NAME" "$target" || fail "could not move the new app into $dir"
  rmdir "$stage_dir" 2>/dev/null || true
  stage_dir=

  installed_now=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$target/Contents/Info.plist" 2>/dev/null) || installed_now=
  [ "$installed_now" = "$version" ] ||
    fail "installed app reports version '${installed_now:-unknown}', expected $version"

  if [ -n "$backup_dir" ]; then
    rm -rf "$backup_dir"
    backup_dir=
  fi
  # Left behind by older runs that kept a copy while the app was running.
  rm -rf "$dir/.t3-nightly-previous.app" 2>/dev/null || true

  say "Installed $APP_NAME $version"
}

confirm_quit() {
  answer=$(osascript - "$1" <<'APPLESCRIPT' 2>/dev/null
on run argv
  set versionText to item 1 of argv
  display dialog ("T3 Code (Nightly) is running." & return & return & "Quit it and install " & versionText & " now? It reopens when the install finishes.") with title "T3 Code Nightly Update" buttons {"Cancel", "Quit and Install"} default button "Quit and Install" cancel button "Cancel" with icon note giving up after 300
end run
APPLESCRIPT
  ) || return 1
  case "$answer" in
    *"button returned:Quit and Install"*) return 0 ;;
    *) return 1 ;;
  esac
}

quit_app() {
  osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  tell application (item 1 of argv) to quit
end run
APPLESCRIPT
}

finish_install=false
if [ "${1:-}" = "--finish-install" ]; then
  shift
  { [ "$#" -eq 4 ] || [ "$#" -eq 5 ]; } ||
    fail "internal usage: --finish-install <dmg> <version> <install-dir> <app> [launch]"
  finish_install=true
  dmg_path=$1
  nightly_version=$2
  install_dir=$3
  target_app=$4
  launch=${5:-1}
fi

if "$finish_install"; then
  say "Waiting for T3 Code (Nightly) to quit"
  wait_for_quit "$target_app" ||
    fail "T3 Code (Nightly) did not quit; the update was not installed"
  install_app "$dmg_path" "$nightly_version" "$install_dir" "$target_app"
  if [ "$launch" = 1 ] && ! is_true "${T3CODE_NIGHTLY_NO_LAUNCH:-}"; then
    say "Opening T3 Code (Nightly)"
    open "$target_app" || fail "installed, but could not open $target_app"
  fi
  exit 0
fi

unset_t3_desktop_env() {
  unset T3CODE_DESKTOP_PLATFORM T3CODE_DESKTOP_TARGET T3CODE_DESKTOP_ARCH
  unset T3CODE_DESKTOP_OUTPUT_DIR T3CODE_DESKTOP_SKIP_BUILD T3CODE_DESKTOP_KEEP_STAGE
  unset T3CODE_DESKTOP_SIGNED T3CODE_DESKTOP_VERBOSE T3CODE_DESKTOP_MOCK_UPDATES
  unset T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT T3CODE_DESKTOP_WSL_RUNTIME
  unset VITE_DEV_SERVER_URL ELECTRON_RUN_AS_NODE
}

if [ "$(uname -s)" != Darwin ]; then
  fail "this script only builds the macOS app (host: $(uname -s))"
fi

if [ "$(uname -m)" != arm64 ]; then
  fail "this script only builds apple silicon (host: $(uname -m)); build x64 separately"
fi

command -v node >/dev/null 2>&1 || fail "node is required; run this inside the repo setup"
command -v vp >/dev/null 2>&1 || fail "vp is required; install Vite+ and run 'vp i'"
[ -d "$REPO_ROOT/node_modules" ] || fail "dependencies are missing; run 'vp i' in $REPO_ROOT"

setup_running="$REPO_ROOT/.t3/setup-running"
if [ -f "$setup_running" ]; then
  pid=$(tr -cd '0-9' <"$setup_running")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    fail "worktree setup is still running (PID $pid); wait for it to finish"
  fi
fi

# The desktop package version is the floor. A newer installed Nightly wins so a
# local build never downgrades the app.
repo_version=$(node -p "require('./apps/desktop/package.json').version" 2>/dev/null) ||
  fail "could not read apps/desktop/package.json"
repo_base=$(printf '%s' "$repo_version" | sed -E 's/[-+].*$//')

resolve_install_dir() {
  if [ -n "${T3CODE_INSTALL_DIR:-}" ]; then
    case "$T3CODE_INSTALL_DIR" in
      /*) ;;
      *) fail "T3CODE_INSTALL_DIR must be an absolute path" ;;
    esac
    [ -d "$T3CODE_INSTALL_DIR" ] || fail "T3CODE_INSTALL_DIR does not exist: $T3CODE_INSTALL_DIR"
    [ -w "$T3CODE_INSTALL_DIR" ] || fail "T3CODE_INSTALL_DIR is not writable: $T3CODE_INSTALL_DIR"
    printf '%s\n' "$T3CODE_INSTALL_DIR"
  elif [ -w /Applications ]; then
    printf '%s\n' /Applications
  else
    printf '%s\n' "$HOME/Applications"
  fi
}

install_dir=$(resolve_install_dir)
target_app="$install_dir/$APP_NAME"

installed_version=
if [ -f "$target_app/Contents/Info.plist" ]; then
  installed_version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$target_app/Contents/Info.plist" 2>/dev/null) || installed_version=
fi

installed_base=$(printf '%s' "$installed_version" | sed -E 's/[-+].*$//')

# Compares dotted numeric versions. Prints the greater one.
greater_version() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, av, "."); nb = split(b, bv, ".")
    n = na > nb ? na : nb
    for (i = 1; i <= n; i++) {
      x = i <= na ? av[i] + 0 : 0
      y = i <= nb ? bv[i] + 0 : 0
      if (x > y) { print a; exit }
      if (x < y) { print b; exit }
    }
    print a
  }'
}

base_version="$repo_base"
case "$installed_base" in
  '' | *[!0-9.]*) ;;
  *) base_version=$(greater_version "$repo_base" "$installed_base") ;;
esac

if [ -n "${T3CODE_DESKTOP_VERSION:-}" ]; then
  nightly_version="$T3CODE_DESKTOP_VERSION"
else
  build_id="${T3CODE_NIGHTLY_BUILD_ID:-$(date -u +%Y%m%d%H%M%S)}"
  case "$build_id" in
    '' | *[!0-9]*) fail "T3CODE_NIGHTLY_BUILD_ID must contain digits only" ;;
  esac
  nightly_version="$base_version-nightly.$(date -u +%Y%m%d).$build_id"
fi

case "$nightly_version" in
  *-nightly.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9]*) ;;
  *) fail "not a nightly version (expected X.Y.Z-nightly.YYYYMMDD.N): $nightly_version" ;;
esac

dmg_path="$OUTPUT_DIR/T3-Code-$nightly_version-arm64.dmg"

say "Repo:      $REPO_ROOT"
say "Version:   $nightly_version"
say "Installer: $dmg_path"
say "Installs:  $target_app"
if [ -n "$installed_version" ]; then
  say "Replaces:  $installed_version"
fi

if is_true "${T3CODE_NIGHTLY_DRY_RUN:-}"; then
  say "Dry run; nothing was built or installed."
  exit 0
fi

unset_t3_desktop_env

if is_true "${T3CODE_NIGHTLY_SKIP_BUILD:-}"; then
  [ -f "$dmg_path" ] || fail "T3CODE_NIGHTLY_SKIP_BUILD is set but $dmg_path does not exist"
  say "Skipping the build; using the existing DMG"
else
  # Official Nightly carries the production T3 Connect identifiers. A checkout
  # without .env would otherwise build with cloud features disabled.
  if [ ! -f "$REPO_ROOT/.env" ] && [ ! -f "$REPO_ROOT/.env.local" ]; then
    if [ -f "$REPO_ROOT/.env.example" ]; then
      say "Loading public configuration from .env.example"
      set -a
      # shellcheck disable=SC1091
      . "$REPO_ROOT/.env.example"
      set +a
    fi
  fi
  say "Building the desktop app (this takes several minutes)"
  set -- --platform mac --target dmg --arch arm64 \
    --build-version "$nightly_version" --output-dir "$OUTPUT_DIR"
  if is_true "${T3CODE_NIGHTLY_VERBOSE:-}"; then
    set -- "$@" --verbose
  fi
  (cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts "$@") ||
    fail "build failed"
fi

if [ ! -f "$dmg_path" ]; then
  dmg_path=$(find "$OUTPUT_DIR" -maxdepth 1 -name "T3-Code-$nightly_version-*.dmg" -print |
    head -n 1)
  [ -n "$dmg_path" ] || fail "build finished but no DMG for version $nightly_version was found"
fi

if app_is_running "$target_app"; then
  if ! is_true "${T3CODE_NIGHTLY_ASSUME_YES:-}"; then
    if ! confirm_quit "$nightly_version"; then
      say "Cancelled; nothing was installed. The DMG is at $dmg_path"
      exit 0
    fi
  fi

  log_dir="$HOME/Library/Logs/T3 Code"
  mkdir -p "$log_dir" || fail "could not create $log_dir"
  log_path="$log_dir/nightly-install-$nightly_version.log"
  label="com.t3tools.t3code.nightly-install.$(date +%s).$$"
  launch=1
  if is_true "${T3CODE_NIGHTLY_NO_LAUNCH:-}"; then launch=0; fi
  launchctl submit -l "$label" -o "$log_path" -e "$log_path" -- \
    /bin/sh "$SELF" --finish-install "$dmg_path" "$nightly_version" "$install_dir" "$target_app" "$launch" ||
    fail "could not start the background installer"

  say "Quitting T3 Code (Nightly); the update continues in the background."
  say "Log: $log_path"
  quit_app "$target_app"
  exit 0
fi

install_app "$dmg_path" "$nightly_version" "$install_dir" "$target_app"
