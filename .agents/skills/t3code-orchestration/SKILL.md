---
name: t3code-orchestration
description: >-
  Coordinate supervised background agents in T3 Code using delegate_task,
  child threads, completion wakes, questions, and cancellation. Use for explicit
  T3 orchestration, cross-provider work, isolated child checkouts, or supervised
  parallel work that spans turns. Independent top-level thread handoffs belong
  to t3code-threads; ordinary in-turn native subagents keep T3's normal routing.
license: MIT
---

# T3 Code orchestration

Coordinate through T3's MCP tools so the user can inspect each delegate in its
child thread. The server owns task state and completion delivery. Follow the
running server's instructions and tool schemas if they differ from this guide.
Try tools by name before declaring them absent; report unavailable capabilities
instead of switching to Orca, another provider, or a standalone agent CLI.

## Establish ownership

- **Coordinator:** own decomposition, dependency order, integration, and the
  final report. Use `delegate_task` for T3-managed background work, a separate
  checkout, another provider, or when the user asks for it by name. Ordinary
  same-provider helpers that finish in this turn keep T3's native routing.
- **Child:** do the assigned task yourself. Start helpers only if the task
  explicitly permits them. The child receives only `task`, not the parent's
  conversation. End with an evidence-backed result for the parent.
- **Handoff:** a user-requested independent thread belongs to `t3_thread_launch`,
  not delegation. Do not create top-level threads merely to parallelize work.

T3 has no Orca Run/Dispatch inbox, heartbeat, `worker_done`, delivery ack, or
task-DAG/gate commands. Do not invent them. Keep a short task/dependency ledger
in the coordinator's conversation, using the task and thread IDs T3 returns.
The runtime tracks liveness and wakes; a child's final response is its report.

## Prepare a complete brief

Call `orchestrator_capabilities` once in this thread before the first delegation.
Repeat after an error or a user-named provider change. Omit `target` to inherit;
when a provider or model is requested, select its advertised IDs and pass model
settings in `target.options`. Report an unavailable requested model instead of
silently replacing it. Omit mode overrides unless requested; they cannot exceed
the caller's permissions. A narrower runtime mode is not a read-only guarantee.

For each child, put these facts in `task`:

- The concrete outcome, necessary background, relevant files, and constraints.
- The checkout/commit it will see and any upstream result it needs.
- Its file ownership; whether it may edit, commit, push, or open a PR under the
  user's actual authorization. A review brief must explicitly require no edits.
- Acceptance checks and the final report: outcome, findings or changes, files,
  test commands/results, blockers, and commit/PR references when applicable.
- Whether nested delegation is permitted. Omit it when unnecessary.

Use `isolation:"shared"` for read-only research or disjoint edits in the parent's
checkout. Assign one writer per file. Use `isolation:"worktree"` when a child
needs a separate checkout or PR. T3 creates it from the parent's **HEAD commit**;
uncommitted edits stay out. Do not create the child's worktree in the shell or
ask the child to create one. Integrate prerequisite changes before launching a
dependent isolated task, without committing or merging beyond authorization.

## Dispatch independent work together

Start the ready independent wave before waiting. Keep real dependencies in the
ledger and launch dependents only after their inputs are available. For example,
call `delegate_task` separately for each independent task:

```json
{
  "title": "Review upload retry handling",
  "role": "review",
  "task": "Review src/upload.ts and its tests in this checkout for retry bugs. Read only: do not edit, commit, or delegate. Return severity, file/line evidence, missing checks, and a verdict.",
  "isolation": "shared",
  "mode": "async",
  "clientRequestId": "upload-review-1"
}
```

Use a distinct `clientRequestId` per intended operation and retain it for retries
of that same request. Keep returned `taskId`, `childThreadId`, `childRunId`, and
`link`. After a lost reply, retry the same request key rather than launching a
second writer. A new task or review round needs a new key.

`mode:"async"` lets the coordinator continue independent work. `mode:"wait"`
is for a result needed in this turn; questions, approvals, or a timeout can end
the wait while the child is still unfinished.

## Resume on evidence

1. Follow a running task's `next`: complete independent work, then end the turn
   so T3 can wake it. This is an interim checkpoint, not a final completion
   report. Do not poll `task_status`, sleep, install watchers, or schedule checks
   while waiting for that wake.
2. On a completion wake, use `task_status` on the recorded `taskId` to consume
   its result. Read a child's messages or activity with bounded
   `t3_thread_read` calls when its summary needs evidence. Reading a final result
   marks it delivered.
3. A finished turn is not enough: `workState:"waiting_for_children"` or
   `hasPendingChildRuns:true` means descendant work remains. Accept a result only
   when `workState:"result_available"` and no pending child runs remain; inspect
   its terminal status and summary. Failed, cancelled, and interrupted are
   explicit outcomes, not successful implementations.
4. For `hasPendingQuestion`, use `t3_pending_request` to list/read questions on
   `childThreadId`, then `respond` with answers supported by the brief or user.
   Escalate genuine user decisions. `pendingApproval` requires the user;
   answering a question cannot grant tool approval or broader permissions.
5. `t3_thread_send` can steer an existing implementation child with a correction;
   sending to a finished child starts fresh work and returns a new `taskId` to
   track. Every delegated review or re-check uses a **new `delegate_task`**,
   including the brief, prior findings, changes, and objections. Do not send
   another review round to the old child thread.

## Integrate and close

Validate the actual changes and relevant checks before marking each ledger item
complete. A child summary is evidence to inspect, not proof of a merge or test.
Isolated worktrees do not merge automatically, and context transfer does not
integrate Git changes. Keep blocked dependencies blocked until their inputs are
actually present. Fix small review findings yourself; do not add a delegate just
for those fixes.

Use `task_cancel` for delegates that are replaced, no longer needed, or explicitly
cancelled. It also stops descendant and queued work; never use
`t3_thread_interrupt` on a delegate instead. `cancel_requested` is not proof of
completed cancellation. A timeout or connection loss is not proof that a task
stopped and does not justify a duplicate editor. Preserve worktrees and branches.

In the final report, name each task's observed outcome, the evidence checked,
integration state, and unresolved blockers. Use returned thread links verbatim;
without one, use `[title](t3-thread://v1/<exact childThreadId>)`. Do not claim the
overall goal is complete while tracked work or required integration remains.

Adapted from [Orca's orchestration skill](https://github.com/stablyai/orca/tree/main/skills/orchestration)
to T3 Code's task lifecycle. See [LICENSE](LICENSE).
