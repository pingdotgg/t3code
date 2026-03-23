#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/assets/icons"

REPO_API_URL="https://api.github.com/repos/pingdotgg/t3code/releases/latest"
APP_NAME="T3 Code"
APP_ID="t3-code-desktop"
APP_ICON_NAME="t3-code-desktop"
INSTALL_SCOPE="user"
INSTALL_TARGET_LABEL="this user account"

TMP_DIR="$(mktemp -d)"
DESKTOP_DIR=""
BIN_DIR=""
SHARE_DIR=""
INSTALLER_DIR=""
TARGET_APPIMAGE=""
RUNNER_SCRIPT=""
UPDATER_SCRIPT=""
UNINSTALL_SCRIPT=""
VERSION_FILE=""
APPS_DIR=""
DESKTOP_FILE=""
ICON_BASE_DIR=""
ICON_256_DIR=""
ICON_512_DIR=""
PIXMAPS_DIR=""
INSTALLED_ICON_256=""
INSTALLED_ICON_512=""
INSTALLED_PIXMAP_ICON=""
INSTALLER_COPY=""
DESKTOP_SHORTCUT=""

FORCE_INSTALL=0
LAUNCH_AFTER=1
QUIET_CURRENT=0

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log() {
  printf '[t3-code] %s\n' "$1"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Usage: install-t3-code-linux.sh [options]

Options:
  --force          Reinstall even if the latest version is already installed
  --no-launch      Do not open T3 Code after install or update
  --quiet-current  Suppress the already-current message
  --system         Install system-wide under /opt and /usr/local
  --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE_INSTALL=1
      ;;
    --no-launch)
      LAUNCH_AFTER=0
      ;;
    --quiet-current)
      QUIET_CURRENT=1
      ;;
    --system)
      INSTALL_SCOPE="system"
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

require_asset() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf 'Missing installer asset: %s\n' "$path" >&2
    exit 1
  fi
}

require_asset "$ASSETS_DIR/t3-code-desktop-256.png"
require_asset "$ASSETS_DIR/t3-code-desktop-512.png"

for required_cmd in curl python3 install; do
  if ! have_cmd "$required_cmd"; then
    printf 'Missing required command: %s\n' "$required_cmd" >&2
    exit 1
  fi
done

if have_cmd xdg-user-dir; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [[ -z "$DESKTOP_DIR" || "$DESKTOP_DIR" == "$HOME" ]]; then
  DESKTOP_DIR="$HOME/Desktop"
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This installer currently supports Linux only.\n' >&2
  exit 1
fi

if [[ "$INSTALL_SCOPE" == "system" && "$EUID" -ne 0 ]]; then
  printf 'System install requires root. Re-run with sudo or as root.\n' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    ASSET_SUFFIX="x86_64.AppImage"
    ;;
  aarch64|arm64)
    ASSET_SUFFIX="arm64.AppImage"
    ;;
  *)
    printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

if [[ "$INSTALL_SCOPE" == "system" ]]; then
  INSTALL_TARGET_LABEL="this system"
  BIN_DIR="/usr/local/bin"
  SHARE_DIR="/opt/t3-code"
  INSTALLER_DIR="$SHARE_DIR/installer"
  TARGET_APPIMAGE="$SHARE_DIR/T3-Code.AppImage"
  RUNNER_SCRIPT="$BIN_DIR/t3-code-run"
  UPDATER_SCRIPT="$BIN_DIR/t3-code-update"
  UNINSTALL_SCRIPT="$BIN_DIR/t3-code-uninstall"
  VERSION_FILE="$SHARE_DIR/version"
  APPS_DIR="/usr/local/share/applications"
  DESKTOP_FILE="$APPS_DIR/$APP_ID.desktop"
  ICON_BASE_DIR="/usr/local/share/icons/hicolor"
  ICON_256_DIR="$ICON_BASE_DIR/256x256/apps"
  ICON_512_DIR="$ICON_BASE_DIR/512x512/apps"
  PIXMAPS_DIR="/usr/local/share/pixmaps"
  DESKTOP_SHORTCUT=""
