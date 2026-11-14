#!/usr/bin/env bash
# Fast-forwards a source checkout to origin/main, rebuilds the server, and restarts
# the t3code user service. The server starts this through systemd-run, outside its
# own cgroup, and reads the last "[source-update]" line of the log as the result.
set -euo pipefail

checkout="${T3CODE_SOURCE_CHECKOUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
service="${T3CODE_SOURCE_UPDATE_SERVICE:-t3code}"
step="starting"

finish() {
  local status=$?
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$status" -eq 0 ]; then
    echo "[source-update] succeeded $now Updated to $(git -C "$checkout" log -1 --format='%h %s')"
  else
    echo "[source-update] failed $now ${failure:-Failed while $step (exit $status).}"
  fi
}
trap finish EXIT

fail() {
  failure="$1"
  echo "$1" >&2
  exit 1
}

# The pull can rewrite this file while it runs, so bash must parse all of it first.
main() {
  # vp is installed per user and is not on the service's PATH.
  if [ -f "$HOME/.config/vite-plus/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.config/vite-plus/env"
  fi
  command -v vp >/dev/null || fail "vp is not installed; see https://viteplus.dev."

  cd "$checkout"
  echo "Updating $checkout"

  step="checking the working tree"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    fail "The checkout has uncommitted changes; commit or discard them first."
  fi
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [ "$branch" = "main" ] || fail "The checkout is on '${branch:-a detached HEAD}', not main."

  step="pulling origin/main"
  git fetch origin main
  if ! git merge-base --is-ancestor HEAD origin/main; then
    fail "main has commits origin/main lacks, so it cannot fast-forward; push or reset them first."
  fi
  git merge --ff-only origin/main

  step="installing dependencies"
  vp i

  step="building the server"
  vp run --filter t3 build

  step="restarting $service"
  systemctl --user restart "$service"
}

main "$@"; exit
