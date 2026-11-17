---
name: maestro
description: Orchestrate parallel workers from GitHub issues inside T3 Code. The master (the user's thread) interviews requirements and files them as issues. A dedicated maestro thread dispatches one maestro-worker child per frontier issue. Workers ship through full-send (validate, review, merge) on their own, and label needs-help when a decision is needed. Use when the user asks to orchestrate parallel workers or to split a large body of work into issues that run in parallel, or when a thread is told to run as the maestro dispatcher. Do not use for a single task this session can do itself.
---

Two roles, two threads. GitHub labels and native blocked-by edges are the only queue state, so the queue moves without the two threads talking.

- **Master**: the user's thread. It does intake, answers questions, and decides on `needs-help`. It never watches the queue.
- **Maestro**: one long-lived top-level thread per repo, titled `maestro <owner/repo>`. Its only job is dispatch.

If this thread was started with "run as the maestro dispatcher", skip to [Dispatcher](#dispatcher). Otherwise you are the master.

## Master

### Start the maestro

Ask the user once, as a structured question if your harness offers one: how many workers at once (default 2; use 1 if the project cannot run two dev stacks, for shared ports or one database), and confirm before starting. Check `t3_thread_list` for an existing `maestro <owner/repo>` thread first and nudge it instead of starting a second. Otherwise start it with `t3_thread_launch` (or ask the user to create the thread by hand) on the project root, titled `maestro <owner/repo>`, with this message:

```
Use the `maestro` skill and run as the maestro dispatcher for <owner/repo>. Master thread: <master thread id>. Max workers: <N>.
```

### Intake

Issues that arrive without triage labels (filed by hand or from outside) go through the `triage-issues` skill first.

Stress-test each requirement with `grilling`, then file tasks with `plan-to-issues`, or with `to-spec` and `to-tickets`. Plan very large work with `wayfinder` first. All of them write sub-issues of a parent, native blocking edges (`gh issue edit <n> --add-blocked-by <m>`), and `ready-for-agent`. Reach for `research`, `domain-modeling`, or `replan` when a requirement is unclear, not as a fixed step. After filing, send the maestro one line with `t3_thread_send`: `dispatch now`.

To run an issue on another provider, label it `provider:<instanceId>`, for example `provider:grok`.

### needs-help

The maestro sends you three kinds of line. `#<n> ready-for-human unblocked <issue url>` means a task for you or the user can start now. `#<n> epic done <url>` means a whole epic shipped: offer the user the `retro` skill on it. For a `#<n> needs-help: <reason> <issue url>` line, the issue carries a comment saying what is needed. Decide, or ask the user. When the decision belongs to someone else, turn it into a questionnaire for them with the `to-questionnaire` skill. When what is needed is a manual step (a credential, a dashboard setting, a CI secret), generate a `wizard` script for the user instead. Then either finish the task yourself (merge the PR, close the issue, and close its `epic` if that was the last open sub-issue), or comment your decision and remove `needs-help` so the issue rejoins the frontier and a fresh worker picks it up. Nudge the maestro afterwards. When several of these lines arrived since the user's last message, answer their next message with the `ketchup` skill.

## Labels

Blocking is never a label. It lives in GitHub's native issue dependencies.

| label                 | meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `ready-for-agent`     | specified well enough for an agent to take. Stays on while the ticket is blocked or claimed               |
| `ready-for-human`     | not the maestro's: a task a person does by hand, or one the master does itself. Never claimed or requeued |
| `in-progress`         | a worker owns it                                                                                          |
| `needs-help`          | a worker or the maestro wants a decision from the master or the user                                      |
| `provider:<instance>` | optional: dispatch this issue's worker on that provider instance instead of the maestro's own             |

Keep an issue away from the maestro with `ready-for-human`, never with `needs-help`. `needs-help` means someone is blocked on you. Drop `in-progress` when you take a task back from a worker. `wayfinder` tickets carry only `wayfinder:*` labels, so the maestro never touches them.

Workers merge their own PRs. Nobody re-verifies a merged PR. When something on main turns out broken, file an issue and it becomes a task like any other.

## Dispatcher

Runs only in the maestro thread. There are no loops and no sleeps: each tick runs once and the turn ends. Spend as few tokens as you can: a tick with nothing to reap, requeue, dispatch or report ends with no message at all. A tick runs when:

- the thread starts or the master nudges it;
- a worker finishes, which wakes this thread with `Delegated task <id> (<title>) [completed|failed|...]: <result>`;
- the heartbeat fires.

### First tick

1. Create the labels: `for l in ready-for-agent ready-for-human in-progress needs-help task epic; do gh label create "$l" --force --color ededed; done`
2. Call `orchestrator_capabilities` once.
3. Find your own thread id: `t3_thread_list` with `titleContains: "maestro <owner/repo>"`.
4. Rebuild the worker map `taskId → {issue, childThreadId, nudges}` from open `in-progress` issues and your running child threads titled `mw-<n> …` (`t3_thread_list` with `includeSubagents`). An `in-progress` issue whose last claim comment is `maestro: claimed` and that has no running child is an orphan; other `in-progress` issues belong to another session, so leave them alone. With `needs-help` too, its worker asked for help before this thread restarted: remove `in-progress` and notify the master (below). Otherwise treat it under Requeue.
5. Reuse a `maestro tick` heartbeat from `list_scheduled_tasks` if one exists. Otherwise create it: `schedule_task` with `bindToCurrentThread: true`, `freshSession: true`, `schedule: {type: "interval", everyMs: 300000}`, prompt `maestro tick`. A fresh session per heartbeat reads only this skill and GitHub, not the thread's whole history; such a tick starts by redoing steps 3 and 4, since its worker map is gone. Keep its `scheduledTaskId`.

### Each tick

**1. Reap.** For a finished worker, read the issue: `gh issue view <n> --json state,labels,url`.

- Closed: done. Drop it from the map.
- Open with `needs-help`: done. Remove `in-progress` and notify the master (below).
- Open without `needs-help`, task `completed`: the worker quit early. `t3_thread_send` its child thread: `#<n> is still open. Finish it with the full-send skill, as maestro-worker says. If it needs a decision, label it needs-help with a comment.` The send starts a new task in the same context; record its `taskId`. After 3 nudges for the same issue, label it `needs-help` yourself (below) instead.
- Open without `needs-help`, task `failed`, `interrupted` or `cancelled`: the worker vanished. Requeue.

**2. Requeue.** An open orphan without `needs-help` or `ready-for-human` gets one retry. If the issue has no `maestro: requeued` comment, comment `maestro: requeued after the worker ended without finishing.` and `gh issue edit <n> --remove-label in-progress`. If it already has one, label it `needs-help` with `worker disappeared twice without finishing.`

**3. Dispatch** while fewer than N workers run:

```bash
gh issue list --label ready-for-agent --state open --limit 50 \
  --search "-is:blocked -label:in-progress -label:needs-help -label:ready-for-human sort:created-asc" \
  --json number,title,labels
```

Search lags by a few seconds, so re-check each one before claiming:

```bash
gh issue view <n> --json state,labels \
  --jq '.state == "OPEN" and (any(.labels[]; .name == "in-progress" or .name == "needs-help" or .name == "ready-for-human") | not)'
```

On `true`, `gh issue edit <n> --add-label in-progress` and `gh issue comment <n> --body "maestro: claimed"`, then delegate to a subagent (in T3 Code: `delegate_task`) with `isolation: "worktree"`, `mode: "async"`, `role: "implementation"`, `title: "mw-<n> <short title>"`, and the task:

```
Use the `maestro-worker` skill for issue #<n> in <owner/repo>. Maestro thread: <your thread id>.
```

Name the skill; never paste its body. Use your own provider and model unless the issue has a `provider:<instanceId>` label, then set `target.providerInstanceId` to it. If that instance is not in `orchestrator_capabilities`, label `needs-help` with the reason.

**4. Epics.** Close an open `epic` whose sub-issues are all closed: `gh issue close <n> --comment "maestro: every sub-issue is closed."`, and tell the master in one line, `#<n> epic done <url>`, so it can offer the user a `retro` of that run.

**5. Human tasks.** When an open `ready-for-human` issue has just become unblocked, send the master one line, once: `#<n> ready-for-human unblocked <issue url>`.

**6. Heartbeat.** Pause it (`schedule_task` with the id and `enabled: false`) when the frontier is empty, no worker runs, and no open issue is `needs-help` or blocked by an open issue, since finishing either can refill the frontier without anyone nudging you; re-enable it on the next nudge. Delete it with `delete_scheduled_task` when no `ready-for-agent` issue is left open, then end.

### Labelling needs-help

```bash
gh issue edit <n> --add-label needs-help --remove-label in-progress
gh issue comment <n> --body "maestro: needs help. <reason>"
```

Every time an issue gains `needs-help`, from a worker or from you, `t3_thread_send` the master exactly one line, once per occurrence: `#<n> needs-help: <reason> <issue url>`. Default `mode: "auto"` queues it if the master is busy. Besides these, send the master only the `ready-for-human unblocked` line from step 5 and the `epic done` line from step 4.
