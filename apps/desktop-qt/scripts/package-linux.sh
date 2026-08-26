#!/usr/bin/env bash
# Builds an AppImage from a Release build directory with linuxdeploy and its
# Qt plugin (downloaded on first use). Usage: package-linux.sh <build-dir>
set -euo pipefail

build_dir="${1:?build directory}"
app_dir="${build_dir}/AppDir"
tools_dir="${build_dir}/tools"
mkdir -p "${tools_dir}"

fetch() {
  local url="$1" out="$2"
  if [ ! -x "${out}" ]; then
    curl -fsSL "${url}" -o "${out}"
    chmod +x "${out}"
  fi
}
fetch "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage" "${tools_dir}/linuxdeploy"
fetch "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-x86_64.AppImage" "${tools_dir}/linuxdeploy-plugin-qt"

rm -rf "${app_dir}"
cmake --install "${build_dir}" --prefix "${app_dir}/usr"

# Desktop entry + icon: the app id (t3code) must match what the shell sets so
# compositor rules can target the window.
mkdir -p "${app_dir}/usr/share/applications" "${app_dir}/usr/share/icons/hicolor/256x256/apps"
cat > "${app_dir}/usr/share/applications/t3code.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=T3 Code
Exec=t3code-qt
Icon=t3code
Categories=Development;
StartupWMClass=t3code
DESKTOP
icon_source="$(dirname "$0")/../../desktop/resources/icon.png"
if [ -f "${icon_source}" ]; then
  cp "${icon_source}" "${app_dir}/usr/share/icons/hicolor/256x256/apps/t3code.png"
else
  # A placeholder keeps linuxdeploy happy when the desktop icon is not around.
  printf '\x89PNG\r\n\x1a\n' > "${app_dir}/usr/share/icons/hicolor/256x256/apps/t3code.png"
fi

# The Node desktop host runs from source in-repo builds; ship it next to the
# binary so the bundled shell can find it (system Node is still required).
mkdir -p "${app_dir}/usr/share/t3code/host"
cp "$(dirname "$0")/../host/"*.ts "${app_dir}/usr/share/t3code/host/"

export QML_SOURCES_PATHS="$(cd "$(dirname "$0")/.." && pwd)/qml"
export OUTPUT="${build_dir}/t3code-qt-x86_64.AppImage"
"${tools_dir}/linuxdeploy" --appdir "${app_dir}" --plugin qt --output appimage
echo "AppImage at ${OUTPUT}"
