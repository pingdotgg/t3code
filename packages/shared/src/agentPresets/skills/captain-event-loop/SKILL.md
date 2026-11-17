---
name: captain-event-loop
description: "Captain's event loop for named children: arm one v2 listener per child (it follows background continuations and reports a question or approval within about a minute), sweep every child on every wake, answer approvals, take the next pipeline step, and never end a turn with a child unwatched. Read at the start of every Captain turn that launches, messages or checks a child, and after a PR merges."
---

# Captain event loop

## Why this exists

Since Ada nightly 20261016, a named child never wakes its parent on run end, idle or stop. These events do start an idle Captain turn:

1. a message from the user;
2. a **profile-less `delegate_task` helper reaching any terminal state** (one batched "Delegated tasks … reached terminal states" message);
3. `watch_pull_request` events;
4. "Child thread … has a question": an interactive question in a child;
5. a background command Captain started finishing.

These do **not** wake Captain:

- **A command approval in a child.** This happens even under `full-access`: Claude Code's own "Dangerous rm … command substitution" check still prompts. `t3_pending_request list` returns `{}` for it, and `t3_thread_wait` with `returnOnQuestion` does not return. Only `t3_get_pending_questions` (`data.status: "waiting-approval"`), `t3_thread_read` (`pendingRequestCount`, an `approval_request` item with status `waiting`) and `t3_get_agents_view executionState=waiting-approval` show it.
- **A child continuing by itself.** A child that ends its turn with a background command registered through `t3_background_wait` is resumed by Ada in a **new run** when the command finishes. A listener tied to the old runId returns "completed" too early, so the child looks stopped while it is still working.

So every running child needs the v2 listener below. It follows new runs and checks for approvals once a minute.

## Launching and messaging children

- Start named children with `t3_thread_launch` (or `create_threads`) so they get a task and show in the sweep. Avoid `delegate_task` with a `profileId`.
- Send follow-ups with `t3_thread_send`.
- Every brief ends with: _"End each turn with a short summary. Put any question on the last line as `BLOCKED: <question> (default: <your pick>)`. Do not use interactive question tools and do not message Captain. For a long wait (CI, a remote build, a helper), start it in the background, register it with `t3_background_wait`, and keep working or end your turn: Ada resumes you when it finishes. Do not write a final summary until that work is done. Never pass `rm` a `$(...)` target: use a literal path or a quoted variable (`d=$(mktemp -d); rm -rf "$d"`)."_
- Do not tell a child to "block in the foreground". Foreground `sleep` is blocked by the Claude Code harness, so the child cannot comply and ends its turn anyway.

### Children on another machine

`t3_thread_wait`, `t3_thread_send`, `t3_thread_read` and the `t3_task_read` sweep take `environmentId`. If a call returns `thread_not_found`, fall back to `t3_get_thread` / `t3_get_messages` / `t3_send_message` with `environmentId`. Record each remote child's `environmentId` in PIPELINE.md and pass it to the listener (add `environmentId` to every tool call in the template).

## Arm: one v2 listener per child

Arm one immediately after a launch, a `t3_thread_send`, answering a question, approving an action, or a resume. Never leave two listeners on one child.

Every listener runs on Claude Haiku 5.5 (the target below), whichever provider Captain runs on. Never use Sonnet, Opus, Codex models or Captain's own inherited model. If Haiku is unavailable, tell the user rather than falling back. When the project has a deterministic background watcher script, it may replace the listener; it must return on a question, a pending approval or a real end of the child's run.

```
delegate_task {
  title: "listen <child short name>",
  mode: "async",
  target: { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] },
  clientRequestId: "listen:<childThreadId>:<n>",
  task: "You are an event listener for Ada thread \"<childThreadId>\". Use only the t3-code tools named here (load them with ToolSearch first). Never message anyone, never read or write files.

Repeat this loop, at most 240 rounds:
A. Call t3_thread_wait with threadId (above), timeoutMs 60000, returnOnQuestion true, untilDelegatedWorkSettled true, untilBackgroundWorkEnds true. Pass no runId.
B. If the result has hasPendingQuestion true: reply `INPUT <pendingRequestId>` and stop.
C. If timedOut is true: call t3_get_pending_questions with the threadId. If data.status is \"waiting-approval\" or \"waiting-input\": reply `<data.status in capitals>` and stop. Otherwise go to A.
D. If timedOut is false: call t3_thread_read with threadId, view \"messages\", limit 1, maxCharsPerItem 300, runLimit 1. If thread.activeRunId is present, the child started another run (a background task or helper woke it): go to A. Otherwise reply `ENDED <thread.status>: <the last assistant message text>` and stop.
On a tool error, retry that call once; on a second error reply `ERROR <exact text>`. After round 240 reply `REARM still running`."
}
```

