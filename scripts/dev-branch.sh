#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_NAME="$(basename "$ROOT_DIR")"
LOCAL_NODE_BIN_DIR="$ROOT_DIR/.local/node/bin"
SHARED_NODE_BIN_DIR="${T3CODE_SHARED_NODE_BIN_DIR:-$HOME/t3code/.local/node/bin}"

if [ -x "$LOCAL_NODE_BIN_DIR/node" ]; then
  NODE_BIN_DIR="$LOCAL_NODE_BIN_DIR"
elif [ -x "$SHARED_NODE_BIN_DIR/node" ]; then
  NODE_BIN_DIR="$SHARED_NODE_BIN_DIR"
else
  echo "No local Node runtime found for this worktree or at $SHARED_NODE_BIN_DIR/node" >&2
  echo "Run ./scripts/install-local-node.sh or set T3CODE_SHARED_NODE_BIN_DIR" >&2
  exit 1
fi

export PATH="$NODE_BIN_DIR:$PATH"
export T3CODE_STATE_DIR="${T3CODE_STATE_DIR:-$HOME/.t3/dev-worktrees/$WORKTREE_NAME}"

if [ -z "${T3CODE_PORT_OFFSET:-}" ] && [ -z "${T3CODE_DEV_INSTANCE:-}" ]; then
  export T3CODE_DEV_INSTANCE="$WORKTREE_NAME"
fi

MODE="${1:-dev}"
case "$MODE" in
  dev|dev:server|dev:web|dev:desktop)
    shift || true
    ;;
  *)
    echo "usage: ./scripts/dev-branch.sh [dev|dev:server|dev:web|dev:desktop] [-- extra args]" >&2
    exit 1
    ;;
esac

CMD=(bun run "$MODE")
if [ "$#" -gt 0 ]; then
  CMD+=(-- "$@")
fi

exec "${CMD[@]}"
