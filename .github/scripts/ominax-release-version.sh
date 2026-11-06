#!/usr/bin/env bash
set -euo pipefail

commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
if [[ "${GITHUB_EVENT_NAME:-}" == "push" ]]; then
  version="${GITHUB_REF_NAME#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-learn\.[0-9]+$ ]] || {
    echo "Tag $GITHUB_REF_NAME must look like v0.1.3-learn.1" >&2
    exit 1
  }
  tag="v$version"
  skip=false
else
  base_version="$(node -p "require('./apps/server/package.json').version")"
  highest=0
  while read -r remote_tag; do
    [[ "$remote_tag" =~ ^v${base_version//./\\.}-learn\.([0-9]+)$ ]] || continue
    n="${BASH_REMATCH[1]}"
    (( n > highest )) && highest="$n"
  done < <(git ls-remote --tags origin 'refs/tags/v*-learn.*' | awk '{print $2}' | sed -E 's#refs/tags/##; s#\^\{\}##' | sort -u)
  version="$base_version-learn.$((highest + 1))"
  tag="v$version"
  skip=false
  if git tag --points-at "$commit" 'v*-learn.*' | grep -q .; then
    skip=true
    reason="the tested commit already has a T3 Learn tag"
  else
    last_tag="$(git tag --list 'v*-learn.*' | sort -V | tail -n 1)"
    if [[ -n "$last_tag" ]]; then
      changed="$(git diff --name-only "$last_tag" "$commit")"
      docs_only=true
      while IFS= read -r path; do
        [[ "$path" == docs/* || "$path" == *.md ]] || docs_only=false
      done <<<"$changed"
      if [[ -n "$changed" && "$docs_only" == true ]]; then
        skip=true
        reason="everything changed since $last_tag is documentation"
      fi
    fi
  fi
fi
{
  echo "version=$version"
  echo "tag=$tag"
  echo "commit=$commit"
  echo "skip=$skip"
  [[ -n "${reason:-}" ]] && echo "reason=$reason"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
if [[ "$skip" == true ]]; then
  echo "Skipping T3 Learn release: ${reason:-already released}."
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Skipping T3 Learn release: ${reason:-already released}." >> "$GITHUB_STEP_SUMMARY"
  fi
fi
