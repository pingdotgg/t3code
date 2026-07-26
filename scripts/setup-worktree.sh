#!/usr/bin/env bash
# Make a git worktree usable: install dependencies, link local secrets, and
# check the fork-safety invariants.
#
# SergeCode creates a fresh worktree per thread, and a fresh worktree has no
# `node_modules`. Nothing announces that; the first symptom is an unrelated
# error like `Could not resolve 'vite-plus/test/config'` or
# `vp: command not found`, several commands into the work. This script is
# invoked automatically by `.vite-hooks/post-checkout` when a worktree is
# created, and can be re-run by hand at any time.
#
# Idempotent and quiet on the happy path: with a warm pnpm store and an
# existing install it exits in well under a second.
#
# Usage:
#   scripts/setup-worktree.sh          # install only if needed
#   scripts/setup-worktree.sh --force  # reinstall regardless
set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { echo "[setup-worktree] $*"; }

# --- Fork safety -------------------------------------------------------------
# SergeCode is a permanent hard fork. A remote pointing at the upstream repo is
# the one configuration mistake that can leak a PR or a push to a repository
# this project must never touch, so fail loudly rather than continue.
if git remote -v 2>/dev/null | grep -qi "pingdotgg/t3code"; then
  echo "[setup-worktree] ERROR: a git remote points at pingdotgg/t3code." >&2
  echo "[setup-worktree] This fork must never push or open PRs upstream. Remove that remote." >&2
  exit 1
fi

# --- Local environment -------------------------------------------------------
# `.env.local` is gitignored, so it exists only in the checkout the user set up.
# Link it in rather than copy, so a later edit reaches every worktree.
MAIN_CHECKOUT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
if [[ "$MAIN_CHECKOUT" != "$ROOT" && -f "$MAIN_CHECKOUT/.env.local" && ! -e "$ROOT/.env.local" ]]; then
  ln -s "$MAIN_CHECKOUT/.env.local" "$ROOT/.env.local"
  log "linked .env.local from $MAIN_CHECKOUT"
fi

# --- Node version ------------------------------------------------------------
# A mismatch here surfaces later as a wall of pnpm "Unsupported engine"
# warnings around whatever the agent was actually trying to do. Say it once,
# up front, and do not fail: the install works anyway.
REQUIRED_NODE_MAJOR="$(node -e "
  const engines = require('./package.json').engines ?? {};
  const range = engines.node ?? '';
  const match = /(\d+)/.exec(range);
  process.stdout.write(match ? match[1] : '');
" 2>/dev/null || true)"
ACTUAL_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if [[ -n "$REQUIRED_NODE_MAJOR" && -n "$ACTUAL_NODE_MAJOR" && "$REQUIRED_NODE_MAJOR" != "$ACTUAL_NODE_MAJOR" ]]; then
  log "warning: node $(node -v) is active but package.json wants v${REQUIRED_NODE_MAJOR}.x."
  log "warning: expect 'Unsupported engine' warnings from pnpm; they are not your change."
fi

# --- Dependencies ------------------------------------------------------------
# Reinstall when the lockfile moved since the last successful install. The
# stamp lives inside node_modules so removing node_modules resets it.
STAMP="$ROOT/node_modules/.sergecode-setup-lock-hash"
LOCK_HASH="$(shasum -a 256 "$ROOT/pnpm-lock.yaml" | cut -d' ' -f1)"

needs_install() {
  [[ "$FORCE" == "1" ]] && return 0
  [[ ! -d "$ROOT/node_modules" ]] && return 0
  [[ ! -f "$STAMP" ]] && return 0
  [[ "$(cat "$STAMP")" != "$LOCK_HASH" ]] && return 0
  return 1
}

if needs_install; then
  log "installing dependencies (pnpm install --frozen-lockfile)…"
  pnpm install --frozen-lockfile
  # An install that produced no node_modules is not a reason to fail the whole
  # checkout; leaving the stamp unwritten just means the next run tries again.
  mkdir -p "$(dirname "$STAMP")"
  printf '%s' "$LOCK_HASH" > "$STAMP"
  log "dependencies ready."
else
  log "dependencies already match pnpm-lock.yaml; nothing to do."
fi
