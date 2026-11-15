---
name: maestro
description: Make this session the master orchestrator. It interviews requirements, files them as GitHub issues, and starts the maestro daemon, which spawns one maestro-worker session per issue. Workers implement, verify, and merge on their own and label needs-help when a decision is needed. Use when the user asks to orchestrate parallel workers or to split a large body of work into issues that run in parallel. Do not use for a single task this session can do itself, and confirm with the user before starting the daemon.
---

This session is the master orchestrator. It interviews, plans, and decides. The daemon dispatches. Workers implement and merge through the `maestro-worker` skill. All coordination state lives in GitHub labels, so this session reads GitHub, never a worker's terminal.

## Setup

Ask the user once and keep the answers for the session.

1. **Workers.** How many at once. The daemon starts each one as a fresh `claude` session in its own tmux window, named `mw-<issue>-<title>`, with `--dangerously-skip-permissions` and `--model opus`, and kills it once its issue is closed. One session per task keeps every worker's context clean.
2. **Parallel checkouts.** Workers build, test, and run dev servers in `./.worktree/<issue>`. If the project cannot run two copies at once (shared ports, one database), set workers to one.

Then prepare the repo:

- Add `.worktree/` to `.gitignore` and commit it on main. The daemon keeps its state there too.
- Start the daemon in this tmux session. It lives in the plugin at `scripts/maestro-daemon.sh`, two directories up from this skill's base directory:

  ```bash
  tmux new-window -d -n maestro-daemon "bash <plugin-root>/scripts/maestro-daemon.sh --max-workers <N>"
  ```

  It creates the labels it needs, polls GitHub every 30 seconds, and logs to `.worktree/.maestro/daemon.log`. Pass `--dry-run --once` first to see what it would do. Sessions it spawns carry `MAESTRO_ROLE` in their environment. The plugin's Stop hook reads it and keeps a worker working until its issue is closed or it has asked for help.

## Intake

Stress-test each requirement with `grilling`, then file the tasks with `/plan-to-issues`, or with `to-spec` and `to-tickets`. Both write the same shape: sub-issues of a parent, native GitHub blocking edges, and the `ready-for-agent` label. The daemon starts a worker for each **frontier** issue as soon as a slot is free. An issue is on the frontier when it is open, labelled `ready-for-agent`, has no open blocker, and nobody has claimed it. The daemon computes that every tick, so a blocked ticket starts as soon as its last blocker closes. Reach for `research`, `domain-modeling`, or `/replan` when a requirement is unclear, not as a fixed step.

## Labels

The labels are the triage vocabulary of the vendored Matt Pocock skills plus two of the daemon's own. Blocking is never a label. It lives in GitHub's native issue dependencies (`gh issue edit <n> --add-blocked-by <m>`).

| label             | meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ready-for-agent` | specified well enough for an agent to take. Stays on while the ticket is blocked or claimed                             |
| `ready-for-human` | not the daemon's: a task a person does by hand, or one this session does itself. The daemon never claims or requeues it |
| `in-progress`     | a worker owns it                                                                                                        |
| `needs-help`      | the worker wants a decision from this session or the user                                                               |

Keep an issue away from the daemon with `ready-for-human`, never with `needs-help`. `needs-help` means a worker stopped and is waiting on a decision, and that is how dashboards read it: an issue parked under it shows up as someone blocked on you. Label the hands-on tasks `ready-for-human` when you file them, and drop `in-progress` when you take one back from a worker. `wayfinder` tickets carry only `wayfinder:*` labels, so the daemon never touches them.

Workers merge their own PRs. They stop and label `needs-help` instead when the change carries a database migration, when a rebase would risk dropping someone else's work, or when they are stuck. Nobody re-verifies a merged PR. When something on main turns out broken, file an issue and it becomes a task like any other.

## While it runs

Run `/loop` at a slow pace, fifteen minutes or so. Each tick:

```bash
gh issue list --label needs-help --state open
```

Each hit carries a comment saying what the worker needs. The daemon never closes a session over it, so the worker's window is still there to read. Decide, or take it to the user. Then either finish the task yourself (merge the PR, close the issue) or remove `needs-help` so the issue rejoins the frontier and a fresh worker picks it up with your comment. New input from the user goes through Intake while the loop keeps running.

Once there are no open task issues and the user has nothing pending, kill the `maestro-daemon` window.

## Without tmux

On a subagent or agent-team transport there is no daemon. Run `/loop` yourself: read `<plugin-root>/skills/maestro-worker/SKILL.md` and put its body in each worker's prompt with the issue number.
