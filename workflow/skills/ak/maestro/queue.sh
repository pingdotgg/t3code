#!/usr/bin/env bash
# The maestro dispatcher without a model. Each tick, per project: requeue issues whose worker
# thread is gone (a fresh worker each time, MAESTRO_RETRIES times), stop workers that stalled, start a maestro-reviewer thread per ready-for-review
# issue and a maestro-worker thread per frontier issue while fewer than MAESTRO_MAX_WORKERS
# threads run across all listed projects, close finished epics, and tell the project's master
# thread about needs-help, epic done and unblocked human tasks.
# Labels and comments follow SKILL.md, so a maestro thread and this script agree.
#
#   queue.sh [--loop] [--interval 60] <project-folder>[=<master-thread-id>]...
#
# Run it as a T3 Code daemon (Settings > Daemons, or `t3 daemon add`) with --loop; one per server.
# Env: MAESTRO_MAX_WORKERS (8), MAESTRO_PROVIDER + MAESTRO_MODEL (else the project's default
# model), MAESTRO_REVIEW_MODELS (space-separated `provider/model` or `model`; each review picks
# one at random, else it runs on the builders' model), MAESTRO_STALL_MINUTES (60), MAESTRO_RETRIES (2),
# T3_BIN (else this server's own build, then `t3` on PATH).
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
stall_minutes="${MAESTRO_STALL_MINUTES:-60}"
retries="${MAESTRO_RETRIES:-2}"
read -r -a review_models <<<"${MAESTRO_REVIEW_MODELS:-}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/maestro-queue"
mkdir -p "$state_dir"
live_statuses='["idle","preparing","queued","starting","running","waiting"]'

