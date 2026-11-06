#!/usr/bin/env bash
set -euo pipefail

upstream="${1:-upstream/main}"
budget="apps/server/src/provider/agentContextBudget.json"

if git merge-base --is-ancestor "$upstream" HEAD; then
  echo "main already has $upstream."
  exit 0
fi

before="$(git rev-parse HEAD)"
if ! git merge --no-ff --no-commit "$upstream"; then
  git rev-parse --verify MERGE_HEAD >/dev/null
fi

git restore --source="$before" --staged --worktree -- .github/workflows
if [ -n "$(git ls-files --unmerged -- "$budget")" ]; then
  # This is a placeholder until the context test measures the merged source.
  git checkout --theirs -- "$budget"
  git add "$budget"
fi

conflicts="$(git diff --name-only --diff-filter=U)"
if [ -n "$conflicts" ]; then
  git merge --abort
  printf '::error::%s conflicts with main. Resolve these files manually:\n%s\n' "$upstream" "$conflicts"
  exit 1
fi
