#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin ]]; then
  echo "t3-build-install requires macOS." >&2
  exit 1
fi

if [[ $# -gt 1 ]]; then
  echo "Usage: t3-build-install [t3code-checkout]" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  source_dir=$1
else
  source_dir=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [[ ! -f "$source_dir/scripts/build-desktop-artifact.ts" ]]; then
    script_path=$(realpath "${BASH_SOURCE[0]}")
    source_dir=$(cd "$(dirname "$script_path")/.." && pwd -P)
  fi
fi

if [[ ! -f "$source_dir/scripts/build-desktop-artifact.ts" ]]; then
  echo "Not a T3 Code checkout: $source_dir" >&2
  exit 1
fi
source_dir=$(cd "$source_dir" && pwd -P)

node24_dir=""
brew_node24_dir=""
if command -v brew >/dev/null 2>&1; then
  brew_node24_dir="$(brew --prefix node@24 2>/dev/null || true)/bin"
fi
for candidate in "$brew_node24_dir" "$HOME"/.nvm/versions/node/v24.*/bin; do
  if [[ -x "$candidate/node" ]] && [[ $("$candidate/node" -p 'process.versions.node.split(".")[0]') == 24 ]]; then
    node24_dir=$candidate
    break
  fi
done
if [[ -z "$node24_dir" ]] && command -v node >/dev/null 2>&1 &&
  [[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]]; then
  node24_dir=$(dirname "$(command -v node)")
fi
if [[ -z "$node24_dir" ]] && command -v brew >/dev/null 2>&1; then
  brew install node@24
  node24_dir="$(brew --prefix node@24)/bin"
fi
if [[ ! -x "$node24_dir/node" ]]; then
  echo "Could not find or install Node 24." >&2
  exit 1
fi
export PATH="$node24_dir:$PATH"
hash -r
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install pnpm
  else
    echo "pnpm is required to build T3 Code." >&2
    exit 1
  fi
fi

export PATH="$HOME/.cargo/bin:$source_dir/node_modules/.bin:$PATH"
export RUSTUP_TOOLCHAIN=stable

case $(uname -m) in
  arm64) build_arch=arm64 ;;
  x86_64) build_arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

cd "$source_dir"
pnpm install --frozen-lockfile
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$build_arch"

app_version=$(node -p 'require("./apps/server/package.json").version')
app_name=$(node -p 'require("./apps/desktop/package.json").productName + ".app"')
archive="$source_dir/release/T3-Code-$app_version-$build_arch.zip"
if [[ ! -f "$archive" ]]; then
  echo "Build did not produce $archive" >&2
  exit 1
fi

install_dir="$HOME/Applications"
mkdir -p "$install_dir"
destination="$install_dir/$app_name"
if [[ -d "$destination" ]] && lsof -t "$destination/Contents/MacOS/${app_name%.app}" >/dev/null 2>&1; then
  destination="$install_dir/${app_name%.app} Build $(date +%Y%m%d-%H%M%S)-$$.app"
  echo "The installed app is running; installing this build alongside it." >&2
fi

stage=$(mktemp -d "$install_dir/.t3-build-install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
ditto -x -k "$archive" "$stage"
if [[ ! -d "$stage/$app_name" ]]; then
  echo "Archive does not contain $app_name" >&2
  exit 1
fi
if [[ ! -f "$stage/$app_name/Contents/Resources/app.asar" ]]; then
  echo "Archive does not contain the packaged app code." >&2
  exit 1
fi
staged_version=$(plutil -extract CFBundleShortVersionString raw \
  "$stage/$app_name/Contents/Info.plist")
if [[ "$staged_version" != "$app_version" ]]; then
  echo "Built app version mismatch: $staged_version (expected $app_version)" >&2
  exit 1
fi
expected_hash=$(shasum -a 256 "$stage/$app_name/Contents/Resources/app.asar" | awk '{print $1}')

if [[ -e "$destination" ]]; then
  mv "$destination" "$stage/previous.app"
fi
if ! mv "$stage/$app_name" "$destination"; then
  if [[ -d "$stage/previous.app" ]]; then
    mv "$stage/previous.app" "$destination"
  fi
  exit 1
fi

installed_hash=$(shasum -a 256 "$destination/Contents/Resources/app.asar" | awk '{print $1}')
if [[ "$installed_hash" != "$expected_hash" ]]; then
  mv "$destination" "$stage/failed.app"
  if [[ -d "$stage/previous.app" ]]; then
    mv "$stage/previous.app" "$destination"
  fi
  echo "Installed app did not match the built app; restored the previous copy." >&2
  exit 1
fi

echo "Installed $destination ($staged_version, $build_arch)"
if [[ "$destination" != "$install_dir/$app_name" ]]; then
  echo "Quit the running T3 Code app before opening this build."
fi