# Model flags for one review: a random entry of MAESTRO_REVIEW_MODELS, else the builders' own.
review_model_args() {
  if [ ${#review_models[@]} -eq 0 ]; then
    [ ${#model_args[@]} -eq 0 ] || printf '%s\n' "${model_args[@]}"
    return
  fi
  local pick="${review_models[RANDOM % ${#review_models[@]}]}"
  if [[ "$pick" == */* ]]; then
    printf '%s\n' --provider "${pick%%/*}" --model "${pick#*/}"
  else
    printf '%s\n' --model "$pick"
  fi
}

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Issue numbers of a project's worker threads that are still alive, one per line. The `mw-<n> `
# title prefix is also how the web sidebar files them under Workers (sidebar/sidebarWorkers.ts).
live_workers() {
  "${t3[@]}" thread list --project "$1" --json | jq -r --argjson live "$live_statuses" '.[]
    | select(.title | test("^mw-[0-9]+ "))
    | select(.status as $s | $live | index($s))
    | .title | capture("^mw-(?<n>[0-9]+) ").n' | sort -u
}

# true when no `maestro: retry` comment follows the issue's last claim, so the attempt left no report.
attempt_unreported() {
  gh issue view "$1" --json comments --jq '[.comments[].body] as $b
    | ([$b | to_entries[] | select(.value | startswith("maestro: claimed")) | .key] | max // -1) as $claim
    | ([$b | to_entries[] | select(.value | startswith("maestro: retry")) | .key] | max // -1) as $retry
    | $retry < $claim'
}

# Failed attempts in the current phase: retry comments after the builder's last handoff, so a
# reviewer gets its own budget instead of whatever the build phase left.
failed_attempts() {
  gh issue view "$1" --json comments --jq '[.comments[].body] as $b
    | ([$b | to_entries[] | select(.value | startswith("maestro: handed off")) | .key] | max // -1) as $handoff
    | [$b | to_entries[] | select(.key > $handoff and (.value | startswith("maestro: retry")))] | length'
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

# An in-progress issue this dispatcher claimed whose worker thread is gone: a fresh worker, until
# MAESTRO_RETRIES attempts after the first have failed. Each failed attempt leaves one retry comment.
requeue() {
  local name="$1" live="$2" claimed n labels failed
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
    else
      if [ "$(attempt_unreported "$n")" = true ]; then
        gh issue comment "$n" --body "maestro: retry: the worker ended without finishing or leaving a report." >/dev/null
      fi
      failed="$(failed_attempts "$n")"
      if [ "${failed:-0}" -gt "$retries" ]; then
        needs_help "$n" "$failed attempts failed; each \`maestro: retry\` comment says what it tried."
      else
        gh issue edit "$n" --remove-label in-progress >/dev/null
        log "$name #$n retried ($failed failed so far)"
      fi
    fi
  done <<<"$claimed"
}

# A live worker whose issue, branch and PR have not moved for MAESTRO_STALL_MINUTES is stopped with a
# retry comment; the next tick finds its issue orphaned and retries it.
stop_stalls() {
  local name="$1" live="$2" folder="$3" repo n labels last branch prs age thread
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  while read -r n labels; do
    [ -n "$n" ] || continue
    grep -qx "$n" <<<"$live" || continue
    [[ ",$labels," == *",needs-help,"* ]] && continue
    last="$(gh issue view "$n" --json updatedAt --jq .updatedAt)" || continue
    branch="$(gh api "repos/$repo/branches/task/$n" --jq .commit.commit.committer.date 2>/dev/null)" || branch=""
    prs="$(gh pr list --head "task/$n" --state all --json updatedAt --jq '.[].updatedAt' 2>/dev/null)" || prs=""
    last="$(printf '%s\n' "$last" "$branch" $prs | grep . | sort | tail -n 1)"
    age="$(jq -rn --arg t "$last" '(now - ($t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) | floor')" || continue
    [ "$age" -ge $((stall_minutes * 60)) ] || continue
    thread="$("${t3[@]}" thread list --project "$folder" --json | jq -r --argjson live "$live_statuses" --arg n "$n" '[.[]
      | select(.title | startswith("mw-" + $n + " ")) | select(.status as $s | $live | index($s)) | .threadId] | first // empty')"
    # Ended since the tick began (or the list failed): next tick's requeue sees an orphan.
    [ -n "$thread" ] || continue
    if "${t3[@]}" thread stop "$thread" --reason "maestro: no push, comment or label change for $stall_minutes minutes" >/dev/null; then
      gh issue comment "$n" --body "maestro: retry: the worker made no push, comment or label change for $stall_minutes minutes, so the maestro stopped it." >/dev/null
      log "$name #$n stopped as stalled"
    else
      needs_help "$n" "the worker made no push, comment or label change for $stall_minutes minutes, and the maestro could not stop its thread."
    fi
  done < <(gh issue list --label in-progress --state open --limit 100 --json number,labels \
    --jq '.[] | "\(.number) \([.labels[].name] | join(","))"')
}

# The branch an issue's PR targets: epic/<e> when its nearest epic ancestor (a split part's parent is
# the ticket it came from) is labelled integration, created from the default branch the first time;
# empty for the default branch. Returns 1 when GitHub could not be read, 2 when the branch could not
# be created (after printing its name).
integration_base() {
  local repo="$1" default="$2" n="$3" depth parent sha epic integration
  for depth in 1 2 3 4 5; do
    if ! parent="$(gh api "repos/$repo/issues/$n/parent" \
      --jq '"\(.number) \(any(.labels[]; .name == "epic")) \(any(.labels[]; .name == "integration"))"' 2>&1)"; then
      grep -q "404" <<<"$parent" && return 0
      return 1
    fi
    read -r n epic integration <<<"$parent"
    [ "$integration" = true ] && break
    [ "$epic" = true ] && return 0
  done
  [ "${integration:-false}" = true ] || return 0
  echo "epic/$n"
  gh api "repos/$repo/git/ref/heads/epic/$n" >/dev/null 2>&1 && return 0
  sha="$(gh api "repos/$repo/git/ref/heads/$default" --jq .object.sha 2>/dev/null)" || return 2
  gh api "repos/$repo/git/refs" -f ref="refs/heads/epic/$n" -f sha="$sha" >/dev/null 2>&1 ||
    gh api "repos/$repo/git/ref/heads/epic/$n" >/dev/null 2>&1 || return 2
}

# Resolves an issue's integration base for dispatch; prints it, or fails after saying why.
dispatch_base() {
  local name="$1" repo="$2" default="$3" n="$4" target rc
  target="$(integration_base "$repo" "$default" "$n")"
  rc=$?
  case $rc in
    0) echo "$target" ;;
    2)
      needs_help "$n" "could not create the integration branch \`$target\` from \`$default\`."
      return 1
      ;;
    *)
      log "$name #$n: could not read its parent issues; trying again next tick" >&2
      return 1
      ;;
  esac
}

# Claims issue $3 and starts a thread on it; returns 1 when the start failed.
start_thread() {
  local folder="$1" name="$2" n="$3" title="$4" claim="$5" message="$6" err
  shift 6
  gh issue edit "$n" --add-label in-progress >/dev/null
  gh issue comment "$n" --body "$claim" >/dev/null
  if err="$("${t3[@]}" thread start "$folder" "$message" --title "$title" "$@" 2>&1 >/dev/null)"; then
    log "$name #$n dispatched: $title" >&2
  else
    # A failed start is a setup problem, not a vanished worker: say what failed, don't retry it.
    needs_help "$n" "could not start a worker: $(tail -n 3 <<<"$err" | tr '\n' ' ')"
    log "$name #$n could not start a worker: $err" >&2
    return 1
  fi
}

# Starts reviewers for ready-for-review issues, then builders for frontier issues; prints the number started.
dispatch() {
  local folder="$1" name="$2" live="$3" room="$4" repo base reviews frontier n title free blockers started=0 args arg target
  [ "$room" -gt 0 ] || {
    echo 0
    return
  }
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  base="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" || return 1
  reviews="$(gh issue list --label ready-for-review --state open --limit 50 \
    --search "-label:in-progress -label:needs-help -label:ready-for-human sort:created-asc" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"')" || return 1
  while IFS=$'\t' read -r n title; do
    [ -n "$n" ] || continue
    [ "$started" -lt "$room" ] || break
    # A builder that just handed off may still be ending; its thread holds the issue until then.
    grep -qx "$n" <<<"$live" && continue
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and any(.labels[]; .name == "ready-for-review") and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human")) | not)')"
    [ "$free" = true ] || continue
    args=()
    while IFS= read -r arg; do args+=("$arg"); done < <(review_model_args)
    target="$(dispatch_base "$name" "$repo" "$base" "$n")" || continue
    start_thread "$folder" "$name" "$n" "mw-$n review $title" "maestro: claimed review" \
      "Use the \`maestro-reviewer\` skill for issue #$n in $repo.${target:+ Base branch: $target.}" --worktree "$base" ${args[@]+"${args[@]}"} &&
      started=$((started + 1))
  done <<<"$reviews"
  frontier="$(gh issue list --label ready-for-agent --state open --limit 50 \
    --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human -label:ready-for-review sort:created-asc" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"')" || return 1
  while IFS=$'\t' read -r n title; do
    [ -n "$n" ] || continue
    [ "$started" -lt "$room" ] || break
    grep -qx "$n" <<<"$live" && continue
    # Search lags by a few seconds; re-read before claiming.
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human", "ready-for-review")) | not)')"
    [ "$free" = true ] || continue
    # The search's -is:blocked lags behind edges added seconds ago, as when an issue is split.
    blockers="$(gh api "repos/$repo/issues/$n/dependencies/blocked_by" --paginate |
      jq -s '[add // [] | .[] | select(.state == "open")] | length')" || continue
    [ "$blockers" = 0 ] || continue
    target="$(dispatch_base "$name" "$repo" "$base" "$n")" || continue
    start_thread "$folder" "$name" "$n" "mw-$n $title" "maestro: claimed" \
      "Use the \`maestro-worker\` skill for issue #$n in $repo.${target:+ Base branch: $target.}" --worktree "$base" ${model_args[@]+"${model_args[@]}"} &&
      started=$((started + 1))
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

# Closes finished epics (an integration epic gets its PR to the default branch instead) and tells
# the master about needs-help and unblocked human tasks.
report() {
  local name="$1" master="$2" repo key epics n url open_subs total current line integration title pr default
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || return 1
  key="$(state_key)" || return 1

  epics="$(gh issue list --label epic --state open --limit 100 --json number,url,labels,title \
    --jq '.[] | "\(.number)\t\(.url)\t\(any(.labels[]; .name == "integration"))\t\(.title)"')" || return 1
  while IFS=$'\t' read -r n url integration title; do
    [ -n "$n" ] || continue
    read -r total open_subs < <(gh api "repos/$repo/issues/$n/sub_issues" --paginate |
      jq -rs 'add // [] | "\(length) \([.[] | select(.state == "open")] | length)"')
    [ "${total:-0}" -gt 0 ] && [ "${open_subs:-1}" -eq 0 ] || continue
    if [ "$integration" = true ]; then
      # The user merges it; the merge closes the epic. Any PR from the branch, even one the user
      # closed, means this was already reported.
      [ -z "$(gh pr list --head "epic/$n" --state all --json number --jq '.[].number')" ] || continue
      default="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" || continue
      pr="$(gh pr create --base "$default" --head "epic/$n" --title "$title" \
        --body "Closes #$n. Every sub-issue merged into \`epic/$n\`." 2>&1 | tail -n 1)" || {
        log "$name #$n could not open its integration PR: $pr"
        continue
      }
      tell_master "$master" "$name" "#$n epic ready for your merge $pr"
    else
      gh issue close "$n" --comment "maestro: every sub-issue is closed." >/dev/null
      tell_master "$master" "$name" "#$n epic done $url"
    fi
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
    (
      cd "$folder" || exit 1
      stop_stalls "$name" "${lives[$i]}" "$folder"
    ) || log "$name: stall check failed"
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
