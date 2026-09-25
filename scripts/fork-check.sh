#!/usr/bin/env bash
# fork-check.sh: verify the fork stack model on the current branch.
# Usage: scripts/fork-check.sh [--base <sha>] [--upstream <remote>] [--max-commits <n>]
# Exits 0 when the stack is a small, merge-free stack whose upstream-file
# modifications are all allowlisted in scripts/fork-upstream-edits.txt.
set -euo pipefail

BASE=""
UPSTREAM="upstream"
MAX_COMMITS=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --max-commits) MAX_COMMITS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "fork-check: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ ! -f docs/fork.md ]]; then
  echo "fork-check: FAIL: docs/fork.md is missing." >&2
  exit 1
fi

if [[ -z "$BASE" ]]; then
  if git rev-parse --verify --quiet "$UPSTREAM/main" >/dev/null; then
    BASE="$(git merge-base HEAD "$UPSTREAM/main")"
  else
    BASE="$(git merge-base HEAD origin/main)"
  fi
fi

echo "fork-check: base: $(git log --oneline -1 "$BASE")"

MERGES="$(git log --merges --format='%h %s' "$BASE"..HEAD)"
if [[ -n "$MERGES" ]]; then
  echo "fork-check: FAIL: merge commits in the fork stack (rebase, do not merge):" >&2
  echo "$MERGES" >&2
  exit 1
fi

COUNT="$(git rev-list --count "$BASE"..HEAD)"
echo "fork-check: stack: $COUNT commit(s) on top of base (limit $MAX_COMMITS)."
git log --oneline "$BASE"..HEAD || true
if [[ "$COUNT" -gt "$MAX_COMMITS" ]]; then
  echo "fork-check: FAIL: stack exceeds $MAX_COMMITS commits; split the work." >&2
  exit 1
fi

# Files changed across the stack, classified against the base: a changed path
# that does not exist in the base is a new fork-only file (always fine).
# Anything else (modified or deleted upstream file) must be allowlisted.
ALLOW="$ROOT/scripts/fork-upstream-edits.txt"
ALLOWLIST="$(grep -v '^\s*#' "$ALLOW" | grep -v '^\s*$' || true)"
FAIL=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if git cat-file -e "$BASE:$path" 2>/dev/null; then
    if printf '%s\n' "$ALLOWLIST" | grep -qxF "$path"; then
      echo "fork-check: modified (allowlisted): $path"
    else
      echo "fork-check: FAIL: upstream file modified but not allowlisted: $path" >&2
      FAIL=1
    fi
  else
    echo "fork-check: new fork file: $path"
  fi
done < <(git diff --name-only "$BASE"..HEAD)

if [[ "$FAIL" -ne 0 ]]; then
  echo "fork-check: FAIL: list the file in scripts/fork-upstream-edits.txt and assign its owner in docs/fork-features.md, or move the change to a new file." >&2
  exit 1
fi

node "$(dirname "$0")/fork-features.mjs" check

echo "fork-check: OK."
