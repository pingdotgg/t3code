#!/bin/sh
# Installs the OminaX desktop app on macOS or Linux from the fork's latest
# GitHub Release. Needs only sh, curl or wget, and sha256sum or shasum.
#
#   curl -fsSL https://github.com/aabdel0181/ominax/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --uninstall
#
# OminaX installs next to T3 Code and keeps its own data in ~/.ominax, so an
# existing T3 Code install, its threads and its `t3` command stay as they are.
#
# Environment:
#   OMINAX_VERSION            exact version to install (default: the latest release)
#   OMINAX_FORMAT             Linux only: deb or appimage (default: deb where apt and
#                             sudo are available, otherwise appimage)
#   OMINAX_NO_LAUNCH          set to 1 to install without opening the app
#   OMINAX_RELEASE_BASE_URL   mirror for releases/download (default: GitHub)
#   OMINAX_UNINSTALL           set to 1 to uninstall (also accepts --uninstall)
set -eu

repo="aabdel0181/ominax"
base_url="${OMINAX_RELEASE_BASE_URL:-${T3LEARN_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}}"
app_name="OminaX"
old_app_name="T3 Learn"
# The app before and after the OminaX rename (REL-45).
bundle_ids="io.github.aabdel0181.ominax io.github.aabdel0181.t3learn"
data_dir="$HOME/.ominax"
legacy_data_dir="$HOME/.t3-learn"
# The Linux executable, WM class and deb package, like upstream's t3code.
exe=ominax
old_exe=t3learn
appimage_dir="$HOME/.local/share/ominax"
old_appimage_dir="$HOME/.local/share/t3-learn"
appimage_path="${appimage_dir}/OminaX.AppImage"
old_appimage_path="${old_appimage_dir}/T3-Learn.AppImage"
desktop_file="$HOME/.local/share/applications/${exe}.desktop"
old_desktop_file="$HOME/.local/share/applications/${old_exe}.desktop"
legacy_desktop_file="$HOME/.local/share/applications/io.github.aabdel0181.T3Learn.desktop"
icon_file="$HOME/.local/share/icons/hicolor/512x512/apps/${exe}.png"
old_icon_file="$HOME/.local/share/icons/hicolor/512x512/apps/${old_exe}.png"

fail() {
  printf '\nominax install: %s\n' "$1" >&2
  exit 1
}

interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset='' bold='' muted='' green=''
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; green="$(printf '\033[32m')"
fi
say() { printf '  %s\n' "$1" >&2; }
step() { printf '  %s%s%s\n' "$muted" "$1" "$reset" >&2; }

# Exit 44 on a 404 so a missing asset reads differently from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    progress=-sS
    if [ "${2:-}" = progress ] && "$interactive"; then progress=-#; fi
    status="$(curl "$progress" -L -w '%{http_code}' "$1" -o "$3")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    quiet=-q
    if [ "${2:-}" = progress ] && "$interactive"; then quiet="-q --show-progress"; fi
    # shellcheck disable=SC2086
    wget $quiet "$1" -O "$3" 2>&1 && return 0
    return 1
  else
    fail "curl or wget is required"
  fi
}

if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

case "$(uname -s)" in
  Darwin) platform=mac ;;
  Linux) platform=linux ;;
  *) fail "unsupported system $(uname -s); on Windows run: irm https://github.com/${repo}/releases/latest/download/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

mac_app_dir() {
  if [ -d "/Applications/${app_name}.app" ] || [ -d "/Applications/${old_app_name}.app" ] || [ -w /Applications ]; then
    printf '/Applications'
  else
    printf '%s/Applications' "$HOME"
  fi
}

t3_code_installed() {
  if [ "$platform" = mac ]; then
    for app in /Applications/T3\ Code*.app "$HOME"/Applications/T3\ Code*.app; do
      [ -d "$app" ] && return 0
    done
  else
    command -v t3code >/dev/null 2>&1 && return 0
    [ -f "$HOME/.local/share/applications/com.t3tools.T3Code.desktop" ] && return 0
  fi
  [ -d "$HOME/.t3" ]
}

deb_installed() {
  command -v dpkg-query >/dev/null 2>&1 &&
    dpkg-query -W -f '${Status}' "$exe" 2>/dev/null | grep -q 'install ok installed'
}

remove_appimage() {
  rm -f "$appimage_path" "$old_appimage_path" "$desktop_file" "$old_desktop_file" "$legacy_desktop_file" "$icon_file" "$old_icon_file"
  rmdir "$appimage_dir" 2>/dev/null || true
  rmdir "$old_appimage_dir" 2>/dev/null || true
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$(dirname "$desktop_file")" >/dev/null 2>&1 || true
}

