#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
repo='pingdotgg/t3code'
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
pkgrel="${PKGREL:-1}"

if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  pkgname='t3code-bin'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname='t3code-nightly-bin'
else
  echo "Release $tag does not publish an AUR package."
  exit 0
fi

version="${tag#v}"
pkgver="${version//-/_}"
release_json="$(gh api "repos/$repo/releases/tags/$tag")"
declare -A appimage_names appimage_checksums
for architecture in x86_64 aarch64; do
  upstream_arch="${architecture/aarch64/arm64}"
  if ! asset="$(jq -er --arg suffix "-${upstream_arch}.AppImage" '
    [.assets[] | select(.name | startswith("T3-Code-") and endswith($suffix))]
    | select(length == 1) | .[0] | [.name, .digest] | @tsv
  ' <<<"$release_json")"; then
    echo "Release $tag must contain exactly one T3 Code $upstream_arch AppImage." >&2
    exit 1
  fi
  IFS=$'\t' read -r asset_name asset_digest <<<"$asset"
  checksum="${asset_digest#sha256:}"
  if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Release $tag is missing the SHA-256 digest for $asset_name." >&2
    exit 1
  fi
  appimage_names[$architecture]="$asset_name"
  appimage_checksums[$architecture]="$checksum"
done

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$repo/contents/LICENSE?ref=$tag" > "$work_dir/LICENSE"
license_sha256="$(sha256sum "$work_dir/LICENSE" | awk '{print $1}')"

package_dir="$repo_root/packaging/aur/$pkgname"
cd "$package_dir"
sed -Ei \
  -e "s/^pkgver=.*/pkgver=$pkgver/" \
  -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
  -e "/# upstream license$/s/'[0-9a-f]{64}'/'$license_sha256'/" \
  PKGBUILD

for architecture in x86_64 aarch64; do
  sed -Ei \
    -e "s/^_asset_${architecture}=.*/_asset_${architecture}=\"${appimage_names[$architecture]}\"/" \
    -e "s/^sha256sums_${architecture}=.*/sha256sums_${architecture}=('${appimage_checksums[$architecture]}')/" \
    PKGBUILD
done

run_as_builder() {
  if [[ "$(id -u)" == 0 ]]; then
    runuser -u builder -- "$@"
  else
    "$@"
  fi
}

if [[ "$(id -u)" == 0 ]]; then
  chown -R builder:builder "$package_dir"
fi
run_as_builder namcap PKGBUILD
run_as_builder makepkg --printsrcinfo > .SRCINFO
run_as_builder makepkg --syncdeps --cleanbuild --clean --noconfirm
run_as_builder namcap "$(run_as_builder makepkg --packagelist)"

if [[ -z "${AUR_SSH_PRIVATE_KEY:-}" ]]; then
  echo 'AUR_SSH_PRIVATE_KEY is not set; build complete, skipping publish.'
  exit 0
fi

key_file="$work_dir/id_ed25519"
known_hosts_file="$work_dir/known_hosts"
aur_dir="$work_dir/$pkgname"
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$key_file"
chmod 600 "$key_file"
printf '%s\n' \
  'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN' \
  > "$known_hosts_file"
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts_file -o StrictHostKeyChecking=yes"

git clone "ssh://aur@aur.archlinux.org/$pkgname.git" "$aur_dir"
cp PKGBUILD .SRCINFO "$aur_dir/"
cd "$aur_dir"
git rm --ignore-unmatch LICENSE .upstream-commit t3code-icon.png
git config user.name 't3code-ci'
git config user.email 't3code-ci@users.noreply.github.com'
git add -A

if git diff --cached --quiet; then
  echo 'AUR package is already up to date.'
  exit 0
fi

git commit -m "$pkgname: update to $pkgver-$pkgrel"
git push origin HEAD:master