else
  BIN_DIR="$HOME/.local/bin"
  SHARE_DIR="$HOME/.local/share/t3-code"
  INSTALLER_DIR="$SHARE_DIR/installer"
  TARGET_APPIMAGE="$BIN_DIR/T3-Code.AppImage"
  RUNNER_SCRIPT="$BIN_DIR/t3-code-run"
  UPDATER_SCRIPT="$BIN_DIR/t3-code-update"
  UNINSTALL_SCRIPT="$BIN_DIR/t3-code-uninstall"
  VERSION_FILE="$SHARE_DIR/version"
  APPS_DIR="$HOME/.local/share/applications"
  DESKTOP_FILE="$APPS_DIR/$APP_ID.desktop"
  ICON_BASE_DIR="$HOME/.local/share/icons/hicolor"
  ICON_256_DIR="$ICON_BASE_DIR/256x256/apps"
  ICON_512_DIR="$ICON_BASE_DIR/512x512/apps"
  PIXMAPS_DIR="$HOME/.local/share/pixmaps"
  DESKTOP_SHORTCUT="$DESKTOP_DIR/$APP_NAME.desktop"
fi

INSTALLED_ICON_256="$ICON_256_DIR/$APP_ICON_NAME.png"
INSTALLED_ICON_512="$ICON_512_DIR/$APP_ICON_NAME.png"
INSTALLED_PIXMAP_ICON="$PIXMAPS_DIR/$APP_ICON_NAME.png"
INSTALLER_COPY="$INSTALLER_DIR/install-t3-code-linux.sh"

mkdir -p "$BIN_DIR" "$SHARE_DIR" "$INSTALLER_DIR" "$APPS_DIR" "$ICON_256_DIR" "$ICON_512_DIR" "$PIXMAPS_DIR"
if [[ -n "$DESKTOP_SHORTCUT" ]]; then
  mkdir -p "$DESKTOP_DIR"
fi

copy_installer_bundle() {
  local src_installer dst_installer
  src_installer="$(realpath "$SCRIPT_DIR/install-t3-code-linux.sh")"
  dst_installer="$(realpath -m "$INSTALLER_COPY")"
  if [[ "$src_installer" != "$dst_installer" ]]; then
    install -m 755 "$SCRIPT_DIR/install-t3-code-linux.sh" "$INSTALLER_COPY"
  fi
  mkdir -p "$INSTALLER_DIR/assets/icons"
  local src_256 dst_256 src_512 dst_512
  src_256="$(realpath "$ASSETS_DIR/t3-code-desktop-256.png")"
  dst_256="$(realpath -m "$INSTALLER_DIR/assets/icons/t3-code-desktop-256.png")"
  src_512="$(realpath "$ASSETS_DIR/t3-code-desktop-512.png")"
  dst_512="$(realpath -m "$INSTALLER_DIR/assets/icons/t3-code-desktop-512.png")"
  if [[ "$src_256" != "$dst_256" ]]; then
    install -m 644 "$ASSETS_DIR/t3-code-desktop-256.png" "$INSTALLER_DIR/assets/icons/t3-code-desktop-256.png"
  fi
  if [[ "$src_512" != "$dst_512" ]]; then
    install -m 644 "$ASSETS_DIR/t3-code-desktop-512.png" "$INSTALLER_DIR/assets/icons/t3-code-desktop-512.png"
  fi
}

