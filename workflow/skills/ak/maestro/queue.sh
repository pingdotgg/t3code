#!/usr/bin/env bash
# The maestro dispatcher without a model. Each tick, per project: requeue issues whose worker
# thread is gone, start a maestro-worker thread per frontier issue while fewer than
# MAESTRO_MAX_WORKERS worker threads run across all listed projects, close finished epics,
# and tell the project's master thread about needs-help, epic done and unblocked human tasks.
# Labels and comments follow SKILL.md, so a maestro thread and this script agree.
#
#   queue.sh [--loop] [--interval 60] <project-folder>[=<master-thread-id>]...
#
# Run it as a T3 Code daemon (Settings > Daemons, or `t3 daemon add`) with --loop; one per server.
# Env: MAESTRO_MAX_WORKERS (8), MAESTRO_PROVIDER + MAESTRO_MODEL (else the project's default
# model), T3_BIN (else this server's own build, then `t3` on PATH).
set -uo pipefail

usage() {
  echo "usage: queue.sh [--loop] [--interval seconds] <project-folder>[=<master-thread-id>]..." >&2
  exit 2
}

loop=false
interval=60
projects=()
masters=()
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
    *=*)
      projects+=("${1%%=*}")
      masters+=("${1#*=}")
      ;;
    *)
      projects+=("$1")
      masters+=("")
      ;;
  esac
  shift
