#!/usr/bin/env bash
# Collect every PR merged to origin/main since the last `chore(release)` commit.
#
#   .agents/skills/release-blog/scripts/collect-prs.sh [out-dir]
#
# Writes to out-dir (default /tmp/release-blog):
#   range.txt     the release commit, its version, and the PR count
#   nums.txt      PR numbers, newest first
#   <n>.json      gh's number/title/author/body/labels for each PR
#   digest.txt    every PR's title, author and full body, oldest first
#   authors.txt   login|display name|PR numbers for every non-maintainer author
set -euo pipefail

out="${1:-/tmp/release-blog}"
repo="alchemy-run/alchemy"
mkdir -p "$out"

git fetch origin main -q
release=$(git log origin/main --format='%H %s' | grep -m1 'chore(release)')
sha=${release%% *}
echo "$release" > "$out/range.txt"

git log origin/main --format='%s' "$sha..origin/main" \
  | grep -oE '\(#[0-9]+\)$' | tr -d '(#)' > "$out/nums.txt"
echo "PRs since: $(wc -l < "$out/nums.txt" | tr -d ' ')" >> "$out/range.txt"

xargs -P 12 -I{} sh -c \
  "gh pr view {} --repo $repo --json number,title,author,body,labels > '$out/{}.json'" \
  < "$out/nums.txt"

: > "$out/digest.txt"
for n in $(sort -n "$out/nums.txt"); do
  jq -r '"=== #\(.number) [\(.author.login)] \(.title)\n\(.body // "" | gsub("\r";""))\n"' \
    "$out/$n.json" >> "$out/digest.txt"
done

: > "$out/authors.txt"
for login in $(jq -r '.author.login' "$out"/[0-9]*.json | sort -u | grep -v '^sam-goodwin$'); do
  name=$(gh api "users/$login" --jq '.name // ""' 2>/dev/null || true)
  prs=$(jq -r "select(.author.login==\"$login\") | .number" "$out"/[0-9]*.json | tr '\n' ' ')
  echo "$login|$name|$prs" >> "$out/authors.txt"
done

cat "$out/range.txt"
echo "digest: $out/digest.txt ($(wc -l < "$out/digest.txt" | tr -d ' ') lines)"
