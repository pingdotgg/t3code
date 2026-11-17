#!/usr/bin/env bash
# Fast-forwards a source checkout to origin/main, merges upstream/main into it and
# pushes the merge, rebuilds the server, and restarts its user service. The server starts this through systemd-run, outside its own
# cgroup, and reads the "[source-update]" lines of the log as the run's progress.
#
# T3CODE_SOURCE_UPDATE_SERVICE names the unit to restart; empty skips the restart
# (a dev stack). T3CODE_SOURCE_UPDATE_HOST and _PORT are where the restarted server listens.
set -euo pipefail

checkout="${T3CODE_SOURCE_CHECKOUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
service="${T3CODE_SOURCE_UPDATE_SERVICE-t3code}"
host="${T3CODE_SOURCE_UPDATE_HOST:-127.0.0.1}"
port="${T3CODE_SOURCE_UPDATE_PORT:-}"
run_id="${T3CODE_SOURCE_UPDATE_RUN_ID:-manual-$(date +%s)}"
dist="$checkout/apps/server/dist"
dist_backup="$checkout/apps/server/.dist-previous"
step="starting"
success=""

echo "[source-update] started $run_id"

restore_dist() {
  rm -rf "$dist_backup.partial"
  [ -d "$dist_backup" ] || return 0
  echo "Restoring the previous build."
  rm -rf "$dist"
  mv "$dist_backup" "$dist"
}

finish() {
  local status=$?
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$status" -eq 0 ]; then
    echo "[source-update] succeeded $run_id $now $success"
  else
    restore_dist || true
    echo "[source-update] failed $run_id $now ${failure:-Failed while $step (exit $status).}"
  fi
}
trap finish EXIT
# systemd stops the unit with SIGTERM, on Cancel and when RuntimeMaxSec runs out.
trap 'failure="Stopped while $step: cancelled, or it ran too long."; exit 143' TERM INT

fail() {
  failure="$1"
  echo "$1" >&2
  exit 1
}

# Waits until the restarted unit is active and its port accepts connections.
wait_for_service() {
  local deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local state
    state="$(systemctl --user is-active "$service" || true)"
    if [ "$state" = "failed" ]; then
      fail "$service failed to start after the update; see journalctl --user -u $service."
    fi
    if [ "$state" = "active" ]; then
      if [ -z "$port" ]; then
        return 0
      fi
      if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  fail "$service did not come back within 2 minutes; see journalctl --user -u $service."
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
  # A run killed outright (SIGKILL, power loss) mid-build leaves its backup behind.
  restore_dist

  step="checking the working tree"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    fail "The checkout has uncommitted changes; commit or discard them first."
  fi
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [ "$branch" = "main" ] || fail "The checkout is on '${branch:-a detached HEAD}', not main."

  step="fetching"
  local has_upstream=""
  git fetch origin main
  if git remote get-url upstream >/dev/null 2>&1; then
    has_upstream=1
    git fetch upstream main
  fi

  step="pulling origin/main"
  if ! git merge-base --is-ancestor HEAD origin/main; then
    fail "main has commits origin/main lacks, so it cannot fast-forward; push or reset them first."
  fi
  git merge --ff-only origin/main

  # Merge, never rebase: main is published and other machines clone it.
  if [ -n "$has_upstream" ] && ! git merge-base --is-ancestor upstream/main HEAD; then
    step="merging upstream/main"
    if ! git merge --no-edit upstream/main; then
      git merge --abort || true
      fail "upstream/main does not merge cleanly; press Update again to have an agent resolve it."
    fi
    step="pushing the merge to origin"
    if ! git push origin main; then
      git reset --hard origin/main
      fail "Could not push the upstream merge to origin; the merge was undone."
    fi
  fi

  # Skills are not part of the server, so a linking problem never blocks the update.
  node scripts/workflow-link.ts || echo "Linking workflow skills failed; run vp run workflow:link." >&2

  step="installing dependencies"
  vp i

  # The build writes into the dist the service runs; keep the last good one until it finishes.
  step="building the server"
  if [ -d "$dist" ]; then
    cp -a "$dist" "$dist_backup.partial"
    mv "$dist_backup.partial" "$dist_backup"
  fi
  vp run --filter t3 build
  rm -rf "$dist_backup"

  local head
  head="$(git log -1 --format='%h %s')"
  if [ -z "$service" ]; then
    success="Built $head. Restart the dev server to run it."
    return 0
  fi

  step="restarting $service"
  systemctl --user restart "$service"
  wait_for_service
  success="Updated to $head"
}

main "$@"; exit
