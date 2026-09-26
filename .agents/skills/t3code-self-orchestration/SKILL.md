---
name: t3code-self-orchestration
description: Delegates independent work from the current T3 Code chat by creating and monitoring helper threads through the authenticated control plane. Use only when the user asks to delegate, spawn, parallelize, or manage helper-thread work; use t3code-thread-review for read-only inspection and t3code-chat-control for ordinary chat lifecycle operations.
---

# T3 Code Self-Orchestration

Delegate work from the current T3 thread through T3's authenticated MCP control plane.

## Core rule

Create one or many helpers with `delegate_work`. It creates each child, records the current thread
as its parent, selects Copilot, sends the first prompt, and optionally creates the child's isolated
worktree. Do not assemble those steps with terminal commands or workspace tools.

`create_nested_thread` and `create_nested_threads` are compatibility tools only. Prefer
`delegate_work` for every new delegation.

## Quick start

If the MCP tool is deferred, you MUST use the tool-search API to load the `delegate_work` function
definition from the `t3-tools` tool resource, then call it. The same interface handles one child
and batches. Do not use MCP resources/list as an availability check: zero non-invokable resources
does not mean the server exposes zero tools. Do not infer that the authenticated `t3-tools` server
lacks the tool from the initially loaded tool list or resource count. Never report a missing tool
unless an actual exact-name search call completed with no definition.

Each child requires only a title and self-contained prompt. Put shared project, model, reasoning,
prompt template, follow-up policy, and dry-run settings in `defaults`; omit project to
use the authenticated parent workspace and omit model to use the settings delegated-thread
default (factory Copilot gpt-6-luna). Use only
model-supported reasoning options. The loaded tool schema is authoritative. Load
[creation-examples.md](references/creation-examples.md) when composing structured prompts or a
batch. Include only needed permissions; never combine investigation-only work with implementation,
commit, or publication permissions.

Every call returns `status`, `threadId`, `retryable`, `workspaceCreated`, `cleanupPerformed`,
`errorCode`, and `message`. A `created` outcome always has a `threadId`. For an `ambiguous`
outcome with a non-null `threadId`, inspect that exact child before retrying; when it is null,
inspect the parent's children and any requested workspace state instead. Retry a failed call only
when `retryable` is true and follow any remediation in `message`.

Inspect each indexed outcome, including a single-child result. Partial success is not a reason to
retry the whole batch. Retry only individual retryable failures. Shared workspace branches or
canonical paths are rejected before mutation; case-only path differences do not establish
independent ownership.

## Delegation workflow

1. Decide whether delegation is worthwhile; keep simple lookups and tightly coupled edits local.
2. Use the authenticated parent workspace by default and the settings delegated-thread model
   (factory Copilot gpt-6-luna) by default; override them only when the
   request requires a specific target.
3. Put the goal and task-specific constraints in each child's `prompt`; put reusable context,
   permissions, validation, delivery, and reporting blocks in `defaults.promptTemplate`.
4. If isolation is needed, include `workspace` on that child in the same `delegate_work` call.
5. Call `delegate_work` once, check each outcome, and capture every non-null `threadId`.
6. Monitor by `threadId` only when needed, then consolidate the result in the parent.

## Workspace ownership

- Parent stays in its current workspace.
- Child without isolation: omit `workspace`.
- Child with isolation: pass `workspace: { mode: "isolated", branch, path, baseRef? }` in its
  child specification; `path` must be absolute.
- `create_isolated_workspace` and `switch_workspace` always move the thread that calls them. Use
  them only when the current thread itself must move, never to prepare a future child.
- Never run raw `git worktree add` or `git worktree move` for T3-managed delegation.
- Never use terminal-based `t3 chat new`; it lacks the authenticated parent and can target the
  wrong app flavor.

## Child prompt contract

Apply [skill-delivery.md](../../references/skill-delivery.md) to the parent request and every child prompt. State investigation-only, implementation, commit, and publication permissions explicitly; omit unauthorized template blocks. Delegation cannot expand the parent's authorization, and "leave uncommitted" or "do not push" must survive into each child's instructions.

Helper prompts must be self-contained:

- Goal and expected output.
- Repository, branch, PR, issue, or file context needed to begin.
- Relevant decisions and constraints from this conversation.
- Whether the helper may edit code or should only investigate.
- Required validation and whether it may commit, push, or update a PR.
- A concise reporting format.
- Structured validation commands, observable scenarios, applicable evidence, and one integrated
  validation owner (`promptTemplate.validation`). An explicit owner is required whenever
  scenarios or evidence are supplied; command-only validation needs no owner.
  Parent-owned browser validation must remain
  pending in child reports; it is not a waiver. Verify the integrated revision and published
  evidence before describing the overall task as verified.

The child cannot see the parent conversation; include every required decision and constraint.

## Monitoring

