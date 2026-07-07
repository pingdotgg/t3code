#!/usr/bin/env bash
# Merge a green PR and advance loop-state — used when require_merge_approval=false.
# Usage: advance-pr.sh <pr-number> <step-id> [next-step-id]
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: advance-pr.sh <pr-number> <step-id> [next-step-id]" >&2
  exit 1
fi

PR_NUM="$1"
STEP_ID="$2"
NEXT_STEP="${3:-}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

STATE_FILE="scratch/android-parity/loop-state.json"
CONFIG_FILE="scratch/android-parity/loop-config.json"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "Missing $STATE_FILE" >&2
  exit 1
fi

GH_REPO_ARGS=()
FORK="$(jq -r '.fork // empty' "$CONFIG_FILE" 2>/dev/null || true)"
if [[ -n "$FORK" ]]; then
  GH_REPO_ARGS=(--repo "$FORK")
fi

# Default next step: increment numeric suffix; skip optional gate steps in automated mode.
if [[ -z "$NEXT_STEP" ]]; then
  COMPLETION_MODE="$(jq -r '.completion_mode // "automated"' "$CONFIG_FILE" 2>/dev/null || echo automated)"
  if [[ "$STEP_ID" =~ ^s([0-9]+)(.*)$ ]]; then
    NUM="${BASH_REMATCH[1]}"
    SUFFIX="${BASH_REMATCH[2]}"
    NEXT_NUM=$((10#$NUM + 1))
    NEXT_STEP="s${NEXT_NUM}${SUFFIX}"
    if [[ "$COMPLETION_MODE" == "automated" ]]; then
      case "$NEXT_STEP" in
        s09b) NEXT_STEP="s10" ;;
        s27b) NEXT_STEP="s28" ;;
      esac
    fi
  else
    NEXT_STEP="$STEP_ID"
  fi
fi

echo "==> Checking PR #$PR_NUM status"
PR_JSON="$(NO_COLOR=1 gh pr view "$PR_NUM" "${GH_REPO_ARGS[@]}" --json state,mergeable,mergeStateStatus,statusCheckRollup,url,mergedAt \
  | sed 's/\x1b\[[0-9;]*m//g')"
STATE="$(echo "$PR_JSON" | jq -r '.state')"

if [[ "$STATE" == "MERGED" ]]; then
  echo "PR #$PR_NUM already merged"
elif [[ "$STATE" != "OPEN" ]]; then
  echo "PR #$PR_NUM is $STATE — cannot merge" >&2
  exit 1
else
  MERGEABLE="$(echo "$PR_JSON" | jq -r '.mergeable')"
  if [[ "$MERGEABLE" == "CONFLICTING" ]]; then
    echo "PR #$PR_NUM has merge conflicts" >&2
    exit 1
  fi

  FAILED="$(echo "$PR_JSON" | jq '[.statusCheckRollup[]? | select(.conclusion == "FAILURE" or .conclusion == "ERROR")] | length')"
  if [[ "$FAILED" != "0" ]]; then
    echo "PR #$PR_NUM has $FAILED failing CI check(s)" >&2
    exit 1
  fi

  MERGE_POLICY="$(jq -r '.merge_policy // "ci_green"' "$CONFIG_FILE" 2>/dev/null || echo ci_green)"
  PENDING="$(echo "$PR_JSON" | jq '[.statusCheckRollup[]? | select(.status == "IN_PROGRESS" or .status == "QUEUED")] | length')"
  if [[ "$PENDING" != "0" && "$MERGE_POLICY" != "local_gate" ]]; then
    echo "PR #$PR_NUM has $PENDING pending CI check(s)" >&2
    exit 1
  fi
  if [[ "$PENDING" != "0" && "$MERGE_POLICY" == "local_gate" ]]; then
    echo "==> merge_policy=local_gate: proceeding with $PENDING queued check(s) (local gate already passed)"
  fi

  echo "==> Merging PR #$PR_NUM (squash)"
  NO_COLOR=1 gh pr merge "$PR_NUM" "${GH_REPO_ARGS[@]}" --squash --delete-branch
  PR_JSON="$(NO_COLOR=1 gh pr view "$PR_NUM" "${GH_REPO_ARGS[@]}" --json url,mergedAt \
    | sed 's/\x1b\[[0-9;]*m//g')"
fi

PR_URL="$(echo "$PR_JSON" | jq -r '.url')"
MERGED_AT="$(echo "$PR_JSON" | jq -r '.mergedAt // empty')"
if [[ -z "$MERGED_AT" || "$MERGED_AT" == "null" ]]; then
  MERGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

echo "==> Updating loop-state.json: $STEP_ID → $NEXT_STEP"
TMP="$(mktemp)"
jq --arg step "$STEP_ID" \
  --arg url "$PR_URL" \
  --arg merged "$MERGED_AT" \
  --arg next "$NEXT_STEP" \
  '
  .steps[$step] = {
    status: "merged",
    pr: $url,
    merged_at: $merged
  }
  | .current_step = $next
  ' "$STATE_FILE" > "$TMP"
mv "$TMP" "$STATE_FILE"

echo "==> Syncing main"
git fetch origin main
git checkout main
git pull origin main

echo "==> Advanced: $STEP_ID merged → current_step=$NEXT_STEP"