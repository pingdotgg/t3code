#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Fetching upstream..."
git fetch upstream main

BEHIND=$(git rev-list --count main..upstream/main)
AHEAD=$(git rev-list --count upstream/main..main)

if [ "$BEHIND" -eq 0 ]; then
  echo -e "${GREEN}✓ main is up to date with upstream.${NC}"
else
  echo -e "${YELLOW}main is $BEHIND commit(s) behind upstream.${NC}"

  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  if [ "$CURRENT" != "main" ]; then
    echo -e "${RED}✗ Not on main branch (on '$CURRENT'). Switch to main first.${NC}"
    exit 1
  fi

  if [ "$AHEAD" -gt 0 ]; then
    echo -e "${RED}✗ main is $AHEAD commit(s) ahead of upstream — cannot fast-forward.${NC}"
    echo "  Resolve this manually or reset main to upstream/main."
    exit 1
  fi

  echo "Fast-forwarding main..."
  git merge --ff-only upstream/main
  echo "Pushing to origin..."
  git push origin main
  echo -e "${GREEN}✓ Synced main with upstream ($BEHIND new commits).${NC}"
fi

# List feature branches that may need rebasing
echo ""
echo "Feature branches:"
FEATURES=$(git branch --list 'feature/*' 2>/dev/null || true)
if [ -z "$FEATURES" ]; then
  echo "  (none)"
else
  while IFS= read -r branch; do
    branch=$(echo "$branch" | sed 's/^[* ]*//')
    BRANCH_BEHIND=$(git rev-list --count "$branch"..main 2>/dev/null || echo "?")
    if [ "$BRANCH_BEHIND" != "0" ]; then
      echo -e "  ${YELLOW}$branch${NC} — $BRANCH_BEHIND commit(s) behind main (needs rebase)"
    else
      echo -e "  ${GREEN}$branch${NC} — up to date"
    fi
  done <<< "$FEATURES"
fi
