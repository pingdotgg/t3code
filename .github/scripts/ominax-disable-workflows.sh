#!/usr/bin/env bash
# The t3-learn fork runs only OminaX CI. Upstream's other workflows deploy,
# publish, or label and comment with write scopes, and a workflow file merged
# from upstream starts out active, so disable every one after each sync merges:
#   bash .github/scripts/ominax-disable-workflows.sh
# Needs a gh login with admin on the fork. Safe to rerun.
set -euo pipefail

repo="${1:-aabdel0181/ominax}"

gh api "repos/$repo/actions/workflows" --paginate --jq '.workflows[]
  | select(.state == "active"
    and (.path | startswith(".github/workflows/"))
    and .path != ".github/workflows/ominax-ci.yml"
    and .path != ".github/workflows/ominax-release.yml")
  | "\(.id) \(.path)"' |
  while read -r id path; do
    gh api -X PUT "repos/$repo/actions/workflows/$id/disable"
    echo "Disabled $path ($id)"
  done
