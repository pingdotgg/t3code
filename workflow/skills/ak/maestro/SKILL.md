---
name: maestro
description: Orchestrate parallel workers from GitHub issues inside T3 Code. The master (the user's thread) interviews requirements and files them as issues. A dispatcher, either the server's `queue.sh` daemon or a dedicated maestro thread, starts a maestro-worker to build each frontier issue into a PR, then a different agent, a maestro-reviewer, to validate, review and merge it behind a `maestro/verify` status. Workers decide reversible calls themselves and log them, retry with a fresh agent when stuck, and label needs-help only for product calls, irreversible steps and migrations. Use when the user asks to orchestrate parallel workers or to split a large body of work into issues that run in parallel, or when a thread is told to run as the maestro dispatcher. Do not use for a single task this session can do itself.
---

Two roles, plus the workers they start. GitHub labels and native blocked-by edges are the only queue state, so the queue moves without the two talking.

- **Master**: the user's thread. It does intake, answers questions, and decides on `needs-help`. It never watches the queue.
- **Maestro**: the dispatcher, in one of two forms:
  - **Daemon** (preferred where it runs): `queue.sh` beside this file, run by the T3 Code server as a daemon (Settings > Daemons). One per server covers every opted-in project, uses no model, and never stops.
  - **Thread**: one long-lived top-level thread per repo, titled `maestro <owner/repo>`, following [Dispatcher](#dispatcher). Use it where no daemon can run, or when a repo needs per-issue judgment the script lacks, such as `provider:<instance>` labels.

  Never run both for the same repo.

Each issue gets two workers in turn, never at once. A **builder** (`maestro-worker`) implements and proves it, opens the PR, and swaps `in-progress` for `ready-for-review`. A **reviewer** (`maestro-reviewer`), a fresh agent that did not write the code, runs `review-change` and `sol-loop`, fixes what they find, posts `maestro/verify`, checks main and merges.

The factory runs unattended. Product direction comes from the master up front, at intake; workers then decide everything reversible themselves, as [Decide or escalate](#decide-or-escalate) says, and the master reviews those decisions afterwards instead of being asked mid-run.

If this thread was started with "run as the maestro dispatcher", skip to [Dispatcher](#dispatcher). Otherwise you are the master.

## Master

### Start the maestro

First look for a dispatcher already covering this repo: `t3 daemon list` for a `maestro queue` daemon whose command lists this project folder, and `t3_thread_list` for a `maestro <owner/repo>` thread. With a daemon, there is nothing to start: file the issues and it picks them up on its next tick. With a thread, nudge it instead of starting a second.

Otherwise ask the user once, as a structured question if your harness offers one: daemon or thread, how many workers at once (default 2; use 1 if the project cannot run two dev stacks, for shared ports or one database), and confirm before starting.

**Daemon.** The command lists each project folder, optionally followed by `=<master thread id>` so the daemon sends that thread the lines under [needs-help](#needs-help). Give one wherever you can: without it, those lines only reach the daemon's log, so nobody hears that the queue stopped. One daemon per server: when a `maestro queue` daemon exists, add this folder to its command with `t3 daemon add --id <id> --name "maestro queue" --command "<new command>"` instead of adding a second.

```bash
t3 daemon add --name "maestro queue" --cwd "<project folder>" \
  --command "MAESTRO_MAX_WORKERS=<N> <this skill's folder>/queue.sh --loop <project folder>=<master thread id>"
```

`t3` here is this server's own CLI. If the `t3` on PATH is an older release (no `daemon` command), use `node "$T3CODE_SOURCE_CHECKOUT/apps/server/dist/bin.mjs"` instead. The project needs a default model, or set `MAESTRO_PROVIDER` and `MAESTRO_MODEL` in the command. `MAESTRO_REVIEW_MODELS` lists models a review may run on, as `provider/model` separated by spaces, and each review picks one at random; list the builders' model too to keep it in the draw. Without it, reviews run on the builders' model. `MAESTRO_STALL_MINUTES` (60) sets when a quiet worker counts as stalled and is stopped, and `MAESTRO_RETRIES` (2) how many fresh attempts follow a failed one. Settings > Daemons shows its terminal; each tick logs what it did.

**Thread.** Start it with `t3_thread_launch` (or ask the user to create the thread by hand) on the project root, titled `maestro <owner/repo>`, with this message:

```
Use the `maestro` skill and run as the maestro dispatcher for <owner/repo>. Master thread: <master thread id>. Max workers: <N>.
```

### Intake

Issues that arrive without triage labels (filed by hand or from outside) go through the `triage-issues` skill first.

Stress-test each requirement with `grilling`, then file tasks with `plan-to-issues`, or with `to-spec` and `to-tickets`. Plan very large work with `wayfinder` first. All of them write sub-issues of a parent, native blocking edges (`gh issue edit <n> --add-blocked-by <m>`), and `ready-for-agent`, in that order: the label goes on last, after every edge exists, or a dispatcher can claim a task whose blocker is not linked yet. Reach for `research`, `domain-modeling`, or `replan` when a requirement is unclear, not as a fixed step. After filing, a maestro thread needs one line with `t3_thread_send`: `dispatch now`. A daemon needs nothing.

To run an issue on another provider, label it `provider:<instanceId>`, for example `provider:grok`. Only the maestro thread reads that label; the daemon starts every worker on its own model.

### needs-help

The maestro sends you four kinds of line, and a daemon two more (at the end of this section). `#<n> ready-for-human unblocked <issue url>` means a task for you or the user can start now. `#<n> epic done <url>` means a whole epic shipped. Give the user its decision digest: every `maestro: decided` comment on the epic's sub-issues (`gh api repos/<owner/repo>/issues/<n>/sub_issues --paginate --jq '.[].number'`, then each issue's comments), one line per decision with its issue link and the alternative it names, through the `ketchup` skill. A decision the user disagrees with becomes a new issue; nothing is reverted by hand. Then offer the `retro` skill on the epic, and run `automate-me` in update mode over the epic's threads, so the user's mode skill learns from the run; show the user the proposed change before it lands. With no mode skill yet, offer to create one. `#<n> epic ready for your merge <pr url>` means an [integration epic](#integration-epics) finished: give the same digest, offer `full-stop` for a last pass over the whole branch, and leave the merge to the user. For a `#<n> needs-help: <reason> <issue url>` line, the issue carries a comment saying what is needed. Decide, or ask the user. When the decision belongs to someone else, turn it into a questionnaire for them with the `to-questionnaire` skill. When what is needed is a manual step (a credential, a dashboard setting, a CI secret), give the user a numbered checklist of exactly what to do, with the links, the values to enter, and how to confirm each step worked. Then either finish the task yourself (merge the PR, close the issue, and close its `epic` if that was the last open sub-issue), or comment your decision and remove `needs-help` so the issue rejoins the frontier and a fresh worker picks it up. Its earlier `maestro: retry` comments still count, so one more failure brings it straight back. Nudge a maestro thread afterwards; a daemon notices on its next tick. A daemon also sends `maestro queue for <project> can't move: ...` when no worker runs and no open `ready-for-agent` issue can start, with a count per reason (blocked, needs-help, ready-for-human, in-progress with no worker), and `maestro queue for <project>: the last <k> ticks in a row failed ...` when it cannot read GitHub or T3; each comes once per new state. Clear what the first names; for the second, read the daemon's log in Settings > Daemons. When several of these lines arrived since the user's last message, answer their next message with the `ketchup` skill.

## Labels

Blocking is never a label. It lives in GitHub's native issue dependencies.

| label                 | meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `ready-for-agent`     | specified well enough for an agent to take. Stays on while the ticket is blocked or claimed               |
| `ready-for-human`     | not the maestro's: a task a person does by hand, or one the master does itself. Never claimed or requeued |
| `ready-for-review`    | the builder opened the PR; a reviewer takes it next. The builder removes `in-progress` as it adds this    |
| `in-progress`         | a worker owns it, builder or reviewer                                                                     |
| `needs-help`          | a decision only a person can make (see Decide or escalate), or every attempt failed                       |
| `provider:<instance>` | optional: dispatch this issue's worker on that provider instance instead of the maestro's own             |
| `mistake-log`         | the one issue where reviewers log each mistake class they catch; never claimed or dispatched              |
| `integration`         | on an `epic`: its sub-issues merge into `epic/<n>`, and the user merges one PR to main (below)            |

Keep an issue away from the maestro with `ready-for-human`, or by removing `ready-for-agent`, never with `needs-help`. There is no `hold` label. `needs-help` means someone is blocked on you. Drop `in-progress` when you take a task back from a worker. `wayfinder` tickets carry only `wayfinder:*` labels, so the maestro never touches them.

Reviewers merge, and only on a `maestro/verify` commit status of `success` on the PR's current head; any later push needs a new one. The builder never merges. Nobody re-verifies a merged PR. When something on main turns out broken, file an issue and it becomes a task like any other.

## Decide or escalate

Workers, builder and reviewer alike, follow this wherever a skill they run would ask the user.

**Escalate** with `needs-help` only for:

- **A product call** the issue, its parent, the codebase and the docs leave open: what users should see or be able to do, where the options differ for them and nothing points one way. Two behaviors a rebase cannot keep together count.
- **An irreversible step:** production data or the live install (`~/.t3`), credentials and secrets, a message to anyone outside the run, a force-push to any branch but `task/<n>`, or closing someone else's PR.
- **A database migration about to merge into the default branch.** The reviewer stops before the merge; it runs on the user's real database at the next update. Into an integration branch it merges as usual, since the user merges that branch.
- **Something only a person can do**, such as an account or a dashboard setting. File it as a `ready-for-human` issue blocking this one.

**Decide** everything else. Pick what the issue, its parent and the codebase's precedent support best, then comment on the issue and carry on:

```
maestro: decided <what you chose>. Why: <the evidence>. Alternative: <the other option, and what switching would take>.
```

A vague spec gets the most reasonable reading; more than one PR's worth gets split; a conflict gets both sides' behavior kept and proven by tests. These comments are the master's digest when the epic ships.

**Give up** when you are stuck after a real attempt: push `task/<n>`, comment `maestro: retry: <what you tried, what failed, what the next attempt should try>`, leave `in-progress` on, and end. The dispatcher hands the issue to a fresh worker, which starts from your branch and comments. After 2 fresh attempts fail too (`MAESTRO_RETRIES`), it labels `needs-help`.

## Shared notes

A sub-issue's siblings work the same code. Before exploring, read the parent's `maestro: notes` comments. When you learn something a sibling would need (where the code lives, a convention, a trap, the command that proves it), add one `maestro: notes` comment on the parent: short, with file paths, and nothing an earlier note already says.

## Integration epics

Label an epic `integration` at intake when its tickets cannot each land green on main (`to-tickets`' wide refactors that share a branch), or when the user wants the whole epic in one PR they merge. Then:

- Before dispatching its first sub-issue, the dispatcher creates `epic/<n>` from the default branch, and every worker's task names it: `Base branch: epic/<n>.`
- Builders branch from it and open their PR against it. Reviewers merge into it, then close the sub-issue themselves, since GitHub closes issues only from merges into the default branch.
- When every sub-issue is closed, the dispatcher opens a PR from `epic/<n>` to the default branch that closes the epic, and sends the master `#<n> epic ready for your merge <pr url>` instead of closing the epic.

## Dispatcher

This section is for the maestro thread. The daemon does the same retry, stall, dispatch, epic and master-notice steps in `queue.sh`, minus nudges, `provider:` labels and the heartbeat; it stops a stalled thread with `t3 thread stop`. A worker it cannot start gets `needs-help` with the start error instead of a requeue. Unlike step 4 of the first tick, it requeues every `in-progress` issue that no live `mw-<n>` thread holds, whoever claimed it; a claim it did not make (no `maestro: claimed` comment since the label was last added) goes back to the queue without costing an attempt. A worker whose run ended `cancelled` or `failed`, as when the T3 server restarts or the provider process exits, gets a `maestro: infra` comment and a fresh worker without costing an attempt, until 5 such deaths in a row label `needs-help`.

Runs only in the maestro thread. There are no loops and no sleeps: each tick runs once and the turn ends. Spend as few tokens as you can: a tick with nothing to reap, requeue, dispatch or report ends with no message at all. A tick runs when:

- the thread starts or the master nudges it;
- a worker finishes, which wakes this thread with `Delegated task <id> (<title>) [completed|failed|...]: <result>`;
- the heartbeat fires.

### First tick

1. Create the labels: `for l in ready-for-agent ready-for-review ready-for-human in-progress needs-help task epic; do gh label create "$l" --force --color ededed; done`
2. Call `orchestrator_capabilities` once.
3. Find your own thread id: `t3_thread_list` with `titleContains: "maestro <owner/repo>"`.
4. Rebuild the worker map `taskId → {issue, childThreadId, nudges}` from open `in-progress` issues and your running child threads titled `mw-<n> …` (`t3_thread_list` with `includeSubagents`). An `in-progress` issue whose last claim comment is `maestro: claimed` or `maestro: claimed review` and that has no running child is an orphan; other `in-progress` issues belong to another session, so leave them alone. With `needs-help` too, its worker asked for help before this thread restarted: remove `in-progress` and notify the master (below). Otherwise treat it under Retry.
5. Reuse a `maestro tick` heartbeat from `list_scheduled_tasks` if one exists. Otherwise create it: `schedule_task` with `bindToCurrentThread: true`, `freshSession: true`, `schedule: {type: "interval", everyMs: 300000}`, prompt `maestro tick`. A fresh session per heartbeat reads only this skill and GitHub, not the thread's whole history; such a tick starts by redoing steps 3 and 4, since its worker map is gone. Keep its `scheduledTaskId`.

### Each tick

**1. Reap.** For a finished worker, read the issue: `gh issue view <n> --json state,labels,url`.

- Closed: done. Drop it from the map.
- Open with `needs-help`: done. Remove `in-progress` and notify the master (below).
- Open with `ready-for-review` and without `in-progress`: the builder handed off. Drop it from the map; Dispatch picks the review up.
- Open without `needs-help`, task `completed`, and a `maestro: retry` comment after the last claim: the worker gave up. Retry.
- Open without `needs-help`, task `completed`, no such comment: the worker quit early. `t3_thread_send` its child thread: `#<n> is still open. Finish your part as your skill says, or give up with a maestro: retry comment.` The send starts a new task in the same context; record its `taskId`. After 3 nudges for the same issue, retry it instead.
- Open without `needs-help`, task `failed`, `interrupted` or `cancelled`: the worker vanished. Retry.

**2. Retry.** An orphan, or a worker from step 1 that needs a retry, gets a fresh worker. Each failed attempt leaves one `maestro: retry` comment: when no such comment follows the last `maestro: claimed` comment, add `maestro: retry: the worker ended without finishing or leaving a report.` Then count the `maestro: retry` comments after the last `maestro: handed off` comment (all of them when there is none), so the review phase gets its own budget. Up to 2, `gh issue edit <n> --remove-label in-progress`, which sends it back to the queue it came from: review when it carries `ready-for-review`, build otherwise. Over 2, label it `needs-help` with `<k> attempts failed; each maestro: retry comment says what it tried.`

**3. Stalls.** For each running worker, find its issue's last sign of life: the latest of the issue's `updatedAt`, the last commit on `task/<n>` (`gh api repos/<owner/repo>/branches/task/<n> --jq .commit.commit.committer.date`), and its PR's `updatedAt`. Older than 60 minutes: stop it with `task_cancel` on its `taskId`, comment `maestro: retry: the worker made no push, comment or label change for 60 minutes, so the maestro stopped it.`, and retry it (step 2) once the cancel lands.

**4. Dispatch** while fewer than N workers run, reviews first, since they are closest to done. Never dispatch an issue whose last child is still running, even when its labels say it is free, such as a builder that just handed off.

```bash
gh issue list --label ready-for-review --state open --limit 50 \
  --search "-label:in-progress -label:needs-help -label:ready-for-human sort:created-asc" \
  --json number,title,labels
gh issue list --label ready-for-agent --state open --limit 50 \
  --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human -label:ready-for-review sort:created-asc" \
  --json number,title,labels
```

Search lags by a few seconds, so re-check each one before claiming:

```bash
gh issue view <n> --json state,labels \
  --jq '.state == "OPEN" and (any(.labels[]; .name == "in-progress" or .name == "needs-help" or .name == "ready-for-human") | not)'
```

Then skip a build if it has an open blocker, since the search's `-is:blocked` lags behind edges added seconds ago: `gh api repos/<owner/repo>/issues/<n>/dependencies/blocked_by --jq '[.[] | select(.state == "open")] | length'` must be `0`.

On `true` and no open blocker, `gh issue edit <n> --add-label in-progress` and comment `maestro: claimed` for a build or `maestro: claimed review` for a review. Then delegate to a subagent (in T3 Code: `delegate_task`) with `isolation: "worktree"`, `mode: "async"`, `role: "implementation"`, `title: "mw-<n> <short title>"` (`mw-<n> review <short title>` for a review), and the task:

```
Use the `maestro-worker` skill for issue #<n> in <owner/repo>. Maestro thread: <your thread id>.
```

When the issue's parent is an `integration` epic, create `epic/<parent>` from the default branch if it is missing (`gh api repos/<owner/repo>/git/refs -f ref=refs/heads/epic/<parent> -f sha=<default branch head>`) and append `Base branch: epic/<parent>.` to the task.

For a review, name `maestro-reviewer` instead. Name the skill; never paste its body. A build runs on your own provider and model unless the issue has a `provider:<instanceId>` label, then set `target.providerInstanceId` to it. A review runs on a provider picked at random from those `orchestrator_capabilities` reports ready, yours included, on that provider's default model. If a named instance is not in `orchestrator_capabilities`, label `needs-help` with the reason.

**5. Epics.** Close an open `epic` whose sub-issues are all closed: `gh issue close <n> --comment "maestro: every sub-issue is closed."`, and tell the master in one line, `#<n> epic done <url>`, so it can offer the user a `retro` of that run. An `integration` epic instead gets a PR from `epic/<n>` to the default branch with `Closes #<n>` in its body, unless one is already open, and the master gets `#<n> epic ready for your merge <pr url>`.

**6. Human tasks.** When an open `ready-for-human` issue has just become unblocked, send the master one line, once: `#<n> ready-for-human unblocked <issue url>`.

**7. Heartbeat.** Pause it (`schedule_task` with the id and `enabled: false`) when the frontier is empty, no worker runs, and no open issue is `needs-help` or blocked by an open issue, since finishing either can refill the frontier without anyone nudging you; re-enable it on the next nudge. Delete it with `delete_scheduled_task` when no `ready-for-agent` or `ready-for-review` issue is left open, then end.

### Labelling needs-help

```bash
gh issue edit <n> --add-label needs-help --remove-label in-progress
gh issue comment <n> --body "maestro: needs help. <reason>"
```

Every time an issue gains `needs-help`, from a worker or from you, `t3_thread_send` the master exactly one line, once per occurrence: `#<n> needs-help: <reason> <issue url>`. Default `mode: "auto"` queues it if the master is busy. Besides these, send the master only the `ready-for-human unblocked` line from step 6 and the `epic done` line from step 5.
