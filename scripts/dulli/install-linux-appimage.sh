#!/usr/bin/env bash
set -euo pipefail

repo="${T3_DULLI_GITHUB_REPOSITORY:-YJJosh/t3dulli}"
tag="${1:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
appimage="$install_dir/t3-dulli.AppImage"
launcher="$install_dir/t3-dulli"
desktop_file="$data_home/applications/t3-dulli-clean.desktop"
icon_file="$data_home/icons/hicolor/1024x1024/apps/t3-dulli-clean.png"

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI (gh) is required." >&2
  exit 1
}

if [[ -z "$tag" ]]; then
  tag="$(
    gh api "repos/$repo/releases?per_page=100" --jq \
      '.[] | select(.draft == false and .prerelease == true) | select(any(.assets[]; .name | test("^T3-Dulli-(.+-)?x86_64\\.AppImage$"))) | .tag_name' \
      | head -n 1
  )"
fi
if [[ -z "$tag" ]]; then
  echo "No T3 Dulli AppImage prerelease was found in $repo." >&2
  exit 1
fi

# Releases before 0.1.10-dulli.1 carry the version in the AppImage name.
asset="$(
  gh api "repos/$repo/releases/tags/$tag" --jq \
    '[.assets[].name | select(test("^T3-Dulli-(.+-)?x86_64\\.AppImage$"))][0] // empty'
)"
[[ -n "$asset" ]] || {
  echo "Release $tag has no T3 Dulli AppImage." >&2
  exit 1
}
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$tmp_dir"
[[ -s "$tmp_dir/$asset" ]] || {
  echo "Downloaded AppImage is empty: $asset" >&2
  exit 1
}

mkdir -p "$install_dir" "$(dirname "$desktop_file")" "$(dirname "$icon_file")"
install -m 0755 "$tmp_dir/$asset" "$appimage"
install -m 0644 "$repo_root/assets/dulli/dulli-universal-1024.png" "$icon_file"

{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf 'exec %q --no-sandbox "$@"\n' "$appimage"
} > "$launcher"
chmod 0755 "$launcher"

cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Name=T3 Dulli
GenericName=AI coding agent
Comment=Community desktop build of T3 Code
Exec=$launcher %U
Icon=$icon_file
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=t3-dulli
StartupNotify=true
Keywords=t3;dulli;pi;workler;code;editor;
DESKTOP
chmod 0644 "$desktop_file"

update-desktop-database "$(dirname "$desktop_file")" >/dev/null 2>&1 || true
gtk-update-icon-cache "$data_home/icons/hicolor" >/dev/null 2>&1 || true

echo "Installed T3 Dulli $tag at $appimage"
echo "Future releases are installed through T3 Dulli's built-in updater."
