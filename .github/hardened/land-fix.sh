#!/usr/bin/env bash
# Check a fix from repair-release.sh, run full CI on it, and fast-forward the target branch.
# A fix that changes .github/ can change what the signing job runs, so it stops in the run
# summary for a person. hardened.patch is the exception: the release applies it as data.
# This job holds the write credential, so it treats the fix as data and never runs its code.
#
# Usage: land-fix.sh <input-dir> <branch>
#   PUSH_TOKEN  contents and workflows write. Its push starts CI on the fix branch.
#   GH_TOKEN    pull requests write and actions read.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
IN="$1"
BRANCH="$2"
PUSH_URL="https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

git fetch --quiet "$IN/sync.bundle" +HEAD:refs/sync/fix
fix="$(git rev-parse refs/sync/fix)"
[[ "$(git rev-list --parents -n 1 "$fix")" == "$fix $(git rev-parse HEAD)" ]] ||
  fail "The fix is not one commit on $BRANCH."

fix_branch="sync/release-fix-${GITHUB_RUN_ID}"
{
  echo "The daily Hardened release failed, and the release repair made this fix."
  echo
  echo "Run: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  echo
  echo "## Agent summary"
  echo
  cat "$IN/summary.md"
  echo
  echo "Claude Opus 5.5 via Claude Code."
} >"$IN/pr.md"
open_pr() { upsert_pr "$BRANCH" "$fix_branch" "fix(hardened): repair the daily release" "$IN/pr.md"; }

# Not pushed: a workflow on a branch of this repository can run with its secrets before review.
if ! git diff --quiet --no-renames HEAD "$fix" -- .github ':!.github/hardened/hardened.patch'; then
  {
    cat "$IN/pr.md"
    printf '\n## Proposed fix, not applied\n\n```diff\n'
    git diff HEAD "$fix"
    printf '```\n'
  } >>"$GITHUB_STEP_SUMMARY"
  fail "The fix changes .github/, so a person must apply it. The run summary shows the diff."
fi

check_patch "$fix"
if ! push_and_wait_ci "$fix" "$fix_branch"; then
  open_pr
  fail "CI failed on the fix. Finish it in $PR."
fi
open_pr
git push --quiet "$PUSH_URL" "$fix:refs/heads/$BRANCH"
echo "Landed $fix on $BRANCH."
