#!/usr/bin/env bash

set -euo pipefail

current_branch="$(git branch --show-current)"
if [[ -z "$current_branch" ]]; then
  echo "Cannot update main from a detached HEAD." >&2
  exit 1
fi

upstream_remote="upstream"
origin_remote="origin"
upstream_main_ref="$upstream_remote/main"

printf "Fetching %s and %s\n" "$upstream_remote" "$origin_remote"
git fetch --quiet --no-tags "$upstream_remote"
git fetch --quiet --no-tags "$origin_remote"

if [[ "$current_branch" == "main" ]]; then
  printf "Fast-forwarding main to %s\n" "$upstream_main_ref"
  git merge --ff-only "$upstream_main_ref"
  printf "Pushing main to %s\n" "$origin_remote"
  exec git push "$origin_remote" main
fi

printf "Fast-forwarding main to %s\n" "$upstream_main_ref"
git switch --quiet main
git merge --ff-only "$upstream_main_ref"
printf "Pushing main to %s\n" "$origin_remote"
git push "$origin_remote" main
git switch --quiet "$current_branch"
