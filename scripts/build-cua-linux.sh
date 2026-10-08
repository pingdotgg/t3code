#!/usr/bin/env bash
# Build the Linux driver and SDK from the same patched source. Build hosts need
# Rust/rustup, git, and the X11/Wayland development libraries used by upstream.
set -euo pipefail

repo_root=$(cd "$1" && pwd)
arch=$2
output_dir=$3
version=${4:-0.34.0}
if [[ "$version" != "0.34.0" ]]; then
  echo "Update the Linux source pin and patch before shipping Cua Driver $version." >&2
  exit 1
fi
source_commit=b0968e1b12834e485dda68789541a3cc57664a9f
patch_file="$repo_root/patches/cua-driver-linux/0.34.0.patch"
case "$(uname -s):$(uname -m):$arch" in
  Linux:x86_64:x64|Linux:aarch64:arm64) ;;
  *) echo 'Patched Cua Driver must be built on a Linux host of the target architecture.' >&2; exit 1 ;;
esac
patch_hash=$(sha256sum "$patch_file" | cut -d ' ' -f 1)
cache_root="$repo_root/node_modules/.cache/t3code/cua-linux"
build_hash=$(cat "$patch_file" "$repo_root/scripts/build-cua-linux.sh" | sha256sum | cut -d ' ' -f 1)
cache_dir="$cache_root/$arch-$source_commit-$build_hash"
mkdir -p "$cache_root"
# Desktop and CLI packaging can share the build without racing a checkout or copy.
exec 9>"$cache_root/build.lock"
flock 9

if [[ ! -f "$cache_dir/bundle/SHA256SUMS" ]] || ! (cd "$cache_dir/bundle" && sha256sum --check --status SHA256SUMS); then
  mkdir -p "$cache_dir"
  source_dir="$cache_dir/source"
  if [[ ! -f "$source_dir/.t3-patched" ]]; then
    work_dir=$(mktemp -d "$cache_dir/source-XXXXXX")
    trap 'rm -rf "$work_dir"' EXIT
    git -C "$work_dir" init --quiet
    git -C "$work_dir" fetch --quiet --depth=1 https://github.com/trycua/cua.git "$source_commit"
    git -C "$work_dir" checkout --quiet --detach FETCH_HEAD
    git -C "$work_dir" apply --check "$patch_file"
    git -C "$work_dir" apply "$patch_file"
    touch "$work_dir/.t3-patched"
    mv "$work_dir" "$source_dir"
    trap - EXIT
  fi
  (
    cd "$source_dir/libs/cua-driver/rust"
    CARGO_TARGET_DIR="$cache_root/target-$arch" cargo build --locked --release \
      -p cua-driver -p cua-driver-sdk -p cursor-theme-cli --features cua-driver/portal-input
  )
  bundle_dir=$(mktemp -d "$cache_dir/bundle-XXXXXX")
  trap 'rm -rf "$bundle_dir"' EXIT
  chmod 755 "$bundle_dir"
  for binary in cua-driver cua-cursor-theme libcua_driver_sdk.so; do
    cp "$cache_root/target-$arch/release/$binary" "$bundle_dir/$binary"
  done
  mkdir -p "$bundle_dir/wayland-helper"
  cp -a "$source_dir/libs/cua-driver/wayland-helper/winrects@cua" "$bundle_dir/wayland-helper/"
  cp "$source_dir/LICENSE.md" "$bundle_dir/LICENSE"
  cp "$source_dir/libs/cua-driver/rust/THIRD_PARTY_NOTICES.md" "$bundle_dir/THIRD_PARTY_NOTICES.md"
  (cd "$bundle_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
  # A failed build never publishes a partially updated bundle.
  rm -rf "$cache_dir/bundle"
  mv "$bundle_dir" "$cache_dir/bundle"
  trap - EXIT
fi
mkdir -p "$output_dir"
cp -a "$cache_dir/bundle/." "$output_dir/"
echo "Staged patched Cua Driver 0.34.0 ($arch, patch $patch_hash)."