uninstall() {
  if [ "$platform" = mac ]; then
    dest="$(mac_app_dir)"
    for app in "${dest}/${app_name}.app" "${dest}/${old_app_name}.app"; do
      [ -d "$app" ] || continue
      for id in $bundle_ids; do osascript -e "tell application id \"${id}\" to quit" >/dev/null 2>&1 || true; done
      rm -rf "$app"
      say "Removed ${app}."
    done
  else
    if deb_installed; then
      say "Removing the ${exe} package (sudo may ask for your password)..."
      sudo apt-get purge -y "$exe" >/dev/null
    fi
    if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f '${Status}' "$old_exe" 2>/dev/null | grep -q 'install ok installed'; then
      say "Removing the ${old_exe} package (sudo may ask for your password)..."
      sudo apt-get purge -y "$old_exe" >/dev/null
    fi
    remove_appimage
    say "Removed OminaX."
  fi
  if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then
    data_message="$data_dir"
  elif [ -e "$legacy_data_dir" ] || [ -L "$legacy_data_dir" ]; then
    data_message="$legacy_data_dir"
  else
    data_message="$data_dir"
  fi
  say "Your OminaX projects and settings are still in ${data_message}; delete that folder to remove them too."
  exit 0
}

case "${1:-}" in
  --uninstall) uninstall ;;
  "") ;;
  *) fail "unknown option $1 (the only option is --uninstall)" ;;
esac
[ "${OMINAX_UNINSTALL:-${T3LEARN_UNINSTALL:-}}" != 1 ] || uninstall

printf '\n  %sOminaX%s %sinstaller%s\n\n' "$bold" "$reset" "$muted" "$reset" >&2

if [ "$platform" = linux ]; then
  format="${OMINAX_FORMAT:-${T3LEARN_FORMAT:-}}"
  if [ -z "$format" ]; then
    format=appimage
    # The .deb keeps Chromium's sandbox on Ubuntu, where AppImages run without it.
    if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
      say "Installing the .deb package needs sudo, which may ask for your password."
      if sudo -v; then format=deb; else say "Without sudo, OminaX installs as an AppImage in your home folder."; fi
    fi
  fi
  case "$format" in
    deb)
      [ "$arch" = x64 ] && pattern='(OminaX|T3-Learn)-.*-amd64\.deb' || pattern='(OminaX|T3-Learn)-.*-arm64\.deb'
      ;;
    appimage)
      [ "$arch" = x64 ] && pattern='(OminaX|T3-Learn)-.*-x86_64\.AppImage' || pattern='(OminaX|T3-Learn)-.*-arm64\.AppImage'
      ;;
    *) fail "OMINAX_FORMAT must be deb or appimage" ;;
  esac
else
  pattern="(OminaX|T3-Learn)-.*-${arch}\\.zip"
fi

step "Finding the latest release..."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

version_input="${OMINAX_VERSION:-${T3LEARN_VERSION:-}}"
if [ -n "$version_input" ]; then
  sums_url="${base_url}/v${version_input#v}/SHA256SUMS"
else
  sums_url="https://github.com/${repo}/releases/latest/download/SHA256SUMS"
  [ -z "${OMINAX_RELEASE_BASE_URL:-${T3LEARN_RELEASE_BASE_URL:-}}" ] || sums_url="${base_url}/latest/SHA256SUMS"
fi
fetch_status=0
fetch "$sums_url" quiet "$work/SHA256SUMS" || fetch_status=$?
[ "$fetch_status" -ne 44 ] || fail "no OminaX release found at ${sums_url}"
[ "$fetch_status" -eq 0 ] || fail "could not reach GitHub to find the release"

line="$(grep -E " \*?${pattern}\$" "$work/SHA256SUMS" | head -n 1 || true)"
[ -n "$line" ] || fail "this release has no build for ${platform} ${arch}"
expected="${line%% *}"
asset="${line##* }"
asset="${asset#\*}"
version="$(printf '%s' "$asset" | sed -E 's/^(OminaX|T3-Learn)-(.*)-(arm64|x64|x86_64|amd64)\.[A-Za-z]+$/\2/')"

if t3_code_installed; then
  say "Found T3 Code. It stays installed with its own data; OminaX installs next to it."
fi
say "Installing ${bold}OminaX ${version}${reset}"
printf '\n' >&2
fetch "${base_url}/v${version}/${asset}" progress "$work/$asset" || fail "could not download ${asset}"
step "Verifying the download..."
[ "$(checksum "$work/$asset")" = "$expected" ] || fail "checksum mismatch for ${asset}; try again"

launch=true
[ "${OMINAX_NO_LAUNCH:-${T3LEARN_NO_LAUNCH:-}}" != 1 ] || launch=false

