#!/usr/bin/env bash
# Build-time container setup, baked into the image and prebuilds. Feature
# installs run as root; _REMOTE_USER and _REMOTE_USER_HOME come from the
# devcontainer tooling. Content-dependent work lives in update-content.sh.
set -euo pipefail

user="${_REMOTE_USER:-vscode}"
home="${_REMOTE_USER_HOME:-/home/$user}"

# Docker creates the parent of a volume mount root-owned when it is missing.
# devcontainer.json mounts the pnpm store at ~/.cache/pnpm, so pre-create the
# path owned by the user: the mount then inherits that ownership and tools can
# still write under ~/.cache.
install -d -o "$user" -g "$user" "$home/.cache" "$home/.cache/pnpm"

# The Vite+ CLI is the repo task runner (vp i, vp run dev, vp test run).
# Download to a file first: a curl failure inside $( ) would yield an empty
# script and a false success. VP_NODE_MANAGER=no skips the installer's node
# shims; Node comes from the devcontainer feature. The VP_*_DIR group (set
# together, absolute) pins the install location instead of the installer's
# XDG platform defaults, which moved the binary from ~/.vite-plus/bin to
# ~/.local/share/vite-plus/bin between releases and would break the check
# below either way.
installer=$(mktemp)
chmod 644 "$installer"
curl -fsSL https://vite.plus -o "$installer"
su "$user" -s /bin/bash -c '
  set -euo pipefail
  export HOME="$1"
  export VP_BIN_DIR="$HOME/.local/share/vite-plus/bin"
  export VP_DATA_DIR="$HOME/.local/share/vite-plus"
  export VP_CACHE_DIR="$HOME/.cache/vite-plus"
  VP_NODE_MANAGER=no bash "$2"
' _ "$home" "$installer"
rm -f "$installer"

# Non-login lifecycle shells never source the profile the installer edits,
# so expose vp on the default PATH. test -x keeps a bad install loud.
vp_bin="$home/.local/share/vite-plus/bin/vp"
test -x "$vp_bin"
ln -sf "$vp_bin" /usr/local/bin/vp

# First-run terminal notice, rendered by the devcontainers base image.
mkdir -p /usr/local/etc/vscode-dev-containers
cat > /usr/local/etc/vscode-dev-containers/first-run-notice.txt <<'NOTICE'
T3 Code devcontainer

  vp run dev            start server + web, then open the pairing URL it
                        prints (the bare forwarded port will not authenticate)
  cp .env.example .env  optional: enable T3 Connect cloud features
                        (public identifiers, not secrets)

Details: docs/operations/01_devcontainer.md
NOTICE
