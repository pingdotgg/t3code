#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${MODULE_DIR}/../../../../native/libghostty-vt"
PATCH_DIR="${SCRIPT_DIR}/libghostty-android-patches"

GHOSTTY_REVISION="$(tr -d '[:space:]' < "${VENDOR_DIR}/VERSION")"
GHOSTTY_SOURCE_DIR="${GHOSTTY_SOURCE_DIR:-${HOME}/.cache/t3code/ghostty-${GHOSTTY_REVISION:0:8}}"
GHOSTTY_ZIG_VERSION="${GHOSTTY_ZIG_VERSION:-0.16.0}"
GHOSTTY_ZIG="${GHOSTTY_ZIG:-}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-}"

log() {
  printf '[libghostty-vt-android] %s\n' "$*"
}

die() {
  printf '[libghostty-vt-android] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

ensure_zig() {
  if [[ -n "${GHOSTTY_ZIG}" ]]; then
    [[ -x "${GHOSTTY_ZIG}" ]] || die "GHOSTTY_ZIG is not executable: ${GHOSTTY_ZIG}"
    [[ "$("${GHOSTTY_ZIG}" version)" == "${GHOSTTY_ZIG_VERSION}" ]] || \
      die "Ghostty ${GHOSTTY_REVISION} requires Zig ${GHOSTTY_ZIG_VERSION}"
    return
  fi
  if command -v zig >/dev/null 2>&1 && [[ "$(zig version)" == "${GHOSTTY_ZIG_VERSION}" ]]; then
    GHOSTTY_ZIG="$(command -v zig)"
    return
  fi

  local host_os host_arch cache_dir
  host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  host_arch="$(uname -m)"
  case "${host_os}" in
    darwin) host_os="macos" ;;
    linux) ;;
    *) die "unsupported host OS for Zig download: ${host_os}" ;;
  esac
  case "${host_arch}" in
    arm64) host_arch="aarch64" ;;
    aarch64 | x86_64) ;;
    *) die "unsupported host architecture for Zig download: ${host_arch}" ;;
  esac

  cache_dir="${HOME}/.cache/t3code/zig-${GHOSTTY_ZIG_VERSION}"
  GHOSTTY_ZIG="${cache_dir}/zig"
  if [[ -x "${GHOSTTY_ZIG}" ]]; then
    [[ "$("${GHOSTTY_ZIG}" version)" == "${GHOSTTY_ZIG_VERSION}" ]] || \
      die "cached Zig does not report ${GHOSTTY_ZIG_VERSION}: ${GHOSTTY_ZIG}"
    return
  fi

  require_cmd curl
  require_cmd tar
  mkdir -p "${cache_dir}"
  log "downloading Zig ${GHOSTTY_ZIG_VERSION}"
  curl -fsSL \
    "https://ziglang.org/download/${GHOSTTY_ZIG_VERSION}/zig-${host_arch}-${host_os}-${GHOSTTY_ZIG_VERSION}.tar.xz" \
    | tar -xJ --strip-components=1 -C "${cache_dir}"
}

ensure_ghostty_source() {
  require_cmd git
  if ! git -C "${GHOSTTY_SOURCE_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
    mkdir -p "$(dirname "${GHOSTTY_SOURCE_DIR}")"
    log "cloning Ghostty ${GHOSTTY_REVISION}"
    git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty.git \
      "${GHOSTTY_SOURCE_DIR}"
  fi

  local actual_revision
  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "${actual_revision}" != "${GHOSTTY_REVISION}" ]]; then
    log "checking out Ghostty ${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" fetch --depth=1 origin "${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" checkout --detach "${GHOSTTY_REVISION}"
  fi

  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD)"
  [[ "${actual_revision}" == "${GHOSTTY_REVISION}" ]] || \
    die "expected Ghostty ${GHOSTTY_REVISION}, found ${actual_revision}"
}

