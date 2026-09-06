#!/usr/bin/env bash
# Install the built Linux AppImage into ~/.local for the app launcher.
set -euo pipefail

APPIMAGE="/home/anthony/dev/tcode/release/T3-Code-0.0.33-x86_64.AppImage"
INSTALL_DIR="/home/anthony/.local/opt/t3code"
BIN_DIR="/home/anthony/.local/bin"
APPS_DIR="/home/anthony/.local/share/applications"
ICONS_DIR="/home/anthony/.local/share/icons/hicolor"
EXTRACT_DIR="/tmp/t3code-appimage-extract"

if [[ ! -f "$APPIMAGE" ]]; then
  echo "missing AppImage: $APPIMAGE" >&2
  exit 1
fi

chmod +x "$APPIMAGE"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
cd "$EXTRACT_DIR"
"$APPIMAGE" --appimage-extract >/dev/null

rm -rf "$INSTALL_DIR"
mkdir -p "/home/anthony/.local/opt"
mv "$EXTRACT_DIR/squashfs-root" "$INSTALL_DIR"
# chrome-sandbox needs setuid when available; ignore if filesystem rejects it
chmod 4755 "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true

mkdir -p "$BIN_DIR" "$APPS_DIR"
# The default UA Control Center URL in shared code is the local hub (loopback).
# This machine's authoritative hub is on the Mac over Tailscale, and a GUI launch
# inherits no interactive-shell env, so bake the override into the wrapper.
# Override at install time:  T3CODE_UA_CONTROL_CENTER_URL=http://host:port/ui  ./scripts/install-local-desktop.sh
UA_CONTROL_CENTER_URL="${T3CODE_UA_CONTROL_CENTER_URL:-http://100.111.5.64:8765/ui}"
cat > "$BIN_DIR/t3code" <<EOF
#!/bin/sh
export T3CODE_UA_CONTROL_CENTER_URL="\${T3CODE_UA_CONTROL_CENTER_URL:-${UA_CONTROL_CENTER_URL}}"
exec /home/anthony/.local/opt/t3code/AppRun "\$@"
EOF
chmod +x "$BIN_DIR/t3code"
ln -sfn t3code "$BIN_DIR/t3-code-desktop"

# Prefer packaged desktop file; rewrite Exec/Icon to local install paths.
DESKTOP_SRC=""
for candidate in \
  "$INSTALL_DIR/t3-code.desktop" \
  "$INSTALL_DIR/t3code.desktop" \
  "$INSTALL_DIR/usr/share/applications/"*.desktop
do
  if [[ -f "$candidate" ]]; then
    DESKTOP_SRC="$candidate"
    break
  fi
done

ICON_PATH=""
for size in 512 256 128 64; do
  found="$(find "$INSTALL_DIR" -path "*/icons/hicolor/${size}x${size}/apps/*.png" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$found" ]]; then
    mkdir -p "$ICONS_DIR/${size}x${size}/apps"
    cp "$found" "$ICONS_DIR/${size}x${size}/apps/t3-code.png"
    if [[ -z "$ICON_PATH" ]]; then
      ICON_PATH="$ICONS_DIR/${size}x${size}/apps/t3-code.png"
    fi
  fi
done
if [[ -z "$ICON_PATH" ]]; then
  ICON_PATH="t3-code"
fi

if [[ -n "$DESKTOP_SRC" ]]; then
  sed \
    -e "s|^Exec=.*|Exec=${BIN_DIR}/t3code %U|" \
    -e "s|^Icon=.*|Icon=${ICON_PATH}|" \
    "$DESKTOP_SRC" > "$APPS_DIR/t3-code.desktop"
else
  cat > "$APPS_DIR/t3-code.desktop" <<EOF
[Desktop Entry]
Name=T3 Code
Comment=Desktop control surface for local coding agents
Exec=${BIN_DIR}/t3code %U
Icon=${ICON_PATH}
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code (Alpha)
MimeType=x-scheme-handler/t3code;
EOF
fi

chmod 644 "$APPS_DIR/t3-code.desktop"
update-desktop-database "$APPS_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$ICONS_DIR" 2>/dev/null || true

echo "installed=$INSTALL_DIR"
echo "launcher=$BIN_DIR/t3code"
echo "desktop=$APPS_DIR/t3-code.desktop"
echo "icon=$ICON_PATH"
ls -la "$BIN_DIR/t3code" "$INSTALL_DIR/AppRun" "$APPS_DIR/t3-code.desktop"
