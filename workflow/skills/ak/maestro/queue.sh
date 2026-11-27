#!/usr/bin/env bash
# The maestro dispatcher without a model. Each tick, per project: requeue in-progress issues no
# live worker thread holds (a fresh worker each time, MAESTRO_RETRIES times; a claim it did not make,
# or a worker its server or provider took down, costs no attempt), stop workers that stalled, start
# a maestro-reviewer thread per ready-for-review issue and a maestro-worker thread per frontier issue
# while fewer than MAESTRO_MAX_WORKERS threads run across all listed projects, close finished epics,
# and tell the project's master thread about needs-help, epic done, unblocked human tasks, a queue
# that cannot move, and ticks that keep failing.
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
# Workers in a row that die with their server or provider before the issue gets needs-help, so a
# crash loop stops instead of starting workers forever.
infra_retries=5
# A claim younger than this may not have its comment or thread yet (another dispatcher mid-claim).
claim_grace=300
# Failed ticks in a row before the master hears of it: five minutes at the default interval, past a
# server restart or a GitHub blip, well before an outage costs an hour.
fail_ticks=5
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

# `<issue> <status>` per worker thread of a project, newest first, with every live status shown as
# `live`. The `mw-<n> ` title prefix is also how the web sidebar files them under Workers
# (sidebar/sidebarWorkers.ts).
worker_threads() {
  "${t3[@]}" thread list --project "$1" --json | jq -r --argjson live "$live_statuses" '.[]
    | select(.title | test("^mw-[0-9]+ "))
    | "\(.title | capture("^mw-(?<n>[0-9]+) ").n) \(if (.status as $s | $live | index($s)) then "live" else .status end)"'
}

# Open issues a live worker could hold, for a project whose threads could not be listed: a worker
# holds in-progress from before its thread starts until it hands off, and a builder that just
# handed off (ready-for-review) may still be ending.
held_issues() {
  gh issue list --state open --limit 100 --search "label:in-progress,ready-for-review" --json number --jq length
}