apply_ghostty_patches() {
  [[ -d "${PATCH_DIR}" ]] || return

  local patch_file patch_name
  for patch_file in "${PATCH_DIR}"/*.patch; do
    [[ -e "${patch_file}" ]] || continue
    patch_name="$(basename "${patch_file}")"
    if git -C "${build_source}" apply --reverse --check "${patch_file}" >/dev/null 2>&1; then
      log "patch already applied: ${patch_name}"
      continue
    fi
    log "applying patch: ${patch_name}"
    git -C "${build_source}" apply --check "${patch_file}"
    git -C "${build_source}" apply "${patch_file}"
  done
}

if [[ -z "${ANDROID_NDK_HOME}" ]]; then
  die "ANDROID_NDK_HOME must point to an installed Android NDK"
fi
[[ -d "${ANDROID_NDK_HOME}" ]] || die "Android NDK not found: ${ANDROID_NDK_HOME}"

ensure_zig
ensure_ghostty_source

strip_tool="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt"
strip_tool="$(find "${strip_tool}" -path '*/bin/llvm-strip' -print -quit)"
[[ -x "${strip_tool}" ]] || die "llvm-strip not found under ${ANDROID_NDK_HOME}"
strings_tool="$(dirname "${strip_tool}")/llvm-strings"
[[ -x "${strings_tool}" ]] || die "llvm-strings not found under ${ANDROID_NDK_HOME}"

targets=(
  "arm64-v8a:aarch64-linux-android"
  "armeabi-v7a:arm-linux-androideabi"
  "x86:x86-linux-android"
  "x86_64:x86_64-linux-android"
)

build_root="$(mktemp -d)"
build_source="${build_root}/ghostty-source"
cleanup() {
  git -C "${GHOSTTY_SOURCE_DIR}" worktree remove --force "${build_source}" >/dev/null 2>&1 || true
  rm -rf "${build_root}"
}
trap cleanup EXIT
git -C "${GHOSTTY_SOURCE_DIR}" worktree add --quiet --detach \
  "${build_source}" "${GHOSTTY_REVISION}"
apply_ghostty_patches
mkdir -p "${VENDOR_DIR}/include"

for entry in "${targets[@]}"; do
  abi="${entry%%:*}"
  target="${entry#*:}"
  prefix="${build_root}/${abi}"
  log "building ${abi} (${target})"
  (
    cd "${build_source}"
    ANDROID_NDK_HOME="${ANDROID_NDK_HOME}" "${GHOSTTY_ZIG}" build \
      -Demit-lib-vt \
      -Dtarget="${target}" \
      -Doptimize=ReleaseFast \
      -Dstrip=true \
      -Dsimd=false \
      -Dlib-version-string="0.1.0-dev+${GHOSTTY_REVISION}" \
      -p "${prefix}"
  )

  mkdir -p "${MODULE_DIR}/android/src/main/jniLibs/${abi}"
  cp "${prefix}/lib/libghostty-vt.so.0.1.0" \
    "${MODULE_DIR}/android/src/main/jniLibs/${abi}/libghostty-vt.so"
  "${strip_tool}" --strip-unneeded \
    "${MODULE_DIR}/android/src/main/jniLibs/${abi}/libghostty-vt.so"
  "${strings_tool}" "${MODULE_DIR}/android/src/main/jniLibs/${abi}/libghostty-vt.so" \
    | grep -F "${GHOSTTY_REVISION}" >/dev/null || \
    die "${abi} artifact does not embed Ghostty ${GHOSTTY_REVISION}"
done

rm -rf "${VENDOR_DIR}/include/ghostty"
cp -R "${build_root}/arm64-v8a/include/ghostty" "${VENDOR_DIR}/include/ghostty"
# Zig's generated C docs can preserve trailing spaces from source comments.
# Normalize them so a clean rebuild also passes the repository whitespace gate.
while IFS= read -r -d '' header; do
  sed 's/[[:space:]]*$//' "${header}" > "${header}.tmp"
  mv "${header}.tmp" "${header}"
done < <(find "${VENDOR_DIR}/include/ghostty" -type f -name '*.h' -print0)
cp "${build_source}/LICENSE" "${VENDOR_DIR}/LICENSE"
printf '%s\n' "${GHOSTTY_REVISION}" > "${VENDOR_DIR}/VERSION"
log "done"
