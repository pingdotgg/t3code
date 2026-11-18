#!/usr/bin/env bash
# The maestro dispatcher without a model. Each tick, per project: requeue issues whose worker
# thread is gone, then start a maestro-worker thread per frontier issue while fewer than
# MAESTRO_MAX_WORKERS worker threads run across all listed projects.
# Labels and comments follow SKILL.md, so a maestro thread and this script agree.
#
#   queue.sh [--loop] [--interval 60] <project-folder>...
#
# Run it as a T3 Code daemon (Settings > Daemons) with --loop; one per server.
set -uo pipefail

usage() {
  echo "usage: queue.sh [--loop] [--interval seconds] <project-folder>..." >&2
  exit 2
}

loop=false
interval=60
projects=()
while [ $# -gt 0 ]; do
  case "$1" in
    --loop) loop=true ;;
    --interval)
      [ $# -ge 2 ] || usage
      interval="$2"
      shift
      ;;
    --interval=*) interval="${1#--interval=}" ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) projects+=("$1") ;;
  esac
  shift
done
[ ${#projects[@]} -gt 0 ] || usage
for i in "${!projects[@]}"; do
  projects[i]="$(cd "${projects[$i]}" && pwd)" || exit 2
done
[[ "$interval" =~ ^[0-9]+$ ]] || usage

max="${MAESTRO_MAX_WORKERS:-8}"
t3="${T3_BIN:-t3}"
live_statuses='["idle","preparing","queued","starting","running","waiting"]'

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Issue numbers of a project's worker threads that are still alive, one per line.
live_workers() {
  "$t3" thread list --project "$1" --json | jq -r --argjson live "$live_statuses" '.[]
    | select(.title | test("^mw-[0-9]+ "))
    | select(.status as $s | $live | index($s))
    | .title | capture("^mw-(?<n>[0-9]+) ").n' | sort -u
}

has_comment() {
  gh issue view "$1" --json comments --jq "any(.comments[]; .body | startswith(\"$2\"))"
}

# An in-progress issue this dispatcher claimed whose worker thread is gone.
requeue() {
  local name="$1" live="$2" claimed n labels
  claimed="$(gh issue list --label in-progress --state open --limit 100 --json number,labels \
    --jq '.[] | "\(.number) \([.labels[].name] | join(","))"')" || return 1
  while read -r n labels; do
    [ -n "$n" ] || continue
    grep -qx "$n" <<<"$live" && continue
    [[ ",$labels," == *",ready-for-human,"* ]] && continue
    [ "$(has_comment "$n" "maestro: claimed")" = true ] || continue
    if [[ ",$labels," == *",needs-help,"* ]]; then
      gh issue edit "$n" --remove-label in-progress >/dev/null
      log "$name #$n needs help; dropped in-progress"
    elif [ "$(has_comment "$n" "maestro: requeued")" = true ]; then
      gh issue edit "$n" --add-label needs-help --remove-label in-progress >/dev/null
      gh issue comment "$n" \
        --body "maestro: needs help. worker disappeared twice without finishing." >/dev/null
      log "$name #$n needs help: worker disappeared twice"
    else
      gh issue comment "$n" \
        --body "maestro: requeued after the worker ended without finishing." >/dev/null
      gh issue edit "$n" --remove-label in-progress >/dev/null
      log "$name #$n requeued"
    fi
  done <<<"$claimed"
}

# Starts workers for frontier issues; prints the number started.
dispatch() {
  local folder="$1" name="$2" live="$3" room="$4" repo base frontier n title free started=0
  [ "$room" -gt 0 ] || {
    echo 0
    return
  }
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  base="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" || return 1
  frontier="$(gh issue list --label ready-for-agent --state open --limit 50 \
    --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human -label:hold sort:created-asc" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"')" || return 1
  while IFS=$'\t' read -r n title; do
    [ -n "$n" ] || continue
    [ "$started" -lt "$room" ] || break
    grep -qx "$n" <<<"$live" && continue
    # Search lags by a few seconds; re-read before claiming.
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human", "hold")) | not)')"
    [ "$free" = true ] || continue
    gh issue edit "$n" --add-label in-progress >/dev/null
    gh issue comment "$n" --body "maestro: claimed" >/dev/null
    if "$t3" thread start "$folder" "Use the \`maestro-worker\` skill for issue #$n in $repo." \
      --title "mw-$n $title" --worktree "$base" >/dev/null; then
      started=$((started + 1))
      log "$name #$n dispatched: $title" >&2
    else
      log "$name #$n could not start a worker; it will be requeued" >&2
    fi
  done <<<"$frontier"
  echo "$started"
}

tick() {
  local folder name live running=0 lives=() i
  for i in "${!projects[@]}"; do
    folder="${projects[$i]}"
    live="$(live_workers "$folder")" || {
      log "$folder: could not list threads"
      return 1
    }
    lives[i]="$live"
    running=$((running + $(grep -c . <<<"$live")))
  done
  for i in "${!projects[@]}"; do
    folder="${projects[$i]}"
    name="$(basename "$folder")"
    (
      cd "$folder" || exit 1
      requeue "$name" "${lives[$i]}"
    ) || log "$name: requeue failed"
    local started
    started="$(cd "$folder" && dispatch "$folder" "$name" "${lives[$i]}" $((max - running)))" ||
      log "$name: dispatch failed"
    running=$((running + ${started:-0}))
  done
  return 0
}

if ! $loop; then
  tick
  exit
fi

log "maestro queue: ${projects[*]} (max $max workers, every ${interval}s)"
while true; do
  tick || log "tick failed; retrying in ${interval}s"
  sleep "$interval"
done
