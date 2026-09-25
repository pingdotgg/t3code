#!/usr/bin/env bash
# fork-rebase.sh: absorb upstream updates into the fork stack.
# Usage: scripts/fork-rebase.sh [--upstream <remote>] [--dry-run] [--proof] [--push]
#   --dry-run  report the stack and pending upstream commits without changing anything.
#   --proof    run the full fork proof after a successful rebase.
#   --push     publish the branch (requires --proof in the same run, uses
#              --force-with-lease, never --force, and refuses on main).
# On conflict the rebase is left in progress and the conflicted upstream files
# are reported; resolve them, run `git rebase --continue`, then re-run this script.
set -euo pipefail

UPSTREAM="upstream"
DRY_RUN=0
PROOF=0
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --proof) PROOF=1; shift ;;
    --push) PUSH=1; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "fork-rebase: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$PUSH" -eq 1 && "$PROOF" -ne 1 ]]; then
  echo "fork-rebase: refusing to push without proof passing in the same run; re-run with --proof --push." >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ "$PUSH" -eq 1 && "$BRANCH" == "main" ]]; then
  echo "fork-rebase: refusing to push main directly; push an absorption branch, then land it as docs/fork.md describes." >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
START="$SECONDS"

echo "fork-rebase: fetching $UPSTREAM..."
git fetch "$UPSTREAM" main

TARGET="$(git rev-parse "$UPSTREAM/main")"
BASE="$(git merge-base HEAD "$TARGET")"
echo "fork-rebase: branch: $BRANCH"
echo "fork-rebase: upstream: $(git log --oneline -1 "$TARGET")"
echo "fork-rebase: base:     $(git log --oneline -1 "$BASE")"
echo "fork-rebase: stack ($(( $(git rev-list --count "$BASE"..HEAD) )) commit(s)):"
git log --oneline "$BASE"..HEAD || true
PENDING="$(git rev-list --count "$BASE".."$TARGET")"
echo "fork-rebase: pending upstream commits: $PENDING"
if [[ "$PENDING" -gt 0 ]]; then
  # `|| true`: head closing the pipe is not a failure under pipefail.
  git log --oneline "$BASE".."$TARGET" | head -n 20 || true
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "fork-rebase: dry run; nothing changed."
  exit 0
fi

if [[ "$PENDING" -eq 0 ]]; then
  echo "fork-rebase: already up to date; nothing to replay."
else
  echo "fork-rebase: rebasing stack onto $UPSTREAM/main..."
  if ! git rebase "$UPSTREAM/main"; then
    echo "fork-rebase: CONFLICT. The rebase is left in progress." >&2
    echo "fork-rebase: conflicted upstream files:" >&2
    git diff --name-only --diff-filter=U | while IFS= read -r f; do
      echo "fork-rebase:   - $f" >&2
    done
    echo "fork-rebase: stopped at: $(git log --oneline -1 2>/dev/null || echo '(unknown)')" >&2
    echo "fork-rebase: resolve each file (hint: git log $UPSTREAM/main -- <file>), run \`git rebase --continue\`, then re-run this script." >&2
    exit 1
  fi
  echo "fork-rebase: rebase clean (no conflicts)."
fi

echo "fork-rebase: running fork check..."
bash "$ROOT/scripts/fork-check.sh" --upstream "$UPSTREAM"

if [[ "$PROOF" -eq 1 ]]; then
  echo "fork-rebase: running full fork proof..."
  # Run the proof in a host-neutral subshell. Upstream tests assume CI's Linux
  # host: an inherited ELECTRON_RUN_AS_NODE (T3 Code desktop leaks it into
  # agent shells) changes spawned command environments, macOS's /var ->
  # /private/var TMPDIR symlink breaks path equality, and a Homebrew `brew`
  # on PATH adds extra provider probes.
  (
    unset ELECTRON_RUN_AS_NODE
    TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)/"
    PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/opt/homebrew' | paste -sd: -)"
    export TMPDIR PATH
    pnpm install --frozen-lockfile
    pnpm exec vp run -r typecheck
    pnpm exec vp lint
    pnpm exec vp run -r test
    pnpm exec vp fmt --check
  )
  echo "fork-rebase: proof passed."
fi

if [[ "$PUSH" -eq 1 ]]; then
  if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
    echo "fork-rebase: publishing rebased stack with --force-with-lease..."
    git push --force-with-lease origin "$BRANCH"
  else
    echo "fork-rebase: publishing new branch..."
    git push -u origin "$BRANCH"
  fi
fi

echo "fork-rebase: done in $((SECONDS - START))s."
