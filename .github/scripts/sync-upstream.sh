#!/usr/bin/env bash
# Merges upstream into the checked-out fork branch, leaving the merge staged but uncommitted.
#
# Conflicts the fork always resolves the same way are settled here:
#   - .github/workflows keeps the fork's version, including files the fork deleted or never
#     took. The default token cannot push workflow changes, and upstream's target its repo.
#   - The generated agent context budget takes upstream's; the workflow measures it again.
#
# When other files conflict, the newest upstream commit (on its first-parent history) that
# still merges cleanly is merged instead, so main keeps up with everything before the
# conflict. The upstream commit that first conflicts and its files are written to
# $SYNC_REPORT (Markdown) when that is set.
#
# Exit status: 0 merged everything (or already up to date), 3 blocked by a conflict (a partial
# merge may still be staged; check MERGE_HEAD), anything else is an error.
set -euo pipefail

upstream="${1:-upstream/main}"
budget="apps/server/src/provider/agentContextBudget.json"
report="${SYNC_REPORT:-}"

# Conflicted paths the policy above does not settle, one per line.
unsettled_conflicts() {
  local out
  if out="$(git merge-tree --write-tree --name-only --no-messages HEAD "$1")"; then
    return 0
  elif [ $? -ne 1 ]; then
    echo "::error::git merge-tree failed for $1" >&2
    exit 2
  fi
  printf '%s\n' "$out" | tail -n +2 |
    awk -v budget="$budget" 'NF && $0 !~ /^\.github\/workflows\// && $0 != budget' |
    sort -u
}

merge_with_policy() {
  local target="$1" message="$2" before
  before="$(git rev-parse HEAD)"
  if ! git merge --no-ff --no-commit -m "$message" "$target"; then
    git rev-parse --verify MERGE_HEAD >/dev/null
  fi

  # The fork's workflows win outright, so upstream additions, edits and edits to files the
  # fork removed all go. Unmerged entries are dropped from the index first: restore and
  # checkout refuse them.
  git rm -r -q -f --cached --ignore-unmatch -- .github/workflows
  rm -rf .github/workflows
  if git cat-file -e "$before:.github/workflows" 2>/dev/null; then
    git checkout "$before" -- .github/workflows
  fi

  if [ -n "$(git ls-files --unmerged -- "$budget")" ]; then
    # A placeholder until the context test measures the merged source.
    git checkout --theirs -- "$budget"
    git add "$budget"
  fi

  local conflicts
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [ -n "$conflicts" ]; then
    git merge --abort
    printf '::error::%s conflicts with main. Resolve these files manually:\n%s\n' "$target" "$conflicts"
    exit 1
  fi
}

write_report() {
  local blocker="$1" files="$2" merged="$3"
  [ -n "$report" ] || return 0
  {
    echo "The daily upstream sync stopped at an upstream commit that conflicts with fork changes."
    echo
    echo "**First conflicting upstream commit:** $(git log -1 --format='%h %s' "$blocker")"
    echo
    if [ -n "$merged" ]; then
      echo "**Merged up to:** $(git log -1 --format='%h %s' "$merged")"
    else
      echo "**Merged up to:** nothing; the next upstream commit already conflicts."
    fi
    echo
    echo "**Files to resolve:**"
    echo
    printf '%s\n' "$files" | sed 's/.*/- `&`/'
    echo
    echo "Resolve them on a branch: \`git fetch upstream && git merge upstream/main\`, fix the files"
    echo "above, and merge that branch into main. The next run picks up from there."
  } >"$report"
}

if git merge-base --is-ancestor "$upstream" HEAD; then
  echo "main already has $upstream."
  exit 0
fi

target="$(git rev-parse "$upstream")"
blocked="$(unsettled_conflicts "$target")"
if [ -z "$blocked" ]; then
  merge_with_policy "$target" "Merge remote-tracking branch '$upstream'"
  exit 0
fi

# Find the newest clean commit on upstream's first-parent line. Once a commit conflicts,
# later ones nearly always do too, so a binary search finds the boundary.
mapfile -t candidates < <(git rev-list --first-parent --reverse "HEAD..$target")
lo=-1
hi=$((${#candidates[@]} - 1))
while [ $((hi - lo)) -gt 1 ]; do
  mid=$(((lo + hi) / 2))
  if [ -z "$(unsettled_conflicts "${candidates[mid]}")" ]; then lo=$mid; else hi=$mid; fi
done

blocker="${candidates[hi]}"
blocked="$(unsettled_conflicts "$blocker")"
if [ $lo -lt 0 ]; then
  write_report "$blocker" "$blocked" ""
  printf '::error::Upstream commit %s conflicts with main. Resolve these files manually:\n%s\n' \
    "$(git log -1 --format='%h %s' "$blocker")" "$blocked"
  exit 3
fi

clean="${candidates[lo]}"
merge_with_policy "$clean" "Merge $upstream up to $(git rev-parse --short "$clean")"
write_report "$blocker" "$blocked" "$clean"
printf '::warning::Merged %s up to %s. Upstream commit %s conflicts with main:\n%s\n' \
  "$upstream" "$(git rev-parse --short "$clean")" "$(git log -1 --format='%h %s' "$blocker")" "$blocked"
exit 3
