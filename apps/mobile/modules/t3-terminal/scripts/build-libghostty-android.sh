#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${MODULE_DIR}/../../../../native/libghostty-vt"
PATCH_DIR="${SCRIPT_DIR}/libghostty-android-patches"

GHOSTTY_REVISION="${GHOSTTY_REVISION:-9f62873bf195e4d8a762d768a1405a5f2f7b1697}"
GHOSTTY_SOURCE_DIR="${GHOSTTY_SOURCE_DIR:-${HOME}/.cache/t3code/ghostty-${GHOSTTY_REVISION:0:8}}"
GHOSTTY_ZIG_VERSION="${GHOSTTY_ZIG_VERSION:-0.15.2}"
GHOSTTY_ZIG="${GHOSTTY_ZIG:-}"
GHOSTTY_ZIG_SHA256="${GHOSTTY_ZIG_SHA256:-}"
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
    return
  fi

  local actual_sha256
  if [[ -z "${GHOSTTY_ZIG_SHA256}" ]]; then
    # From https://ziglang.org/download/index.json.
    case "${GHOSTTY_ZIG_VERSION}-${host_arch}-${host_os}" in
      0.15.2-x86_64-linux) GHOSTTY_ZIG_SHA256="02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239" ;;
      0.15.2-aarch64-linux) GHOSTTY_ZIG_SHA256="958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f" ;;
      0.15.2-x86_64-macos) GHOSTTY_ZIG_SHA256="375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f" ;;
      0.15.2-aarch64-macos) GHOSTTY_ZIG_SHA256="3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b" ;;
      *) die "no pinned SHA-256 for Zig ${GHOSTTY_ZIG_VERSION} (${host_arch}-${host_os}); set GHOSTTY_ZIG_SHA256" ;;
    esac
  fi

  require_cmd curl
  require_cmd tar
  mkdir -p "${cache_dir%/*}"
  zig_download_dir="$(mktemp -d "${cache_dir}.XXXXXX")"
  trap 'rm -rf "${zig_download_dir}"' EXIT
  log "downloading Zig ${GHOSTTY_ZIG_VERSION}"
  curl -fsSL -o "${zig_download_dir}/zig.tar.xz" \
    "https://ziglang.org/download/${GHOSTTY_ZIG_VERSION}/zig-${host_arch}-${host_os}-${GHOSTTY_ZIG_VERSION}.tar.xz"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "${zig_download_dir}/zig.tar.xz")"
  else
    require_cmd shasum
    actual_sha256="$(shasum -a 256 "${zig_download_dir}/zig.tar.xz")"
  fi
  actual_sha256="${actual_sha256%% *}"
  [[ "${actual_sha256}" == "${GHOSTTY_ZIG_SHA256}" ]] || \
    die "Zig ${GHOSTTY_ZIG_VERSION} checksum mismatch: expected ${GHOSTTY_ZIG_SHA256}, got ${actual_sha256}"

  mkdir "${zig_download_dir}/zig"
  tar -xJf "${zig_download_dir}/zig.tar.xz" --strip-components=1 -C "${zig_download_dir}/zig"
  # A cache dir without an executable zig would make mv nest into it.
  rm -rf "${cache_dir}"
  mv "${zig_download_dir}/zig" "${cache_dir}"
  rm -rf "${zig_download_dir}"
  trap - EXIT
}

ensure_ghostty_source() {
  if [[ ! -d "${GHOSTTY_SOURCE_DIR}/.git" ]]; then
    require_cmd git
    log "cloning Ghostty ${GHOSTTY_REVISION}"
    git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty.git \
      "${GHOSTTY_SOURCE_DIR}"
    git -C "${GHOSTTY_SOURCE_DIR}" fetch --depth=1 origin "${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" checkout --detach "${GHOSTTY_REVISION}"
  fi

  local actual_revision
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
    if git -C "${GHOSTTY_SOURCE_DIR}" apply --reverse --check "${patch_file}" >/dev/null 2>&1; then
      log "patch already applied: ${patch_name}"
      continue
    fi
    log "applying patch: ${patch_name}"
    git -C "${GHOSTTY_SOURCE_DIR}" apply --check "${patch_file}"
    git -C "${GHOSTTY_SOURCE_DIR}" apply "${patch_file}"
  done
}

if [[ -z "${ANDROID_NDK_HOME}" ]]; then
  die "ANDROID_NDK_HOME must point to an installed Android NDK"
fi
[[ -d "${ANDROID_NDK_HOME}" ]] || die "Android NDK not found: ${ANDROID_NDK_HOME}"

ensure_zig
ensure_ghostty_source
apply_ghostty_patches

strip_tool="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt"
strip_tool="$(find "${strip_tool}" -path '*/bin/llvm-strip' -print -quit)"
[[ -x "${strip_tool}" ]] || die "llvm-strip not found under ${ANDROID_NDK_HOME}"

targets=(
  "arm64-v8a:aarch64-linux-android"
  "armeabi-v7a:arm-linux-androideabi"
  "x86:x86-linux-android"
  "x86_64:x86_64-linux-android"
)

build_root="$(mktemp -d)"
trap 'rm -rf "${build_root}"' EXIT
mkdir -p "${VENDOR_DIR}/include"

for entry in "${targets[@]}"; do
  abi="${entry%%:*}"
  target="${entry#*:}"
  prefix="${build_root}/${abi}"
  log "building ${abi} (${target})"
  (
    cd "${GHOSTTY_SOURCE_DIR}"
    ANDROID_NDK_HOME="${ANDROID_NDK_HOME}" "${GHOSTTY_ZIG}" build \
      -Demit-lib-vt \
      -Dtarget="${target}" \
      -Doptimize=ReleaseFast \
      -Dstrip=true \
      -Dsimd=false \
      -p "${prefix}"
  )

  mkdir -p "${MODULE_DIR}/android/src/main/jniLibs/${abi}"
  cp "${prefix}/lib/libghostty-vt.so.0.1.0" \
    "${MODULE_DIR}/android/src/main/jniLibs/${abi}/libghostty-vt.so"
  "${strip_tool}" --strip-unneeded \
    "${MODULE_DIR}/android/src/main/jniLibs/${abi}/libghostty-vt.so"
done

rm -rf "${VENDOR_DIR}/include/ghostty"
cp -R "${build_root}/arm64-v8a/include/ghostty" "${VENDOR_DIR}/include/ghostty"
cp "${GHOSTTY_SOURCE_DIR}/LICENSE" "${VENDOR_DIR}/LICENSE"
printf '%s\n' "${GHOSTTY_REVISION}" > "${VENDOR_DIR}/VERSION"
log "done"
