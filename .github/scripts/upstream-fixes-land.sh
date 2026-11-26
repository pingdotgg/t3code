#!/usr/bin/env bash
# Waits for CI on the upstream-fixes branch head, then lands or narrows the batch:
# green merges it and picks again; red with several fixes picks again with half;
# red with one fix retries its failed jobs once, then skips that fix for good.
# Needs GH_TOKEN, REPO, BRANCH and SHA (the branch head this run pushed).
set -euo pipefail

pick_again() {
  gh workflow run upstream-fixes.yml --repo "$REPO" --ref main "$@"
}

find_ci() {
  for _ in $(seq 1 30); do
    run=$(gh run list --repo "$REPO" --workflow ci.yml --branch "$BRANCH" --event workflow_dispatch \
      --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
    if [ -n "$run" ]; then
      echo "$run"
      return
    fi
    sleep 10
  done
  echo "CI never started on $SHA." >&2
  exit 1
}

conclusion() {
  gh run watch "$1" --repo "$REPO" --interval 60 >/dev/null 2>&1 || true
  gh run view "$1" --repo "$REPO" --json conclusion --jq .conclusion
}

still_current() {
  git fetch --quiet origin main "$BRANCH"
  [ "$(git rev-parse "origin/$BRANCH")" = "$SHA" ]
}

run=$(find_ci)
result=$(conclusion "$run")
echo "CI $run on ${SHA:0:12}: $result"

if ! still_current; then
  echo "The branch moved while CI ran; the run that moved it decides."
  exit 0
fi
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --base main --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  echo "No open pull request for $BRANCH."
  exit 0
fi
picks=$(git log --format=%B "origin/main..$SHA" | grep -c '^(cherry picked from commit ' || true)

if [ "$result" = success ]; then
  # CI tested the branch as built on main; if main moved since, that is not what would land.
  if ! git merge-base --is-ancestor origin/main "$SHA"; then
    echo "main moved after the branch was built; picking again."
    pick_again
    exit 0
  fi
  body=$(gh pr view "$pr" --repo "$REPO" --json body --jq .body)
  gh pr merge "$pr" --repo "$REPO" --rebase --match-head-commit "$SHA"
  echo "Merged $picks upstream fixes from #$pr."
  # Fixes that conflicted or were held back are past the cursor now; keep them on one issue.
  leftovers=$(printf '%s\n' "$body" |
    awk '/^### (Did not apply|Held back)/{keep=1} /^### (Picked|Left out)/{keep=0} keep')
  if [ -n "$leftovers" ]; then
    title="Upstream fixes to pick by hand"
    issue=$(gh issue list --repo "$REPO" --state open --search "in:title \"$title\"" \
      --json number,title --jq ".[] | select(.title == \"$title\") | .number" | head -1)
    if [ -z "$issue" ]; then
      url=$(gh issue create --repo "$REPO" --title "$title" \
        --body "The upstream fixes workflow could not take these on its own. Pick them by hand, or add them to \`.github/upstream-fixes/skip\`.")
      issue=${url##*/}
    fi
    printf 'From #%s:\n\n%s\n' "$pr" "$leftovers" | gh issue comment "$issue" --repo "$REPO" --body-file -
  fi
  pick_again
  exit 0
fi

if [ "$result" != failure ]; then
  echo "CI ended $result; leaving the batch for the next run."
  exit 0
fi

if [ "$picks" -gt 1 ]; then
  half=$((picks / 2))
  gh pr comment "$pr" --repo "$REPO" \
    --body "CI failed with $picks fixes. Picking again with the first $half to find the one that breaks it."
  pick_again -f max="$half"
  exit 0
fi

if [ "$picks" -eq 0 ]; then
  echo "CI failed with no upstream fix on the branch; main itself needs a look." >&2
  exit 1
fi

# One fix left: a flaky test gets one more chance before the fix is skipped.
gh run rerun "$run" --repo "$REPO" --failed
sleep 20
result=$(conclusion "$run")
if ! still_current; then exit 0; fi
if [ "$result" = success ]; then
  gh pr merge "$pr" --repo "$REPO" --rebase --match-head-commit "$SHA"
  echo "Merged the one upstream fix from #$pr after a retry."
  pick_again
  exit 0
fi
bad=$(git log --format=%B "origin/main..$SHA" | sed -n 's/^(cherry picked from commit \([0-9a-f]*\))$/\1/p' | head -1)
gh pr comment "$pr" --repo "$REPO" \
  --body "Upstream \`${bad:0:12}\` fails CI on its own, twice. Skipping it from now on; pick it by hand if it matters."
pick_again -f quarantine="$bad"