# `<ours> <report> <failed> <infra>` from an issue's comments JSON and when in-progress was last added.
# ours: a `maestro: claimed` comment follows that label, as start_thread writes it. report: the
# `maestro: retry` or `maestro: infra` comment after the last claim, or none. failed: retry comments
# since the last handoff, so a reviewer gets its own budget. infra: infra comments since then and
# since the last retry, so only deaths in a row count.
attempt_facts() {
  jq -r --arg since "$2" '[.comments[] | {b: .body, t: .createdAt}] as $c
    | def last_of(p): [$c | to_entries[] | select(.value.b | p) | .key] | max // -1;
    last_of(startswith("maestro: claimed")) as $claim
    | last_of(startswith("maestro: handed off")) as $handoff
    | last_of(startswith("maestro: retry")) as $retry
    | ([$c | to_entries[] | select(.key > $claim) | .value.b
        | if startswith("maestro: infra") then "infra" elif startswith("maestro: retry") then "retry" else empty end]
        | last // "none") as $report
    | "\($claim >= 0 and $c[$claim].t >= $since) \($report)"
      + " \([$c | to_entries[] | select(.key > $handoff and (.value.b | startswith("maestro: retry")))] | length)"
      + " \([$c | to_entries[] | select(.key > ([$handoff, $retry] | max) and (.value.b | startswith("maestro: infra")))] | length)"' <<<"$1"
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
  "${t3[@]}" thread send "$master" "$line" >/dev/null && return 0
  log "$name: could not message the master; trying again next tick"
  return 1
}

# An in-progress issue no live worker thread holds goes back to its queue, until MAESTRO_RETRIES
# attempts after the first have failed; each failed attempt leaves one retry comment. A claim this
# dispatcher did not make is dropped for free. So is a worker whose run ended cancelled or failed:
# that is how the server records a run its restart or a provider process exit cut off, while a worker
# that ends on its own completes, and `t3 thread stop` (a stall stop, or a person) interrupts.
requeue() {
  local name="$1" threads="$2" claimed n labels labelled comments facts ours report failed infra status age
  claimed="$(gh issue list --label in-progress --state open --limit 100 --json number,labels \
    --jq '.[] | "\(.number) \([.labels[].name] | join(","))"')" || return 1
  while read -r n labels; do
    [ -n "$n" ] || continue
    grep -qx "$n live" <<<"$threads" && continue
    [[ ",$labels," == *",ready-for-human,"* ]] && continue
    if [[ ",$labels," == *",needs-help,"* ]]; then
      gh issue edit "$n" --remove-label in-progress >/dev/null && log "$name #$n needs help; dropped in-progress"
      continue
    fi
    if ! labelled="$(gh api "repos/{owner}/{repo}/issues/$n/events" --paginate \
      --jq '.[] | select(.event == "labeled" and .label.name == "in-progress") | .created_at' | tail -n 1)" ||
      ! comments="$(gh issue view "$n" --json comments)" ||
      ! facts="$(attempt_facts "$comments" "$labelled")"; then
      log "$name #$n: could not read its comments or labels; trying again next tick"
      continue
    fi
    if [ -n "$labelled" ]; then
      age="$(jq -rn --arg t "$labelled" 'now - ($t | fromdateiso8601) | floor')" || continue
      [ "$age" -ge "$claim_grace" ] || continue
    fi
    read -r ours report failed infra <<<"$facts"
    if [ "$ours" != true ]; then
      gh issue edit "$n" --remove-label in-progress >/dev/null || {
        log "$name #$n: could not drop in-progress; trying again next tick"
        continue
      }
      gh issue comment "$n" --body "maestro: dropped a claim this dispatcher did not make and no live worker holds; it does not count as a failed attempt." >/dev/null
      log "$name #$n dropped a claim it did not make"
      continue
    fi
    if [ "$report" = none ]; then
      status="$(awk -v n="$n" '$1 == n { print $2; exit }' <<<"$threads")"
      if [ "$status" = cancelled ] || [ "$status" = failed ]; then
        gh issue comment "$n" --body "maestro: infra: the worker's run ended \`$status\`, as when the T3 server restarts or the provider process exits, so the attempt does not count." >/dev/null || {
          log "$name #$n: could not comment; trying again next tick"
          continue
        }
        report=infra infra=$((infra + 1))
      else
        gh issue comment "$n" --body "maestro: retry: the worker ended without finishing or leaving a report." >/dev/null || {
          log "$name #$n: could not comment; trying again next tick"
          continue
        }
        report=retry failed=$((failed + 1))
      fi
    fi
    if [ "$report" = infra ] && [ "$infra" -gt "$infra_retries" ]; then
      needs_help "$n" "$infra workers in a row died with their T3 server or provider; each \`maestro: infra\` comment names how the run ended."
    elif [ "$report" = retry ] && [ "$failed" -gt "$retries" ]; then
      needs_help "$n" "$failed attempts failed; each \`maestro: retry\` comment says what it tried."
    else
      gh issue edit "$n" --remove-label in-progress >/dev/null &&
        log "$name #$n retried ($failed failed, $infra infrastructure deaths in a row)"
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
    last="$(printf '%s\n' "$last" "$branch" "$prs" | grep . | sort | tail -n 1)"
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
  local repo="$1" default="$2" n="$3" parent sha epic integration
  for _ in 1 2 3 4 5; do
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
  if ! gh issue edit "$n" --add-label in-progress >/dev/null; then
    log "$name #$n could not be claimed; trying again next tick" >&2
    return 1
  fi
  # Without its comment the claim is not ours (see requeue), so it is undone. If the undo fails too,
  # requeue drops it as a claim this dispatcher did not make.
  if ! gh issue comment "$n" --body "$claim" >/dev/null; then
    gh issue edit "$n" --remove-label in-progress >/dev/null
    log "$name #$n could not be claimed; trying again next tick" >&2
    return 1
  fi
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
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and any(.labels[]; .name == "ready-for-review") and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human")) | not)')" || {
      log "$name #$n: could not read its labels; trying again next tick" >&2
      continue
    }
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
    free="$(gh issue view "$n" --json state,labels --jq '.state == "OPEN" and (any(.labels[]; .name | IN("in-progress", "needs-help", "ready-for-human", "ready-for-review")) | not)')" || {
      log "$name #$n: could not read its labels; trying again next tick" >&2
      continue
    }
    [ "$free" = true ] || continue
    # The search's -is:blocked lags behind edges added seconds ago, as when an issue is split.
    blockers="$(gh api "repos/$repo/issues/$n/dependencies/blocked_by" --paginate |
      jq -s '[add // [] | .[] | select(.state == "open")] | length')" || {
      log "$name #$n: could not read its blockers; trying again next tick" >&2
      continue
    }
    [ "$blockers" = 0 ] || continue
    target="$(dispatch_base "$name" "$repo" "$base" "$n")" || continue
    start_thread "$folder" "$name" "$n" "mw-$n $title" "maestro: claimed" \
      "Use the \`maestro-worker\` skill for issue #$n in $repo.${target:+ Base branch: $target.}" --worktree "$base" ${model_args[@]+"${model_args[@]}"} &&
      started=$((started + 1))
  done <<<"$frontier"
  echo "$started"
}

# Lines in $2 (current) not yet in state file $1, which keeps only lines still current. The caller
# appends a line once its notice went out, so a failed send is tried again next tick.
unsent() {
  local file="$1" current
  current="$(sort -u <<<"$2" | grep .)"
  comm -12 <(sort -u "$file" 2>/dev/null) <(printf '%s\n' "$current" | grep .) >"$file.tmp"
  mv "$file.tmp" "$file"
  comm -13 "$file" <(printf '%s\n' "$current" | grep .)
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
  current="$(unsent "$key.needs-help" "$current")"
  while read -r n url; do
    [ -n "$n" ] || continue
    line="$(gh issue view "$n" --json comments --jq '[.comments[].body | select(startswith("maestro: needs help."))] | last // "see the issue." | sub("^maestro: needs help. "; "")')"
    tell_master "$master" "$name" "#$n needs-help: ${line:-see the issue.} $url" && echo "$n $url" >>"$key.needs-help"
  done <<<"$current"

  current="$(unblocked_human_issues)" || return 1
  current="$(unsent "$key.ready-for-human" "$current")"
  while read -r n url; do
    [ -n "$n" ] || continue
    tell_master "$master" "$name" "#$n ready-for-human unblocked $url" && echo "$n $url" >>"$key.ready-for-human"
  done <<<"$current"
}

