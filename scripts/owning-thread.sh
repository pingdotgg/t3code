#!/usr/bin/env bash
#
# Print the owning chain for a line of code: blame commit -> introducing PR -> T3 thread.
#
# Usage:
#   scripts/owning-thread.sh <file> <line> [--rev <git-rev>] [--main <ref>] [--json]
#
# Examples:
#   scripts/owning-thread.sh apps/web/src/components/settings/SettingsPanels.tsx 2062
#   scripts/owning-thread.sh apps/web/src/components/settings/SettingsPanels.tsx 119 --rev e526392f00 --json
#
# The introducing PR is the first-parent merge M on <main> with the commit in
# M but not in M^1, which stays correct when branches merge main into
# themselves. Found with binary search, so ~log(merges) git calls.

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
}

rev="HEAD"
main=""
json=0
file=""
line=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rev) rev="${2:?--rev needs a value}"; shift 2 ;;
    --main) main="${2:?--main needs a value}"; shift 2 ;;
    --json) json=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "error: unknown flag $1" >&2; exit 2 ;;
    *)
      if [[ -z "$file" ]]; then file="$1";
      elif [[ -z "$line" ]]; then line="$1";
      else echo "error: unexpected argument $1" >&2; exit 2; fi
      shift ;;
  esac
done
[[ -n "$file" && -n "$line" ]] || { usage >&2; exit 2; }
[[ "$line" =~ ^[0-9]+$ ]] && [[ "$line" -ge 1 ]] || { echo "error: line must be a positive integer" >&2; exit 2; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "error: not in a git repo" >&2; exit 2; }
cd "$root"

if [[ -z "$main" ]]; then
  if git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then main="origin/main"; else main="main"; fi
fi

blame_out="$(git blame -L "$line,$line" --porcelain "$rev" -- "$file" 2>/dev/null)" || {
  if [[ -f "$file" ]] && [[ "$line" -le "$(wc -l <"$file" | tr -d ' ')" ]]; then
    echo "error: $file:$line is uncommitted (absent at $rev); commit first" >&2
  else
    echo "error: cannot blame $file:$line at $rev" >&2
  fi
  exit 2
}
sha="$(printf '%s\n' "$blame_out" | head -1 | awk '{print $1}' | sed 's/^\^//')"
[[ "$sha" =~ ^0+$ ]] && { echo "error: $file:$line is uncommitted at $rev; commit first" >&2; exit 2; }
subject="$(git show -s --format=%s "$sha")"
author="$(git show -s --format='%an %ad' --date=short "$sha")"

contains() { git merge-base --is-ancestor "$sha" "$1" 2>/dev/null; }

pr="" branch="" merge="" note=""
merges=()
while IFS= read -r h; do merges+=("$h"); done < <(git log --first-parent --format=%H --merges "$main" 2>/dev/null)
if [[ ${#merges[@]} -eq 0 ]] || ! contains "${merges[0]}"; then
  note="commit is not on $main; owner is the commit author"
else
  # Binary search, oldest containing first-parent merge (predicate is monotonic).
  lo=0; hi=$((${#merges[@]} - 1))
  while [[ $lo -lt $hi ]]; do
    mid=$(((lo + hi + 1) / 2))
    if contains "${merges[$mid]}"; then lo=$mid; else hi=$((mid - 1)); fi
  done
  merge="${merges[$lo]}"
  if contains "$merge^1"; then
    note="commit is directly on $main; no PR merge introduced it"
  else
    merge_subject="$(git show -s --format=%s "$merge")"
    if [[ "$merge_subject" =~ Merge\ pull\ request\ \#([0-9]+)\ from\ [^/]+/(.+)$ ]]; then
      pr="${BASH_REMATCH[1]}"
      branch="${BASH_REMATCH[2]}"
    else
      note="introducing merge is not a PR merge: $merge_subject"
    fi
  fi
fi

# Thread lookup: exact branch match, owner thread before workflow workers.
thread_id=""; thread_title=""; thread_status=""; thread_archived=""
if [[ -n "$branch" ]] && command -v t3 >/dev/null && command -v python3 >/dev/null; then
  for src in "t3 chat list" "t3 chat archived"; do
    # shellcheck disable=SC2086
    chats="$($src 2>/dev/null || true)"
    [[ -n "$chats" ]] || continue
    picked="$(BRANCH="$branch" python3 -c '
import json, os, sys
try:
    chats = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cands = [c for c in chats if (c.get("branch") or "") == os.environ["BRANCH"]]
cands.sort(key=lambda c: (str(c.get("id", "")).startswith("workflow:"), str(c.get("title", ""))))
if cands:
    c = cands[0]
    s = c.get("session") or {}
    print("\t".join([str(c.get("id", "")), str(c.get("title", "")),
                      str(s.get("status", "")), str(s.get("activeTurnId") or "")]))
' <<<"$chats")"
    if [[ -n "$picked" ]]; then
      IFS=$'\t' read -r thread_id thread_title thread_status active_turn <<<"$picked"
      [[ "$src" == *archived* ]] && thread_archived="yes"
      break
    fi
  done
fi

if [[ $json -eq 1 ]]; then
  COMMIT="$sha" SUBJECT="$subject" AUTHOR="$author" MERGE="$merge" PR="$pr" BRANCH="$branch" \
  NOTE="$note" TID="$thread_id" TTITLE="$thread_title" TSTATUS="$thread_status" \
  TARCHIVED="$thread_archived" FILE="$file" LINE="$line" REV="$rev" python3 -c '
import json, os
print(json.dumps({k.lower(): os.environ[k] for k in
  ["FILE", "LINE", "REV", "COMMIT", "SUBJECT", "AUTHOR", "MERGE", "PR",
   "BRANCH", "NOTE", "TID", "TTITLE", "TSTATUS", "TARCHIVED"]}))'
  exit 0
fi

echo "line:    $file:$line @ $rev"
echo "commit:  $sha $subject ($author)"
if [[ -n "$pr" ]]; then
  echo "pr:      #$pr (branch $branch, via $merge)"
elif [[ -n "$note" ]]; then
  echo "pr:      n/a ($note)"
fi
if [[ -n "$thread_id" ]]; then
  echo "thread:  $thread_title [$thread_id] status=$thread_status${thread_archived:+, archived}${active_turn:+, active turn}"
elif [[ -n "$branch" ]]; then
  echo "thread:  none found on branch $branch (t3 CLI unavailable or thread archived/renamed)"
fi
