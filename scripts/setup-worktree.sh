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

# The install is the only unbounded step here, and it runs inside
# `git worktree add`. Give it its own deadline so a wedged pnpm surfaces as a
# named setup failure with a recovery path, rather than as an opaque git
# timeout minutes later. Observed worst case in practice is ~3m20s cold.
# macOS has no timeout(1), so this is a watchdog rather than a coreutils call.
SETUP_TIMEOUT_SECONDS="${SERGECODE_SETUP_TIMEOUT_SECONDS:-300}"

run_bounded() {
  local seconds="$1"
  shift
  local state_dir
  state_dir="$(mktemp -d -t sergecode-setup)"
  local timed_out_marker="$state_dir/timed-out"
  local finished_marker="$state_dir/finished"

  # Job control puts the command in its own process group, so the watchdog can
  # signal the whole tree. Signalling only the direct child leaves pnpm's
  # grandchildren alive holding this script's stdout, and a caller capturing
  # that output then blocks on EOF long after the timeout fired.
  set -m
  # Launch the command itself as the job leader. A wrapper subshell that exits
  # on TERM can be reaped before a TERM-ignoring grandchild, causing this
  # function to cancel the watchdog while that grandchild still holds the
  # caller's output pipe open. CI then eventually kills the whole setup script
  # with 137 instead of receiving the intentional timeout status and message.
  "$@" &
  local command_pid=$!
  set +m

  # Detached from this script's stdout/stderr on purpose. A watchdog that
  # inherits them keeps the pipe open after the install is done, so anything
  # capturing this script's output — the git hook, a CI step, an agent's shell
  # — would block on EOF for the whole remaining budget.
  (
    sleep "$seconds"
    # The finished marker keeps a late watchdog from signalling a pid that has
    # already been reaped and possibly reused.
    if [[ ! -f "$finished_marker" ]] && kill -0 "$command_pid" 2>/dev/null; then
      : > "$timed_out_marker"
      kill -TERM -"$command_pid" 2>/dev/null || kill -TERM "$command_pid" 2>/dev/null || true
      sleep 5
      kill -KILL -"$command_pid" 2>/dev/null || kill -KILL "$command_pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  local watchdog_pid=$!
  # Bash would otherwise announce the watchdog's death ("Terminated: 15") on
  # top of this script's own, clearer message.
  disown "$watchdog_pid" 2>/dev/null || true

  local status=0
  wait "$command_pid" || status=$?
  : > "$finished_marker"

  kill -TERM "$watchdog_pid" 2>/dev/null || true

  local timed_out=1
  [[ -f "$timed_out_marker" ]] || timed_out=0
  rm -rf "$state_dir"

  if [[ "$timed_out" == "1" ]]; then
    return 124
  fi
  return "$status"
}

if needs_install; then
  log "installing dependencies (pnpm install --frozen-lockfile)…"
  install_status=0
  run_bounded "$SETUP_TIMEOUT_SECONDS" pnpm install --frozen-lockfile || install_status=$?

  if [[ "$install_status" == "124" ]]; then
    echo "[setup-worktree] ERROR: install exceeded ${SETUP_TIMEOUT_SECONDS}s and was stopped." >&2
    echo "[setup-worktree] Run 'pnpm run setup' by hand, or raise" >&2
    echo "[setup-worktree] SERGECODE_SETUP_TIMEOUT_SECONDS if this repo is genuinely slower." >&2
    exit 124
  fi
  if [[ "$install_status" != "0" ]]; then
    echo "[setup-worktree] ERROR: 'pnpm install --frozen-lockfile' failed (exit ${install_status})." >&2
    echo "[setup-worktree] Fix the failure above, then run 'pnpm run setup'." >&2
    exit "$install_status"
  fi

  # An install that produced no node_modules is not a reason to fail the whole
  # checkout; leaving the stamp unwritten just means the next run tries again.
  mkdir -p "$(dirname "$STAMP")"
  printf '%s' "$LOCK_HASH" > "$STAMP"
  log "dependencies ready."
else
  log "dependencies already match pnpm-lock.yaml; nothing to do."
fi
