#!/usr/bin/env bash
# Builds this machine's standalone Linux CLI archive for a fork release, the same way
# .github/workflows/fork-release.yml does. Needs vp (with Node from engines.node), cargo,
# patchelf, and libatomic1. Usage: scripts/build-standalone-linux-cli.sh <version> <owner/repo> <out-dir>
set -euo pipefail

version="$1"
export GITHUB_REPOSITORY="$2"
out_dir="$3"
export T3CODE_STANDALONE=1

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

node scripts/update-release-package-versions.ts "$version"
vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe --verbose

cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
monitor_dir="$(mktemp -d)"
mkdir -p "$monitor_dir/linux-$arch"
cp native/resource-monitor/target/release/t3-resource-monitor "$monitor_dir/linux-$arch/"

node scripts/build-cli-archive.ts --platform linux --arch "$arch" --version "$version" \
  --resource-monitor-dir "$monitor_dir" --output-dir "$out_dir"
node scripts/smoke-cli-archive.ts --archive "$out_dir/t3-$version-linux-$arch.tar.gz" \
  --expect-version "$version"
