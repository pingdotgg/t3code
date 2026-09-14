#!/bin/sh
# Installs the T3 Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://t3.codes/install.sh | sh
#
# Environment:
#   T3CODE_VERSION           exact version to install (default: latest preview release)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `t3 service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="pingdotgg/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 't3 install: %s\n' "$1" >&2
  exit 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    fail "curl or wget is required"
  fi
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  # Preview is the only train shipping archives while they are being dogfooded.
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=50" "$tmp_index"
  version="$(sed -n 's/.*"tag_name": *"v\([0-9][^"]*-preview\.[0-9]*\.[0-9]*\)".*/\1/p' "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a preview release; set T3CODE_VERSION"
fi

stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  printf 't3 %s is already installed at %s\n' "$version" "$target_dir"
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT

  printf 'Downloading %s...\n' "$archive"
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS"
  fetch "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

mkdir -p "$bin_dir"
ln -sfn "${target_dir}/t3" "${bin_dir}/t3"
printf 'Installed t3 %s\n  %s -> %s\n' "$version" "${bin_dir}/t3" "${target_dir}/t3"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) printf 'Add %s to your PATH to run `t3`.\n' "$bin_dir" ;;
esac