New MCP-created children have one delegated assignment. T3 automatically reports the returned
result or failure and queues a parent follow-up; no completion-message tool call is needed.
Set `followUp: "notify-only"` when spawning to retain notifications without automatic follow-up.
Existing children and ordinary `send_to_thread` messages do not create new assignments.
Use `assign_to_thread` to give new work to an existing, finished child. Reuse its `requestId`
on retry; creation of the assignment and queue entry is atomic. Only one assignment and one
unresolved decision may be active per child. An answer continues the same assignment, not a new one.

Capture the `assignmentId` returned by creation or assignment, or inspect `t3 chat show <id>`.
`delegate_work` accepts `wait: "all" | "any" | "none"` and installs the wait atomically with child
creation, before any child can report. By default it waits for all when more than one automatic
child is created, and uses no batch wait for one automatic child or notify-only children;
notify-only children are never included. Partial creation failures are removed from the wait
before `delegate_work` returns, so only created assignments remain. Do not call `set_child_wait`
just to establish the wait after delegation.

Use `set_child_wait` with `{mode: "any" | "all", assignments: [{childThreadId, assignmentId}]}`
to revise the selected results later. Use `{mode: "decisions-only", assignments: []}` to suppress
routine wakes, or `null` to restore automatic follow-up. Reassigning a child retargets an
unsettled wait entry to its new assignment; a settled entry remains tied to the assignment that
produced its outcome. Already-queued terminal results remain deliverable after reassignment. A
satisfied wait is consumed once; a failure escalates without pretending the wait succeeded. Legacy
waits whose assignments are unavailable must be revised.

For an early decision or important finding, a child can call `report_to_parent` with
`kind: "decision-needed"` or `"important-update"`, a concise `summary`, and a stable `reportId`.
Reuse that ID on retries. `kind: "progress"` records an update without waking the parent.
Include the original `assignmentId` when reporting, especially from a reused child. A structured
decision includes `decision: {question, options?, recommendation?}` and `canContinue`.
To revise an open decision, pass its full report ID as `supersedesReportId`.
Answer with `send_to_thread` carrying `assignmentId`, `respondToReportId`, and a stable `requestId`;
enqueueing the answer and resolution are recorded atomically. Pending response provenance survives
queue delivery failure; inspect the child queue to retry. Deleting an undelivered response restores
the question. Deleting a queued assignment records an unconfirmed stop. Reading or dismissing a notification
does not resolve its question. Provider approvals remain a separate, explicitly authorized flow.
Do not send acknowledgment-only replies or duplicate T3's automatic result report.

Follow-ups wait for the parent's current turn and approvals/input. Stop pauses automatic child
follow-up durably; use the Child work menu above the composer to resume it, including when the
queue is empty. Routine reports collect for a fixed two seconds; decisions/failures bypass the
collection delay but never active turns, approvals, Stop, or preceding user messages. Results are reports,
not proof of task success or completion of untracked background work: inspect the child evidence.

Use point-in-time commands by child `threadId`:

```sh
t3 chat list --parent <threadId>
t3 chat show <threadId> --messages
t3 diff thread <threadId>
t3 checkpoint list <threadId>
t3 approval list --thread <threadId>
t3 input list --thread <threadId>
```

`t3 chat stream` is persistent and does not exit when a turn completes. Do not use it as an
attached completion waiter. Use approval/input skills only with the user's authorization.

## Review follow-ups

When the parent reviews a child's result and finds fixes within that child's original scope and
permissions, send them to the child immediately; do not ask the user for confirmation first.
Report what was sent and the queued ID afterwards. Ask only when a fix would widen the child's
permissions or scope, or when the right fix is a genuine product decision.

Make each follow-up self-contained: the PR or branch, the head SHA reviewed, each issue with
file references and evidence, the required tests, validation, and the delivery boundary. Use
`assign_to_thread` with a stable `requestId` when the child's assignment is finished and idle.
If it is rejected because the child is busy (an active turn, queued work, or an automatic
PR-monitor turn), use `send_to_thread` with a stable `requestId` instead; that message is not a
tracked assignment, so it produces no automatic completion report.

## Failure handling

- Tool returns a `threadId`: creation committed; use that child for all follow-up.
- Tool fails without a `threadId`: report the error. If the response says creation may have
  committed or a child worktree was preserved, inspect the parent's children before retrying.
- Copilot reports `Missing namespace for function_call` or says the conversation cannot continue:
  do not retry in that parent. Its Copilot history is poisoned. Start a fresh controlling thread,
  inspect whether a child was created, and delegate from there.
- Never assume a failed response means no child or worktree exists when the outcome is ambiguous.

## Safety

Report facts, changes, blockers, open questions, and child IDs needed for follow-up.

Keep destructive operations in the parent unless explicitly delegated. Never delegate credentials.
Stop or interrupt a child only when requested or obsolete; report failures plainly.