done
[ ${#projects[@]} -gt 0 ] || usage
for i in "${!projects[@]}"; do
  projects[i]="$(cd "${projects[$i]/#\~/$HOME}" && pwd)" || exit 2
done
[[ "$interval" =~ ^[0-9]+$ ]] || usage

max="${MAESTRO_MAX_WORKERS:-8}"
# The `t3` on PATH can be an older release whose database migrations differ from this server's.
if [ -n "${T3_BIN:-}" ]; then
  t3=("$T3_BIN")
elif [ -n "${T3CODE_SOURCE_CHECKOUT:-}" ] && [ -f "$T3CODE_SOURCE_CHECKOUT/apps/server/dist/bin.mjs" ]; then
  t3=(node "$T3CODE_SOURCE_CHECKOUT/apps/server/dist/bin.mjs")
else
  t3=(t3)
fi
model_args=()
if [ -n "${MAESTRO_PROVIDER:-}" ] && [ -n "${MAESTRO_MODEL:-}" ]; then
  model_args=(--provider "$MAESTRO_PROVIDER" --model "$MAESTRO_MODEL")
elif [ -n "${MAESTRO_MODEL:-}" ]; then
  model_args=(--model "$MAESTRO_MODEL")
fi
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/maestro-queue"
mkdir -p "$state_dir"
live_statuses='["idle","preparing","queued","starting","running","waiting"]'

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Issue numbers of a project's worker threads that are still alive, one per line.
live_workers() {
  "${t3[@]}" thread list --project "$1" --json | jq -r --argjson live "$live_statuses" '.[]
    | select(.title | test("^mw-[0-9]+ "))
    | select(.status as $s | $live | index($s))
    | .title | capture("^mw-(?<n>[0-9]+) ").n' | sort -u
}

has_comment() {
  gh issue view "$1" --json comments --jq "any(.comments[]; .body | startswith(\"$2\"))"
}

needs_help() {
  gh issue edit "$1" --add-label needs-help --remove-label in-progress >/dev/null
  gh issue comment "$1" --body "maestro: needs help. $2" >/dev/null
}

# Sends one line to the project's master thread; without a master it only logs.
tell_master() {
  local master="$1" name="$2" line="$3"
  log "$name $line"
  [ -n "$master" ] || return 0
  "${t3[@]}" thread send "$master" "$line" >/dev/null || log "$name: could not message the master"
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
      needs_help "$n" "worker disappeared twice without finishing."
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
  local folder="$1" name="$2" live="$3" room="$4" repo base frontier n title free blockers started=0 err
  [ "$room" -gt 0 ] || {
    echo 0
    return
  }
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  base="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" || return 1
  frontier="$(gh issue list --label ready-for-agent --state open --limit 50 \
    --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human sort:created-asc" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"')" || return 1
  while IFS=$'\t' read -r n title; do
    [ -n "$n" ] || continue
    [ "$started" -lt "$room" ] || break
    grep -qx "$n" <<<"$live" && continue
    # Search lags by a few seconds; re-read before claiming.
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human")) | not)')"
    [ "$free" = true ] || continue
    # The search's -is:blocked lags behind edges added seconds ago, as when an issue is split.
    blockers="$(gh api "repos/$repo/issues/$n/dependencies/blocked_by" --paginate |
      jq -s '[add // [] | .[] | select(.state == "open")] | length')" || continue
    [ "$blockers" = 0 ] || continue
    gh issue edit "$n" --add-label in-progress >/dev/null
    gh issue comment "$n" --body "maestro: claimed" >/dev/null
    if err="$("${t3[@]}" thread start "$folder" "Use the \`maestro-worker\` skill for issue #$n in $repo." \
      --title "mw-$n $title" --worktree "$base" "${model_args[@]}" 2>&1 >/dev/null)"; then
      started=$((started + 1))
      log "$name #$n dispatched: $title" >&2
    else
      # A failed start is a setup problem, not a vanished worker: say what failed, don't retry it.
      needs_help "$n" "could not start a worker: $(tail -n 3 <<<"$err" | tr '\n' ' ')"
      log "$name #$n could not start a worker: $err" >&2
    fi
  done <<<"$frontier"
  echo "$started"
}

# Lines in $2 (current) missing from state file $1, after which the file holds $2.
new_since_last() {
  local file="$1" current="$2"
  comm -13 <(sort -u "$file" 2>/dev/null) <(sort -u <<<"$current" | grep .)
  sort -u <<<"$current" | grep . >"$file.tmp"
  mv "$file.tmp" "$file"
}

needs_help_issues() {
  gh issue list --label needs-help --state open --limit 100 --json number,url \
    --jq '.[] | "\(.number) \(.url)"'
}

unblocked_human_issues() {
  gh issue list --label ready-for-human --state open --limit 100 --search "-is:blocked" \
    --json number,url --jq '.[] | "\(.number) \(.url)"'
}

state_key() {
  local repo
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  echo "$state_dir/${repo//\//_}"
}

# On a project's first run, what is already open was reported by whoever ran before.
seed_state() {
  local key
  key="$(state_key)" || return 1
  [ -f "$key.needs-help" ] || needs_help_issues >"$key.needs-help"
  [ -f "$key.ready-for-human" ] || unblocked_human_issues >"$key.ready-for-human"
}

# Closes finished epics and tells the master about needs-help and unblocked human tasks.
report() {
  local name="$1" master="$2" repo key epics n url open_subs total current line
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  key="$(state_key)" || return 1

  epics="$(gh issue list --label epic --state open --limit 100 --json number,url \
    --jq '.[] | "\(.number) \(.url)"')" || return 1
  while read -r n url; do
    [ -n "$n" ] || continue
    read -r total open_subs < <(gh api "repos/$repo/issues/$n/sub_issues" --paginate |
      jq -rs 'add // [] | "\(length) \([.[] | select(.state == "open")] | length)"')
    [ "${total:-0}" -gt 0 ] && [ "${open_subs:-1}" -eq 0 ] || continue
    gh issue close "$n" --comment "maestro: every sub-issue is closed." >/dev/null
    tell_master "$master" "$name" "#$n epic done $url"
  done <<<"$epics"

  current="$(needs_help_issues)" || return 1
  while read -r n url; do
    [ -n "$n" ] || continue
    line="$(gh issue view "$n" --json comments --jq '[.comments[].body | select(startswith("maestro: needs help."))] | last // "see the issue." | sub("^maestro: needs help. "; "")')"
    tell_master "$master" "$name" "#$n needs-help: ${line:-see the issue.} $url"
  done < <(new_since_last "$key.needs-help" "$current")

  current="$(unblocked_human_issues)" || return 1
  while read -r n url; do
    [ -n "$n" ] || continue
    tell_master "$master" "$name" "#$n ready-for-human unblocked $url"
  done < <(new_since_last "$key.ready-for-human" "$current")
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
    (
      cd "$folder" || exit 1
      report "$name" "${masters[$i]}"
    ) || log "$name: report failed"
  done
  return 0
}

for folder in "${projects[@]}"; do
  (cd "$folder" && seed_state) || log "$folder: could not read its issues"
done

if ! $loop; then
  tick
  exit
fi

log "maestro queue: ${projects[*]} (max $max workers, every ${interval}s, t3: ${t3[*]})"
while true; do
  tick || log "tick failed; retrying in ${interval}s"
  sleep "$interval"
done