if [ "$platform" = mac ]; then
  dest="$(mac_app_dir)"
  if pgrep -f "${dest}/(${app_name}|${old_app_name})\.app/Contents/MacOS/" >/dev/null 2>&1; then
    step "Closing OminaX to update it..."
    for id in $bundle_ids; do osascript -e "tell application id \"${id}\" to quit" >/dev/null 2>&1 || true; done
    tries=0
    while pgrep -f "${dest}/(${app_name}|${old_app_name})\.app/Contents/MacOS/" >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -le 40 ] || fail "quit OminaX, then run the installer again"
      sleep 0.25
    done
  fi
  step "Installing to ${dest}..."
  mkdir -p "$dest" "$work/unpacked"
  ditto -x -k "$work/$asset" "$work/unpacked"
  unpacked_app="$(ls -d "$work/unpacked"/*.app 2>/dev/null | head -n 1 || true)"
  [ -n "$unpacked_app" ] || fail "the download did not contain an OminaX or T3 Learn app bundle"
  # The build is not notarized. curl leaves no quarantine flag, so Gatekeeper
  # never blocks it; clear one anyway in case a proxy or mirror added it.
  xattr -dr com.apple.quarantine "$unpacked_app" 2>/dev/null || true
  app="${dest}/$(basename "$unpacked_app")"
  rm -rf "$app"
  mv "$unpacked_app" "$app"
  [ "$(basename "$app")" = "${app_name}.app" ] && rm -rf "${dest}/${old_app_name}.app"
  if "$launch"; then open "$app"; fi
elif [ "$format" = deb ]; then
  step "Installing the package..."
  chmod 644 "$work/$asset"
  # apt reads the file as the _apt user, which cannot enter a 0700 mktemp dir.
  chmod 755 "$work"
  sudo apt-get install -y --allow-downgrades "$work/$asset" >/dev/null ||
    fail "apt could not install ${asset}"
  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f '${Status}' "$old_exe" 2>/dev/null | grep -q 'install ok installed'; then
    sudo apt-get purge -y "$old_exe" >/dev/null || fail "could not remove the old ${old_exe} package"
  fi
  # An earlier AppImage install would keep its menu entry ahead of the package's.
  remove_appimage
  if "$launch" && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    nohup "$exe" >/dev/null 2>&1 &
  fi
else
  if deb_installed; then
    say "The ${exe} package is also installed; remove it with: sudo apt-get purge ${exe}"
  fi
  step "Installing to ${appimage_dir}..."
  rm -f "$old_appimage_path" "$old_desktop_file" "$legacy_desktop_file" "$old_icon_file"
  rmdir "$old_appimage_dir" 2>/dev/null || true
  mkdir -p "$appimage_dir" "$(dirname "$desktop_file")" "$(dirname "$icon_file")"
  # The updater replaces the file in place, so the name carries no version.
  mv "$work/$asset" "$appimage_path"
  chmod 755 "$appimage_path"
  # The image's top-level icon is a symlink into usr/share/icons.
  icon_path="usr/share/icons/hicolor/512x512/apps/${exe}.png"
  (cd "$work" && "$appimage_path" --appimage-extract "$icon_path" >/dev/null 2>&1) || true
  if [ -f "$work/squashfs-root/$icon_path" ]; then cp "$work/squashfs-root/$icon_path" "$icon_file"; fi
  exec_line="\"${appimage_path}\" %U"
  extract_and_run=
  if [ ! -e /dev/fuse ] || ! { command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1; }; then
    say "FUSE is not available, so OminaX unpacks itself on each start (slower)."
    exec_line="env APPIMAGE_EXTRACT_AND_RUN=1 ${exec_line}"
    extract_and_run=1
  fi
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=OminaX
Comment=Learn with AI coding agents
Exec=${exec_line}
Icon=${exe}
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/ominax;x-scheme-handler/t3learn;
StartupWMClass=${exe}
EOF
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$(dirname "$desktop_file")" >/dev/null 2>&1 || true
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    say "This system blocks the sandbox AppImages use, so OminaX runs without it."
    say "For a sandboxed install, run the installer again with T3LEARN_FORMAT=deb."
  fi
  if "$launch" && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    # The runtime treats the variable as set even when empty.
    if [ -n "$extract_and_run" ]; then export APPIMAGE_EXTRACT_AND_RUN=1; fi
    nohup "$appimage_path" >/dev/null 2>&1 &
  fi
fi

printf '\n  %sInstalled OminaX %s%s\n' "$green" "$version" "$reset" >&2
if [ "$platform" = mac ]; then
  say "Open it from ${dest} or Spotlight. It updates itself."
else
  say "Open it from your app menu. It updates itself."
  if pgrep -u "$(id -u)" -x "$exe" >/dev/null 2>&1; then say "If OminaX was already open, restart it to use this version."; fi
fi
say "Projects and settings live in ${data_dir}."
printf '\n' >&2
