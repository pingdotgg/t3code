#!/usr/bin/env bash
# Builds an AppImage from a Release build directory with linuxdeploy and its
# Qt plugin (downloaded on first use). Usage: package-linux.sh <build-dir>
set -euo pipefail

build_dir="${1:?build directory}"
app_dir="${build_dir}/AppDir"
tools_dir="${build_dir}/tools"
mkdir -p "${tools_dir}"

fetch() {
  local url="$1" out="$2" digest="$3"
  if [ ! -f "${out}" ]; then
    curl -fsSL "${url}" -o "${out}"
  fi
  printf '%s  %s\n' "${digest}" "${out}" | sha256sum --check --status
  chmod +x "${out}"
}
fetch "https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-x86_64.AppImage" "${tools_dir}/linuxdeploy-1-alpha-20251107-1" "c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d"
fetch "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-qt-x86_64.AppImage" "${tools_dir}/linuxdeploy-plugin-qt" "15106be885c1c48a021198e7e1e9a48ce9d02a86dd0a1848f00bdbf3c1c92724"

rm -rf "${app_dir}"
cmake --install "${build_dir}" --prefix "${app_dir}/usr"

# Desktop entry + icon: the app id (t3code) must match what the shell sets so
# compositor rules can target the window.
mkdir -p "${app_dir}/usr/share/applications" "${app_dir}/usr/share/icons/hicolor/1024x1024/apps"
cat > "${app_dir}/usr/share/applications/t3code.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=T3 Code
Exec=t3code-qt
Icon=t3code
Categories=Development;
StartupWMClass=t3code
DESKTOP
icon_source="$(dirname "$0")/../../../assets/prod/black-universal-1024.png"
cp "${icon_source}" "${app_dir}/usr/share/icons/hicolor/1024x1024/apps/t3code.png"

node "$(dirname "$0")/stage-runtime.mjs" "${app_dir}/usr/share/t3code"

export QML_SOURCES_PATHS="$(cd "$(dirname "$0")/.." && pwd)/qml"
export OUTPUT="${build_dir}/t3code-qt-x86_64.AppImage"
"${tools_dir}/linuxdeploy-1-alpha-20251107-1" --appdir "${app_dir}" --plugin qt --output appimage
echo "AppImage at ${OUTPUT}"
