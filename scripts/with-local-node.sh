#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN_DIR="$ROOT_DIR/.local/node/bin"
if [ ! -x "$NODE_BIN_DIR/node" ]; then
  echo "Local Node runtime not found at $NODE_BIN_DIR/node" >&2
  echo "Run ./scripts/install-local-node.sh" >&2
  exit 1
fi
export PATH="$NODE_BIN_DIR:$PATH"
exec "$@"
