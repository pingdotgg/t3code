#!/usr/bin/env bash
# shellcheck disable=SC2016  # backticks in --format strings and awk are literal Markdown
set -euo pipefail

# Upstream Radar: fetch tracked reference repos into gitignored `.refs/`
# (Conn itself is this monorepo, so it is not tracked here) and report commits since
# each pinned SHA in `references.pin`. Security and data-loss fixes are listed first,
# then other likely fixes, each apart from the commit list, so its limit hides neither.
#
# Usage:
#   scripts/radar.sh                   # markdown report for all tracked repos
#   scripts/radar.sh --repo t3code     # report for one repo
#   scripts/radar.sh --limit 60        # max commits listed per repo (default: 40)
#   scripts/radar.sh --fix-limit 300   # max likely fixes listed per repo (default: 200)
#   scripts/radar.sh --no-fetch        # inspect already-fetched origin refs
#   scripts/radar.sh --bump t3code     # advance references.pin for one repo to origin/HEAD
#   scripts/radar.sh --bump-all        # advance all tracked radar pins to origin/HEAD

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="$ROOT/references.pin"

# Commit messages (subject or body) that point at a security or data-loss fix.
SECURITY_GREP=(
  --regexp-ignore-case --extended-regexp
  --grep='secur|vulnerab|cve-|leak|data[ -]?loss|lost|corrupt|injection|traversal|xss|csrf|privilege|bypass|exfiltrat|secret|redact'
)
# Other likely fixes. git ORs several --grep options. T3 labels most commits `fix(`,
# so this list is long; the security list above is the one to read in full.
FIX_GREP=(
  --regexp-ignore-case --extended-regexp
  --grep='^(fix|revert)(\(|!|:)'
  --grep='crash|deadlock|hang|(^|[^a-z])races?([^a-z]|$)'
)

# Lines of "<sha>|<date>|<subject>" in, Markdown list items out.
print_commits() {
  awk '{
    i = index($0, "|"); sha = substr($0, 1, i - 1); rest = substr($0, i + 1)
    j = index(rest, "|"); printf "- `%s` (%s) %s\n", sha, substr(rest, 1, j - 1), substr(rest, j + 1)
  }'
}

count_lines() {
  if [[ -z "$1" ]]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi
}

# Ordered list of radar repos: "<pin_key>|<git_url>|<mode>"
# mode: "blobless" (no working tree, ideal for large monorepos like t3code)
#       "checkout" (uses existing .refs/<key> working clone if present)
RADAR_REPOS=(
  "t3code|https://github.com/pingdotgg/t3code.git|blobless"
  "threadbear|https://github.com/mikecann/threadbear.git|checkout"
  "rune|https://github.com/anomalyco/rune.git|checkout"
)

ONLY_REPO=""
LIMIT=40
FIX_LIMIT=200
NO_FETCH=0
BUMP_TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      ONLY_REPO="${2:?--repo requires a name}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:?--limit requires an integer}"
      shift 2
      ;;
    --fix-limit)
      FIX_LIMIT="${2:?--fix-limit requires an integer}"
      shift 2
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    --bump)
      BUMP_TARGET="${2:?--bump requires a repo name}"
      shift 2
      ;;
    --bump-all)
      BUMP_TARGET="__ALL__"
      shift
      ;;
    -h|--help)
      sed -n '5,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

get_pin() {
  local key="$1"
  grep -E "^${key}=" "$PIN_FILE" | head -n 1 | cut -d= -f2 || true
}

set_pin() {
  local key="$1"
  local sha="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$sha" '
    BEGIN { updated = 0 }
    $0 ~ ("^" k "=") { print k "=" v; updated = 1; next }
    { print }
    END { if (!updated) print k "=" v }
  ' "$PIN_FILE" > "$tmp"
  mv "$tmp" "$PIN_FILE"
}

ensure_repo() {
  local key="$1"
  local url="$2"
  local mode="$3"
  local dir="$ROOT/.refs/$key"
  local pin
  pin="$(get_pin "$key")"

  mkdir -p "$ROOT/.refs"

  if [[ ! -d "$dir/.git" ]]; then
    if [[ "$mode" == "blobless" ]]; then
      git clone --filter=blob:none --no-checkout --quiet "$url" "$dir"
    else
      git clone --filter=blob:none --quiet "$url" "$dir"
    fi
  fi

  if [[ "$NO_FETCH" -eq 0 ]]; then
    # Unshallow if needed so `pin..origin/HEAD` commit logs are complete.
    if [[ -f "$dir/.git/shallow" ]]; then
      git -C "$dir" fetch --unshallow --filter=blob:none --quiet origin 2>/dev/null \
        || git -C "$dir" fetch --filter=blob:none --quiet origin
    else
      git -C "$dir" fetch --filter=blob:none --quiet origin
    fi
    # Ensure the pinned commit itself is reachable locally.
    if [[ -n "$pin" ]] && ! git -C "$dir" cat-file -e "${pin}^{commit}" 2>/dev/null; then
      git -C "$dir" fetch --filter=blob:none --quiet origin "$pin" 2>/dev/null || true
    fi
  fi
}