# Why the open ready-for-agent issues cannot start, as `<count> <reason>, ...`; empty when none is open.
stuck_reasons() {
  local open blocked n labels
  open="$(gh issue list --label ready-for-agent --state open --limit 100 --json number,labels \
    --jq '.[] | "\(.number) \([.labels[].name] | join(","))"')" || return 1
  [ -n "$open" ] || return 0
  blocked="$(gh issue list --label ready-for-agent --state open --limit 100 --search "is:blocked" \
    --json number --jq '.[].number')" || return 1
  while read -r n labels; do
    if [[ ",$labels," == *",needs-help,"* ]]; then
      echo "needs-help"
    elif [[ ",$labels," == *",ready-for-human,"* ]]; then
      echo "ready-for-human"
    elif [[ ",$labels," == *",in-progress,"* ]]; then
      echo "in-progress with no worker"
    elif grep -qx "$n" <<<"$blocked"; then
      echo "blocked"
    else
      echo "failed to start (see the daemon log)"
    fi
  done <<<"$open" | sort | uniq -c | sed 's/^ *//' | paste -sd, - | sed 's/,/, /g'
}

# With no worker running and none started though there was room ($3 = true), tells the master once
# per distinct reason why the project's ready-for-agent issues cannot start.
report_stuck() {
  local name="$1" master="$2" idle="$3" key reasons
  key="$(state_key)" || return 1
  reasons=""
  if [ "$idle" = true ]; then
    reasons="$(stuck_reasons)" || return 1
  fi
  if [ -z "$reasons" ]; then
    rm -f "$key.stuck"
    return 0
  fi
  [ "$reasons" = "$(cat "$key.stuck" 2>/dev/null)" ] && return 0
  tell_master "$master" "$name" "maestro queue for $name can't move: no worker is running and no open ready-for-agent issue can start: $reasons." &&
    echo "$reasons" >"$key.stuck"
}

fails=()
fail_told=()

# Counts a project's failed tick; the master hears once when fail_ticks fail in a row.
tick_failed() {
  local i="$1" name="$2" why="$3"
  fails[i]=$((${fails[$i]:-0} + 1))
  [ "${fails[$i]}" -ge "$fail_ticks" ] && [ -z "${fail_told[$i]:-}" ] || return 0
  tell_master "${masters[$i]}" "$name" "maestro queue for $name: the last ${fails[$i]} ticks in a row failed, most recently: $why. Settings > Daemons shows its log." &&
    fail_told[i]=1
}

tick() {
  local folder name threads running=0 lives=() threads_of=() skip=() i held started why idle
  for i in "${!projects[@]}"; do
    folder="${projects[$i]}"
    if ! threads="$(worker_threads "$folder")"; then
      # Skipped this tick. Its workers still count against the cap: every issue one could hold.
      held="$(cd "$folder" && held_issues)" || held="$max"
      log "$folder: could not list threads; skipping it this tick and counting $held workers for it"
      skip[i]=1
      running=$((running + held))
      continue
    fi
    threads_of[i]="$threads"
    lives[i]="$(awk '$2 == "live" { print $1 }' <<<"$threads" | sort -u)"
    running=$((running + $(grep -c . <<<"${lives[$i]}")))
  done
  for i in "${!projects[@]}"; do
    folder="${projects[$i]}"
    name="$(basename "$folder")"
    if [ -n "${skip[$i]:-}" ]; then
      tick_failed "$i" "$name" "could not list its threads"
      continue
    fi
    why=""
    (
      cd "$folder" || exit 1
      requeue "$name" "${threads_of[$i]}"
    ) || why="requeue failed"
    (
      cd "$folder" || exit 1
      stop_stalls "$name" "${lives[$i]}" "$folder"
    ) || why="stall check failed"
    idle=false
    if started="$(cd "$folder" && dispatch "$folder" "$name" "${lives[$i]}" $((max - running)))"; then
      [ -z "${lives[$i]}" ] && [ "$started" -eq 0 ] && [ $((max - running)) -gt 0 ] && idle=true
    else
      why="dispatch failed"
      started=0
    fi
    running=$((running + started))
    (
      cd "$folder" || exit 1
      report "$name" "${masters[$i]}"
    ) || why="report failed"
    (
      cd "$folder" || exit 1
      report_stuck "$name" "${masters[$i]}" "$idle"
    ) || why="stuck check failed"
    if [ -n "$why" ]; then
      log "$name: $why"
      tick_failed "$i" "$name" "$why"
    else
      fails[i]=0
      fail_told[i]=""
    fi
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