fetch_latest_release() {
  log 'Checking GitHub for the latest T3 Code release'
  curl -fsSL "$REPO_API_URL" -o "$TMP_DIR/release.json"
  readarray -t RELEASE_INFO < <(python3 - "$TMP_DIR/release.json" "$ASSET_SUFFIX" <<'PY'
import json
import sys

release_path, suffix = sys.argv[1], sys.argv[2]
with open(release_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

tag = data['tag_name']
asset = next((a for a in data.get('assets', []) if a['name'].endswith(suffix)), None)
if not asset:
    raise SystemExit(f'No release asset found ending with {suffix}')

print(tag)
print(asset['name'])
print(asset['browser_download_url'])
print(asset.get('digest', ''))
PY
  )

  LATEST_TAG="${RELEASE_INFO[0]}"
  ASSET_NAME="${RELEASE_INFO[1]}"
  DOWNLOAD_URL="${RELEASE_INFO[2]}"
  ASSET_DIGEST="${RELEASE_INFO[3]}"
  DOWNLOADED_APPIMAGE="$TMP_DIR/$ASSET_NAME"
}

version_state() {
  python3 - "$1" "$2" <<'PY'
import re
import sys

def parse(value: str):
    parts = re.findall(r'\d+', value)
    return tuple(int(p) for p in parts)

installed = parse(sys.argv[1])
latest = parse(sys.argv[2])
if installed < latest:
    print('older')
elif installed == latest:
    print('equal')
else:
    print('newer')
PY
}

has_fuse2() {
  if have_cmd ldconfig && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  local candidate
  for candidate in /lib/libfuse.so.2 /usr/lib/libfuse.so.2 /lib64/libfuse.so.2 /usr/lib64/libfuse.so.2; do
    if [[ -e "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

install_icons() {
  install -m 644 "$ASSETS_DIR/t3-code-desktop-256.png" "$INSTALLED_ICON_256"
  install -m 644 "$ASSETS_DIR/t3-code-desktop-512.png" "$INSTALLED_ICON_512"
  install -m 644 "$ASSETS_DIR/t3-code-desktop-256.png" "$INSTALLED_PIXMAP_ICON"
  install -m 644 "$ASSETS_DIR/t3-code-desktop-256.png" "$ICON_256_DIR/t3-code.png"
  install -m 644 "$ASSETS_DIR/t3-code-desktop-512.png" "$ICON_512_DIR/t3-code.png"
  install -m 644 "$ASSETS_DIR/t3-code-desktop-256.png" "$PIXMAPS_DIR/t3-code.png"
}

verify_download() {
  if [[ -z "$ASSET_DIGEST" ]]; then
    log 'Checksum: release metadata did not include a digest; skipping verification'
    return
  fi

  python3 - "$DOWNLOADED_APPIMAGE" "$ASSET_DIGEST" <<'PY'
import hashlib
import sys

path = sys.argv[1]
digest = sys.argv[2]
algo, expected = digest.split(':', 1)
h = hashlib.new(algo)
with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)
actual = h.hexdigest()
if actual != expected:
    raise SystemExit(f'Checksum mismatch: expected {expected}, got {actual}')
PY
  log 'Checksum: verified download integrity'
}

show_info() {
  local message="$1"
  if have_cmd zenity; then
    zenity --info --title="$APP_NAME" --width=420 --text="$message"
  elif have_cmd kdialog; then
    kdialog --title "$APP_NAME" --msgbox "$message"
  elif have_cmd notify-send; then
    notify-send "$APP_NAME" "$message"
  else
    printf '%s\n' "$message"
  fi
}

show_error() {
  local message="$1"
  local details="${2:-}"
  if have_cmd zenity; then
    zenity --error --title="$APP_NAME" --width=520 --text="$message"
    if [[ -n "$details" ]]; then
      zenity --text-info --title="$APP_NAME Error Details" --width=720 --height=420 --filename="$details"
    fi
  elif have_cmd kdialog; then
    kdialog --title "$APP_NAME" --error "$message"
  else
    printf '%s\n' "$message" >&2
    if [[ -n "$details" ]]; then
      cat "$details" >&2
    fi
  fi
}

write_runner() {
cat > "$RUNNER_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail

have_cmd() {
  command -v "\$1" >/dev/null 2>&1
}

APPIMAGE="$TARGET_APPIMAGE"

if [[ ! -x "\$APPIMAGE" ]]; then
  printf 'T3 Code is not installed at %s\n' "\$APPIMAGE" >&2
  exit 1
fi

if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2'; then
  exec "\$APPIMAGE" "\$@"
fi

for candidate in /lib/libfuse.so.2 /usr/lib/libfuse.so.2 /lib64/libfuse.so.2 /usr/lib64/libfuse.so.2; do
  if [[ -e "\$candidate" ]]; then
    exec "\$APPIMAGE" "\$@"
  fi
done

exec "\$APPIMAGE" --appimage-extract-and-run "\$@"
EOF
  chmod +x "$RUNNER_SCRIPT"
}

write_updater() {
cat > "$UPDATER_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail

have_cmd() {
  command -v "\$1" >/dev/null 2>&1
}

INSTALLER="$INSTALLER_COPY"
TMP_LOG="\$(mktemp)"
trap 'rm -f "\$TMP_LOG"' EXIT

summarize_success() {
  python3 - "\$TMP_LOG" <<'PY'
from pathlib import Path
text = Path(__import__('sys').argv[1]).read_text()
if 'Already up to date at' in text:
    print('T3 Code is already up to date.')
elif 'Updated T3 Code from' in text:
    line = next((line for line in text.splitlines() if 'Updated T3 Code from' in line), '')
    print(line.split('] ', 1)[-1] if line else 'T3 Code was updated successfully.')
elif 'Reinstalled T3 Code' in text:
    print('T3 Code was reinstalled successfully.')
elif 'Installed T3 Code' in text:
    line = next((line for line in text.splitlines() if 'Installed T3 Code' in line), '')
    print(line.split('] ', 1)[-1] if line else 'T3 Code was installed successfully.')
else:
    print('T3 Code action completed successfully.')
PY
}

if "\$INSTALLER" "\$@" >"\$TMP_LOG" 2>&1; then
  if have_cmd zenity; then
    zenity --info --title="$APP_NAME" --width=420 --text="\$(summarize_success)"
  elif have_cmd kdialog; then
    kdialog --title "$APP_NAME" --msgbox "\$(summarize_success)"
  elif have_cmd notify-send; then
    notify-send "$APP_NAME" "\$(summarize_success)"
  else
    cat "\$TMP_LOG"
  fi
else
  if have_cmd zenity; then
    zenity --error --title="$APP_NAME" --width=520 --text="T3 Code action failed."
    zenity --text-info --title="$APP_NAME Error Details" --width=720 --height=420 --filename="\$TMP_LOG"
  elif have_cmd kdialog; then
    kdialog --title "$APP_NAME" --error "T3 Code action failed."
  else
    cat "\$TMP_LOG" >&2
  fi
  exit 1
fi
EOF
  chmod +x "$UPDATER_SCRIPT"
}

write_uninstaller() {
cat > "$UNINSTALL_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail

have_cmd() {
  command -v "\$1" >/dev/null 2>&1
}

confirm() {
  if have_cmd zenity; then
    zenity --question --title="$APP_NAME" --width=420 --text="Uninstall T3 Code from $INSTALL_TARGET_LABEL?"
    return
  fi
  if have_cmd kdialog; then
    kdialog --title "$APP_NAME" --warningyesno "Uninstall T3 Code from $INSTALL_TARGET_LABEL?"
    return
  fi
  printf 'Uninstall T3 Code from %s? [y/N] ' "$INSTALL_TARGET_LABEL"
  read -r answer
  [[ "\$answer" =~ ^[Yy]$ ]]
}

if ! confirm; then
  exit 0
fi

rm -f "$TARGET_APPIMAGE" "$RUNNER_SCRIPT" "$UPDATER_SCRIPT" "$UNINSTALL_SCRIPT"
rm -f "$DESKTOP_FILE" "$DESKTOP_SHORTCUT"
rm -f "$INSTALLED_ICON_256" "$INSTALLED_ICON_512" "$INSTALLED_PIXMAP_ICON"
rm -f "$ICON_256_DIR/t3-code.png" "$ICON_512_DIR/t3-code.png" "$PIXMAPS_DIR/t3-code.png"
rm -rf "$SHARE_DIR"
update-desktop-database "$APPS_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$ICON_BASE_DIR" >/dev/null 2>&1 || true

if command -v zenity >/dev/null 2>&1; then
  zenity --info --title="$APP_NAME" --width=420 --text="T3 Code has been uninstalled from $INSTALL_TARGET_LABEL."
elif have_cmd kdialog; then
  kdialog --title "$APP_NAME" --msgbox "T3 Code has been uninstalled from $INSTALL_TARGET_LABEL."
elif have_cmd notify-send; then
  notify-send "$APP_NAME" "T3 Code has been uninstalled from $INSTALL_TARGET_LABEL."
else
  printf 'T3 Code has been uninstalled from %s.\n' "$INSTALL_TARGET_LABEL"
fi
EOF
  chmod +x "$UNINSTALL_SCRIPT"
}

write_desktop_entry() {
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=$APP_NAME
Comment=AI coding assistant desktop app
Exec=$RUNNER_SCRIPT
TryExec=$RUNNER_SCRIPT
Icon=$APP_ICON_NAME
Terminal=false
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=T3 Code (Alpha)
X-GNOME-WMClass=T3 Code (Alpha)
Actions=Update;Reinstall;Uninstall;

[Desktop Action Update]
Name=Check for Updates
Exec=$UPDATER_SCRIPT --no-launch

[Desktop Action Reinstall]
Name=Reinstall Latest Version
Exec=$UPDATER_SCRIPT --force --no-launch

[Desktop Action Uninstall]
Name=Uninstall T3 Code
Exec=$UNINSTALL_SCRIPT
EOF
  chmod +x "$DESKTOP_FILE"
}

write_desktop_shortcut() {
  if [[ -z "$DESKTOP_SHORTCUT" || ! -d "$DESKTOP_DIR" ]]; then
    return
  fi
  cat > "$DESKTOP_SHORTCUT" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=$APP_NAME
Comment=Launch T3 Code
Exec=$RUNNER_SCRIPT
TryExec=$RUNNER_SCRIPT
Icon=$APP_ICON_NAME
Terminal=false
StartupNotify=true
EOF
  chmod +x "$DESKTOP_SHORTCUT"
}

refresh_desktop_metadata() {
  if have_cmd update-desktop-database; then
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
  fi
  if have_cmd gtk-update-icon-cache; then
    gtk-update-icon-cache -f -t "$ICON_BASE_DIR" >/dev/null 2>&1 || true
  fi
}

fetch_latest_release
copy_installer_bundle

INSTALLED_TAG=""
PREVIOUS_TAG=""
ACTION="install"
if [[ -f "$VERSION_FILE" ]]; then
  INSTALLED_TAG="$(<"$VERSION_FILE")"
  PREVIOUS_TAG="$INSTALLED_TAG"
fi

if [[ ! -x "$TARGET_APPIMAGE" ]]; then
  INSTALLED_TAG=""
  PREVIOUS_TAG=""
fi

if [[ -n "$INSTALLED_TAG" ]]; then
  case "$(version_state "$INSTALLED_TAG" "$LATEST_TAG")" in
    older)
      ACTION="update"
      ;;
    equal|newer)
      ACTION="current"
      ;;
  esac
fi

if [[ $FORCE_INSTALL -eq 1 ]]; then
  ACTION="reinstall"
fi

if [[ "$ACTION" == "install" || "$ACTION" == "update" || "$ACTION" == "reinstall" ]]; then
  log "Downloading $LATEST_TAG ($ASSET_NAME)"
  curl -fL "$DOWNLOAD_URL" -o "$DOWNLOADED_APPIMAGE"
  verify_download
  install -m 755 "$DOWNLOADED_APPIMAGE" "$TARGET_APPIMAGE"
  printf '%s\n' "$LATEST_TAG" > "$VERSION_FILE"
  INSTALLED_TAG="$LATEST_TAG"
else
  if [[ $QUIET_CURRENT -eq 0 ]]; then
    log "Already up to date at $INSTALLED_TAG"
  fi
fi

log 'Installing desktop integration'
install_icons
write_runner
write_updater
write_uninstaller
write_desktop_entry
write_desktop_shortcut
refresh_desktop_metadata

case "$ACTION" in
  install)
    log "Installed T3 Code $INSTALLED_TAG"
    ;;
  update)
    log "Updated T3 Code from $PREVIOUS_TAG to $LATEST_TAG"
    ;;
  reinstall)
    log "Reinstalled T3 Code $INSTALLED_TAG"
    ;;
esac

if has_fuse2; then
  log 'Launch mode: native AppImage (FUSE available)'
else
  log 'Launch mode: extract-and-run fallback (FUSE not available)'
fi

log "AppImage: $TARGET_APPIMAGE"
log "Launcher: $DESKTOP_FILE"
if [[ -n "$DESKTOP_SHORTCUT" && -d "$DESKTOP_DIR" ]]; then
  log "Desktop shortcut: $DESKTOP_SHORTCUT"
fi

if [[ $LAUNCH_AFTER -eq 1 ]]; then
  log 'Opening T3 Code'
  nohup "$RUNNER_SCRIPT" >/dev/null 2>&1 &
fi