The listener stays quiet through a child's turn end while background work is pending, and returns `WAITING-APPROVAL` within about a minute of an approval prompt. Record the listener's `taskId` against the child in the pipeline table. A wake means "look", not "the child stopped". The sweep decides.

## Wake: sweep everything, then act

1. **Sweep once:** `t3_task_read` with no `threadId`, then `task_status` for each listener named in the wake. If the user mentions input requests, or a listener reports `ERROR`, also run `t3_get_agents_view` with `executionState: "waiting-approval"`, then with `"waiting-input"`.
2. **Handle every changed child:**
   - **`WAITING-APPROVAL`:** read the child's last activity (`t3_thread_read` view `activity`, the last ~6 items) to see the `approval_request` and the command it guards. Derive `approvalRequestId` from the item's `itemId`: strip the `turn-item:runtime-request:` prefix and URL-decode the rest **once**. Approve with `t3_respond_to_approval` (`decision: "accept"`, a fresh `idempotencyKey`, and `confirmDestructive: true` when the API asks for it) if the command is routine work inside the child's worktree or temp dirs. Decline it, and tell the child why with `t3_thread_send`, if it touches anything outside that scope or anything on the "ask the user" list. Re-arm the listener.
   - **`INPUT` / `WAITING-INPUT`:** `t3_pending_request` `read`, then `respond` using the defaults rule. Escalate to the user only for "ask the user" items. Re-arm.
   - **`ENDED`:** if the last line holds a deliverable, verify it and start the next pipeline step. If it is `BLOCKED:`, decide it and reply with `t3_thread_send`. If it is a "waiting on X" line with no summary, check `t3_thread_read` for `activeRunId` before sending anything: a resumed run means the child is fine, so just re-arm. Re-arm after any send.
   - **interrupted / failed / stopped:** resume once with `t3_thread_send` ("continue from where you stopped; re-check uncommitted work first"), re-arm, and report to the user if it stops again.
   - **running with no live listener:** arm one. **`REARM`:** arm a fresh one.
3. **End-of-turn invariant:** every running child has exactly one live listener, every idle child has its next step started or is waiting on the user for a listed decision, and nothing is waiting on Captain. Never sleep, poll, schedule checks or send "status?" messages yourself.

## Time-limited human steps (sign-in links, 2FA, codes)

A link that expires in minutes must reach the user in one hop, while they are likely to be there.

- Before launching work that needs a cloud or SSO session, check that session yourself as the project's AGENTS.md says (for AWS, `aws sts get-caller-identity` with the project's profile). If it is missing or near expiry, do the sign-in with the user **first**, then launch the child.
- When a child reports a sign-in link or code, relay it in your very next message, together with what to paste back, and send `PushNotification` (one line, under 200 characters) so the user sees it away from the screen. If a link has expired, regenerate it yourself before asking the user again.

## Pipeline table

Keep the job's table in `.t3/captain/<job>/PIPELINE.md`: child id | role | step | done means | next step | listener taskId | last state seen. Update it before acting on an instruction from the user that changes the plan.

## Defaults instead of blocking on the user

Decide reversible and routine choices yourself (order, naming, splitting PRs, resuming, approving routine in-scope commands, merging each PR as soon as the repo's PR skill allows), and list them under "Defaults taken". CI checks still apply, but they run locally through the repo's verification skill and nothing is rerun remotely. Never wait for a staging-deploy check before merging. Ask the user only about production deploys or releases, architecture exceptions, product decisions they have not made, destructive data operations, spending, and outward-facing actions they have not approved.

## After a PR merges

Clean up the task's worktree as the repo's AGENTS.md says first, then follow the worktree-cleanup-rule skill. Cleanup is the last pipeline step before the task is done; include it in implementation briefs.

## Reboots and Ada updates

A reboot kills children and listeners. Sweep on the first wake, resume interrupted children and re-arm. After any Ada update, recheck: whether `returnOnQuestion` now covers approvals, whether `t3_pending_request list` lists approvals, and what `untilDelegatedWorkSettled` waits for. If any has changed, simplify the listener.

## Cost

One Haiku helper per child, making about 2 small tool calls a minute while the child runs (wait + pending check). That is an estimated 0.1–0.3 USD per child-hour of cache reads, against Opus wakes that are never needed for a quiet child. Do not arm listeners for idle or settled children, and settle finished children promptly.
