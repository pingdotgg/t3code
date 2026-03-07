#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)

FEATURES=$(git branch --list 'feature/*' 2>/dev/null | sed 's/^[* ]*//' || true)

if [ -z "$FEATURES" ]; then
  echo "No feature/* branches found."
  exit 0
fi

SUCCEEDED=()
FAILED=()
UPTODATE=()

while IFS= read -r branch; do
  BEHIND=$(git rev-list --count "$branch"..main 2>/dev/null || echo "0")

  if [ "$BEHIND" -eq 0 ]; then
    UPTODATE+=("$branch")
    continue
  fi

  echo -e "${YELLOW}Rebasing $branch onto main...${NC}"
  git checkout "$branch" --quiet

  if git rebase main --quiet 2>/dev/null; then
    SUCCEEDED+=("$branch")
    echo -e "  ${GREEN}✓ Success${NC}"
  else
    git rebase --abort 2>/dev/null || true
    FAILED+=("$branch")
    echo -e "  ${RED}✗ Conflicts — rebase aborted${NC}"
  fi
done <<< "$FEATURES"

git checkout "$ORIGINAL_BRANCH" --quiet

echo ""
echo "=== Summary ==="
if [ ${#UPTODATE[@]} -gt 0 ]; then
  echo -e "${GREEN}Up to date (${#UPTODATE[@]}):${NC}"
  for b in "${UPTODATE[@]}"; do echo "  $b"; done
fi
if [ ${#SUCCEEDED[@]} -gt 0 ]; then
  echo -e "${GREEN}Rebased (${#SUCCEEDED[@]}):${NC}"
  for b in "${SUCCEEDED[@]}"; do echo "  $b"; done
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo -e "${RED}Conflicts (${#FAILED[@]}):${NC}"
  for b in "${FAILED[@]}"; do echo "  $b — resolve manually with: git checkout $b && git rebase main"; done
fi
