#!/usr/bin/env bash
# Usage: release.sh <package-dir>
# See packaging/aur/README.md for the environment variables.
set -euo pipefail

package_dir="${1:?usage: release.sh <package-dir>}"
package_dir="$(cd "$package_dir" && pwd)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
pkgname="$(basename "$package_dir")"

UPSTREAM_REPO="${UPSTREAM_REPO:-${GITHUB_REPOSITORY:-pingdotgg/t3code}}"
AUR_COMMIT_NAME="${AUR_COMMIT_NAME:-t3code-ci}"
AUR_COMMIT_EMAIL="${AUR_COMMIT_EMAIL:-t3code-ci@users.noreply.github.com}"

case "$pkgname" in
  t3code-bin)
    tag_regex='^v[0-9]+\.[0-9]+\.[0-9]+$'
    prerelease=false
    ;;
  t3code-nightly-bin)
    tag_regex='^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.'
    prerelease=true
    ;;
  *)
    echo "Unknown package: $pkgname" >&2
    exit 1
    ;;
esac

if [[ -n "${RELEASE_TAG:-}" ]]; then
  release_json="$(gh api "repos/$UPSTREAM_REPO/releases/tags/$RELEASE_TAG")"
else
  release_json="$(gh api --paginate "repos/$UPSTREAM_REPO/releases?per_page=100" | jq -c '.[]')"
fi

release_json="$(jq -cs \
  --arg regex "$tag_regex" \
  --argjson prerelease "$prerelease" '
    map(select(
      (.draft | not)
      and .prerelease == $prerelease
      and (.tag_name | test($regex))
    )) | first // empty
  ' <<<"$release_json")"

if [[ -z "$release_json" ]]; then
  echo "No release matching $pkgname (tag='${RELEASE_TAG:-latest}'); nothing to do."
  exit 0
fi

tag="$(jq -r '.tag_name' <<<"$release_json")"
version="${tag#v}"
pkgver="$(printf '%s' "$version" | tr '-' '_' | tr -cd '[:alnum:]_.+')"

asset_json="$(jq -c '.assets | map(select(.name | test("^T3-Code-.*-x86_64\\.AppImage$"))) | first // empty' <<<"$release_json")"
if [[ -z "$asset_json" ]]; then
  echo "Release $tag has no x86_64 AppImage asset." >&2
  exit 1
fi

sha256="$(jq -r '.digest // empty' <<<"$asset_json")"
sha256="${sha256#sha256:}"
if [[ -z "$sha256" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --retry 3 "$(jq -r '.browser_download_url' <<<"$asset_json")" -o "$tmp/appimage"
  sha256="$(sha256sum "$tmp/appimage" | awk '{print $1}')"
fi

echo "Publishing $pkgname $pkgver (release $tag, sha256 $sha256)"

cd "$package_dir"
sed -Ei \
  -e "s/^pkgver=.*/pkgver=$pkgver/" \
  -e "s/^pkgrel=.*/pkgrel=${PKGREL:-1}/" \
  -e "s/^_upstream_tag=.*/_upstream_tag='$tag'/" \
  -e "s/^_upstream_version=.*/_upstream_version='$version'/" \
  -e "0,/^  '[0-9a-f]{64}'$/s//  '$sha256'/" \
  PKGBUILD
cp -f "$repo_root/LICENSE" LICENSE

run_makepkg() {
  if [[ "$(id -u)" == 0 ]]; then
    chown -R builder:builder "$package_dir"
    su builder -c "cd '$package_dir' && $*"
  else
    (cd "$package_dir" && "$@")
  fi
}

run_makepkg makepkg --printsrcinfo > .SRCINFO
run_makepkg makepkg -f --nodeps --noconfirm

if [[ -z "${AUR_SSH_PRIVATE_KEY:-}" ]]; then
  echo "AUR_SSH_PRIVATE_KEY is not set; skipping AUR push (dry run)."
  exit 0
fi

key_file="$(mktemp)"
hosts_file="$(mktemp)"
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$key_file"
chmod 600 "$key_file"
ssh-keyscan -H -t ed25519,rsa aur.archlinux.org > "$hosts_file" 2>/dev/null
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$hosts_file -o StrictHostKeyChecking=yes"

aur_dir="$(mktemp -d)"
git clone "ssh://aur@aur.archlinux.org/$pkgname.git" "$aur_dir"
cp -f PKGBUILD .SRCINFO LICENSE "$aur_dir/"

cd "$aur_dir"
git config user.name "$AUR_COMMIT_NAME"
git config user.email "$AUR_COMMIT_EMAIL"
git add -A
if git diff --cached --quiet; then
  echo "AUR already up to date."
  exit 0
fi
git commit -m "chore: update to $pkgver (from ${GITHUB_REPOSITORY:-local}@${GITHUB_SHA:-local})"
git push origin HEAD:master