default_remote_ref() {
  local dir="$1"
  local ref
  ref="$(git -C "$dir" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$ref" ]]; then
    echo "$ref"
    return
  fi
  if git -C "$dir" show-ref --verify --quiet refs/remotes/origin/main; then
    echo "refs/remotes/origin/main"
    return
  fi
  if git -C "$dir" show-ref --verify --quiet refs/remotes/origin/master; then
    echo "refs/remotes/origin/master"
    return
  fi
  echo "FETCH_HEAD"
}

if [[ -n "$BUMP_TARGET" ]]; then
  matched=0
  for entry in "${RADAR_REPOS[@]}"; do
    IFS='|' read -r key url mode <<< "$entry"
    if [[ "$BUMP_TARGET" != "__ALL__" && "$BUMP_TARGET" != "$key" ]]; then
      continue
    fi
    matched=1
    ensure_repo "$key" "$url" "$mode"
    dir="$ROOT/.refs/$key"
    ref="$(default_remote_ref "$dir")"
    new_sha="$(git -C "$dir" rev-parse "$ref")"
    old_sha="$(get_pin "$key")"
    set_pin "$key" "$new_sha"
    if [[ "$mode" == "checkout" ]]; then
      git -C "$dir" checkout --detach "$new_sha" >/dev/null 2>&1 || true
    fi
    echo "bumped $key: ${old_sha:0:10} -> ${new_sha:0:10}"
  done
  if [[ "$matched" -eq 0 ]]; then
    echo "error: unknown radar repo '$BUMP_TARGET'" >&2
    exit 1
  fi
  exit 0
fi

echo "# Upstream Radar Digest ($(date -u '+%Y-%m-%d %H:%M UTC'))"
echo
echo "Scope filter: \`docs/scope.md\` · Pins: \`references.pin\`"
echo

matched=0
for entry in "${RADAR_REPOS[@]}"; do
  IFS='|' read -r key url mode <<< "$entry"
  if [[ -n "$ONLY_REPO" && "$ONLY_REPO" != "$key" ]]; then
    continue
  fi
  matched=1

  pin="$(get_pin "$key")"
  ensure_repo "$key" "$url" "$mode"
  dir="$ROOT/.refs/$key"
  ref="$(default_remote_ref "$dir")"
  head_sha="$(git -C "$dir" rev-parse "$ref")"

  echo "## \`$key\` (\`${pin:0:10}\` → \`${head_sha:0:10}\`)"
  echo

  if [[ -z "$pin" ]]; then
    echo "_No pin in \`references.pin\`. Run \`scripts/radar.sh --bump $key\` to initialize._"
    echo
    continue
  fi

  if [[ "$pin" == "$head_sha" ]]; then
    echo "_Up to date (0 new commits)._"
    echo
    continue
  fi

  if ! git -C "$dir" cat-file -e "${pin}^{commit}" 2>/dev/null; then
    echo "_Pinned commit \`${pin:0:10}\` not found in remote history; showing latest $LIMIT commits on \`$ref\`:_"
    echo
    git -C "$dir" log --no-merges -n "$LIMIT" --format='- `%h` (%ad) %s' --date=short "$ref"
    echo
    continue
  fi

  count="$(git -C "$dir" rev-list --no-merges --count "${pin}..${ref}")"
  security_log="$(git -C "$dir" log --no-merges "${SECURITY_GREP[@]}" --format='%h|%ad|%s' --date=short "${pin}..${ref}")"
  fix_log="$(git -C "$dir" log --no-merges "${FIX_GREP[@]}" --format='%h|%ad|%s' --date=short "${pin}..${ref}")"
  other_fix_log="$(awk -F'|' 'NR == FNR { seen[$1] = 1; next } $1 != "" && !($1 in seen)' \
    <(printf '%s\n' "$security_log") <(printf '%s\n' "$fix_log"))"

  echo "**Security and data-loss fixes: $(count_lines "$security_log")** (all listed). Check each against the Conn code that copied the same logic:"
  echo
  if [[ -z "$security_log" ]]; then echo "_None matched._"; else printf '%s\n' "$security_log" | print_commits; fi
  echo
  echo "**Other likely fixes: $(count_lines "$other_fix_log")** (showing up to ${FIX_LIMIT}):"
  echo
  if [[ -z "$other_fix_log" ]]; then echo "_None matched._"; else printf '%s\n' "$other_fix_log" | head -n "$FIX_LIMIT" | print_commits; fi
  echo

  echo "**${count} new non-merge commit(s)** (showing up to ${LIMIT}):"
  echo
  git -C "$dir" log --no-merges -n "$LIMIT" --format='- `%h` (%ad) %s' --date=short "${pin}..${ref}"
  echo

  echo "**Top touched areas:**"
  echo '```'
  git -C "$dir" diff --name-only "${pin}..${ref}" 2>/dev/null \
    | awk -F/ '{ if (NF >= 2) print $1 "/" $2; else print $1 }' \
    | sort | uniq -c | sort -rn | head -n 12
  echo '```'
  echo
done

if [[ "$matched" -eq 0 ]]; then
  echo "error: unknown radar repo '$ONLY_REPO'" >&2
  exit 1
fi
