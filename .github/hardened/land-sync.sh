#!/usr/bin/env bash
# Check a merge from resolve-sync.sh, run full CI on it, and fast-forward the target branch.
# When CI fails, the merge stays in a pull request and failed_ci names the run for a repair.
# A fast-forward keeps upstream's ancestry, which a squash or rebase merge loses. This job holds
# the write credential, so it treats the merge as data and never runs its code.
#
# Usage: land-sync.sh <input-dir> <branch>
#   PUSH_TOKEN   contents and workflows write. Its push starts CI on the sync branch.
#   GH_TOKEN     pull requests write and actions read. A pull request from GITHUB_TOKEN starts no
#                CI, so the pull request only shows the merge and keeps a failed one open.
#   SYNC_BRANCH  sync branch of the merge under repair. Empty names a new one.
#   FINAL        true when no repair follows, so a CI failure fails the job.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
IN="$1"
BRANCH="$2"
PUSH_URL="https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

git fetch --quiet --no-tags "$UPSTREAM" main:refs/remotes/upstream/main
git fetch --quiet "$IN/sync.bundle" +HEAD:refs/sync/resolved
merge="$(git rev-parse refs/sync/resolved)"
ours="$(git rev-parse "$merge^1")"
theirs="$(git rev-parse "$merge^2")"

[[ "$(git rev-list --parents -n 1 "$merge" | wc -w)" -eq 3 ]] || fail "The result is not a merge commit."
[[ "$ours" == "$(git rev-parse HEAD)" ]] || fail "$BRANCH moved after the merge started."
git merge-base --is-ancestor "$theirs" upstream/main || fail "The second parent is not an upstream commit."

# The automatic merge shows what the agent changed, independent of what the agent reports.
auto="$(git merge-tree --write-tree --name-only "$ours" "$theirs" || true)"
tree="$(head -n 1 <<<"$auto")"
conflicts="$(sed -n '2,/^$/p' <<<"$auto" | sed '/^$/d')"
changed="$(git diff --name-only --no-renames "$tree" "$merge")"

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  if git cat-file -e "$merge:$file" 2>/dev/null && git show "$merge:$file" | grep -qE '^(<<<<<<<|>>>>>>>) '; then
    fail "$file still has conflict markers."
  fi
done <<<"$conflicts"

while IFS= read -r file; do
  [[ "$file" == .github/* && "$file" != .github/hardened/hardened.patch ]] || continue
  grep -qxF "$file" <<<"$conflicts" || fail "The agent changed $file, which was not conflicted."
done <<<"$changed"

git diff --quiet "$theirs" "$merge" -- \
  apps/server/src/persistence/Migrations.ts \
  apps/server/src/persistence/Migrations \
  apps/server/src/provider/agentContextBudget.json ||
  fail "Migrations and agentContextBudget.json must match upstream."

check_patch "$merge"

sync_branch="${SYNC_BRANCH:-sync/upstream-${GITHUB_RUN_ID}}"
echo "sync_branch=$sync_branch" >>"$GITHUB_OUTPUT"
{
  echo "The upstream sync made this merge. It lands by itself when CI passes."
  echo
  echo "Run: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  echo
  echo "## Agent summary"
  echo
  cat "$IN/summary.md"
  echo
  echo "## Files that differ from the automatic merge"
  echo
  sed "s/.*/- \`&\`/" <<<"${changed:-none}"
  echo
  echo "Claude Opus 5.5 via Claude Code."
} >"$IN/pr.md"
open_pr() { upsert_pr "$BRANCH" "$sync_branch" "chore: merge upstream pingdotgg/t3code main" "$IN/pr.md"; }

if ! push_and_wait_ci "$merge" "$sync_branch"; then
  open_pr
  [[ "${FINAL:-}" == "true" ]] && fail "CI failed. Finish the merge in $PR."
  echo "::warning::CI failed on the merge. A repair follows."
  echo "failed_ci=$CI_RUN" >>"$GITHUB_OUTPUT"
  exit 0
fi

# A merge that the agent changed keeps a pull request as its record. GitHub marks it merged.
[[ -z "$changed" ]] || open_pr
git push --quiet "$PUSH_URL" "$merge:refs/heads/$BRANCH"
echo "Landed $merge on $BRANCH."
[[ -n "$changed" ]] || git push --quiet "$PUSH_URL" ":refs/heads/$sync_branch"
