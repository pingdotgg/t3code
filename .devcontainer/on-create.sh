#!/usr/bin/env bash
# One-time container setup, baked into prebuilds. Content-dependent work
# (dependency install, Chromium) lives in update-content.sh.
set -euo pipefail

# The Vite+ CLI is the repo task runner (vp i, vp run dev, vp test run).
# Download to a file first: a curl failure inside $( ) would yield an empty
# script and a false success. VP_NODE_MANAGER=no skips the installer's node
# shims; Node comes from the devcontainer feature.
installer=$(mktemp)
curl -fsSL https://vite.plus -o "$installer"
VP_NODE_MANAGER=no bash "$installer"
rm -f "$installer"

# Non-login lifecycle shells never source the profile the installer edits,
# so expose vp on the default PATH. test -x keeps a layout change loud.
test -x "$HOME/.vite-plus/bin/vp"
sudo ln -sf "$HOME/.vite-plus/bin/vp" /usr/local/bin/vp

# First-run terminal notice, rendered by the devcontainers base image.
sudo mkdir -p /usr/local/etc/vscode-dev-containers
sudo tee /usr/local/etc/vscode-dev-containers/first-run-notice.txt >/dev/null <<'EOF'
T3 Code devcontainer

  vp run dev            start server + web, then open the pairing URL it
                        prints (the bare forwarded port will not authenticate)
  cp .env.example .env  optional: enable T3 Connect cloud features
                        (public identifiers, not secrets)

Details: docs/internals/devcontainer.md
EOF
