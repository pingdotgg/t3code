#!/usr/bin/env bash
# Adds modular panels to the AUR's t3code-nightly-bin. AUR updates replace the patched app, so run
# this again after each one. To undo it, reinstall t3code-nightly-bin.
set -euo pipefail

PACKAGE=t3code-nightly-bin
ASAR=/opt/$PACKAGE/resources/app.asar
UPSTREAM=https://github.com/pingdotgg/t3code
PATCH_URL=$UPSTREAM/compare/main...faetalize:t3code:feature/modular-panel-system.diff
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/t3code-panels

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

[[ $EUID -ne 0 ]] || die "run this as your normal user. It asks for your password when it needs it."
command -v pacman >/dev/null || die "this script is for Arch Linux."
pacman -Q "$PACKAGE" >/dev/null 2>&1 || die "$PACKAGE is not installed."
[[ -f $ASAR ]] || die "$ASAR is missing."

missing=()
for tool in curl git tar xz; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]} > 0)); then
  say "Installing ${missing[*]} (sudo may ask for your password)"
  sudo pacman -S --needed --noconfirm "${missing[@]}"
fi

read -r _ pkgver < <(pacman -Q "$PACKAGE")
version=${pkgver%-*}
version=${version/_nightly./-nightly.}

mkdir -p "$CACHE"
work=$(mktemp -d "$CACHE/build.XXXXXX")
trap 'rm -rf "$work"' EXIT

say "Downloading the panels patch"
curl -fsSL "$PATCH_URL" -o "$work/panels.diff"
patch_hash=$(sha256sum "$work/panels.diff" | cut -d' ' -f1)
state="$version $patch_hash $(sha256sum "$ASAR" | cut -d' ' -f1)"
if [[ -f $CACHE/installed && $(<"$CACHE/installed") == "$state" ]]; then
  say "Nightly $version already has this version of the panels. Nothing to do."
  exit 0
fi

say "Downloading the source of nightly $version"
mkdir "$work/src"
curl -fsSL "$UPSTREAM/archive/refs/tags/v$version.tar.gz" |
  tar -xz --strip-components=1 -C "$work/src"
cd "$work/src"
# Its own repo, so git apply works even when a parent folder is a git repo.
git init -q

say "Applying the patch"
if ! git apply --include='apps/web/*' "$work/panels.diff" 2>"$work/apply.log"; then
  sed -n 's/^error: patch failed: \(.*\):[0-9]*$/  \1/p' "$work/apply.log" | sort -u >&2
  die "the patch doesn't fit nightly $version yet, so your nightly was left as it is. Update to the newest nightly and run this again. If it is already the newest, try again after the next one."
fi

node_version=$(grep -oP '"node": "\K[^"]+' package.json)
pnpm_version=$(grep -oP '"packageManager": "pnpm@\K[^"]+' package.json)
case $(uname -m) in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)." ;;
esac
node_dir="$CACHE/node-v$node_version-linux-$node_arch"
if [[ ! -x $node_dir/bin/node ]]; then
  say "Downloading Node $node_version"
  node_tar="node-v$node_version-linux-$node_arch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$node_version/$node_tar" -o "$work/$node_tar"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work" && grep " $node_tar\$" SHASUMS256.txt | sha256sum -c --quiet -)
  tar -xJf "$work/$node_tar" -C "$CACHE"
fi
tools="$CACHE/tools-pnpm-$pnpm_version"
export PATH="$tools/node_modules/.bin:$node_dir/bin:$PATH"
if [[ ! -x $tools/node_modules/.bin/pnpm ]]; then
  say "Downloading pnpm $pnpm_version"
  npm install --silent --no-audit --no-fund --prefix "$tools" "pnpm@$pnpm_version" @electron/asar@4
fi

say "Unpacking your nightly"
asar extract "$ASAR" "$work/app"
client="$work/app/apps/server/dist/client"

say "Installing dependencies"
CI=1 pnpm install --frozen-lockfile --silent

say "Typechecking"
node_modules/.bin/vp run --filter @t3tools/web typecheck >"$work/typecheck.log" 2>&1 || {
  tail -n 20 "$work/typecheck.log" >&2
  die "the patched code doesn't typecheck on nightly $version, so your nightly was left as it is."
}

# The release bakes these public values into the client. Without them T3 Connect stops working.
baked() { grep -rohP -m1 "$1" "$client/assets" --include='*.js' | head -n 1 || true; }
export T3CODE_CLERK_PUBLISHABLE_KEY VITE_CLERK_PUBLISHABLE_KEY
T3CODE_CLERK_PUBLISHABLE_KEY=$(baked 'clerkPublishableKey:\w+\(`\K[^`]+')
VITE_CLERK_PUBLISHABLE_KEY=$T3CODE_CLERK_PUBLISHABLE_KEY
export T3CODE_CLERK_JWT_TEMPLATE VITE_CLERK_JWT_TEMPLATE
T3CODE_CLERK_JWT_TEMPLATE=$(baked 'clerkJwtTemplate:\w+\(`\K[^`]+')
VITE_CLERK_JWT_TEMPLATE=$T3CODE_CLERK_JWT_TEMPLATE
export T3CODE_RELAY_URL VITE_T3CODE_RELAY_URL
T3CODE_RELAY_URL=$(baked 'relayUrl:\w+\(`\K[^`]+')
VITE_T3CODE_RELAY_URL=$T3CODE_RELAY_URL
[[ -n $T3CODE_CLERK_PUBLISHABLE_KEY && -n $T3CODE_RELAY_URL ]] ||
  die "couldn't read T3 Connect's settings from nightly $version, so your nightly was left as it is."

say "Building the client"
(cd apps/web && APP_VERSION=$version T3CODE_WEB_SOURCEMAP=false \
  T3CODE_DESKTOP_UPDATE_REPOSITORY=pingdotgg/t3code \
  ../../node_modules/.bin/vp build >"$work/build.log" 2>&1) || {
  tail -n 20 "$work/build.log" >&2
  die "the client didn't build, so your nightly was left as it is."
}
node scripts/apply-web-brand-assets.ts nightly apps/web/dist >/dev/null

say "Repacking"
asar list "$ASAR" | grep -v '^/apps/server/dist/client' | sort >"$work/before.txt"
rm -rf "$client"
cp -r apps/web/dist "$client"
unpacked=$(cd "$ASAR.unpacked" && find . -type f -printf '%P\n' | paste -sd,)
cd "$work"
asar pack app patched.asar --unpack "**/{$unpacked,__none__}"
asar list patched.asar | grep -v '^/apps/server/dist/client' | sort >after.txt
cmp -s before.txt after.txt || die "the repacked app has different files, so your nightly was left as it is."
diff -rq "$ASAR.unpacked" patched.asar.unpacked >/dev/null ||
  die "the repacked app has different native files, so your nightly was left as it is."

say "Installing (sudo may ask for your password)"
sudo install -m 644 patched.asar "$ASAR.new"
sudo mv -f "$ASAR.new" "$ASAR"
echo "$version $patch_hash $(sha256sum "$ASAR" | cut -d' ' -f1)" >"$CACHE/installed"

say "Done. Restart T3 Code to get the panels."
