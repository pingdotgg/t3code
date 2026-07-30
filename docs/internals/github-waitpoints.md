# Durable GitHub waitpoints

GitHub waitpoints let an agent end its turn while T3 Code watches a pull request in the background.
When the selected condition becomes true, the server queues one continuation into the originating
thread. No agent turn is consumed while the wait is pending.

The provider-agnostic orchestrator MCP toolkit exposes three controls:

- `wait_for_github` registers an idempotent wait for checks to settle, new review activity, or the
  pull request to close.
- `list_github_waits` lists the calling thread's waits.
- `cancel_github_wait` cancels a pending wait.

This implementation deliberately uses the local `gh` authentication already available to the T3
Code server. It does not require T3 Connect or a separately installed GitHub App. The worker polls
with an explicit `--repo owner/name`, so it does not depend on the server process's current
repository.

## Lifecycle

Waitpoints are persisted in `github_waitpoints`. Registration records the originating V2 run and a
baseline PR snapshot. The worker waits for that run to complete before evaluating the condition. It
expires the wait instead of waking the thread when:

- the originating run is interrupted, cancelled, failed, or rolled back;
- a newer run advances the thread before the GitHub condition fires;
- the thread is archived or deleted; or
- the configured deadline elapses.

Once a condition fires, the observed continuation prompt is persisted before delivery. Delivery
uses deterministic V2 command and message IDs, so replaying after an ambiguous server failure is
idempotent.

## Claims and crash recovery

Delivery claims have a random fencing token and an expiry. Every mutation after a claim matches both
the waitpoint ID and fencing token, preventing an expired worker from overwriting a newer worker's
result.

An expired `delivering` claim is recovered from its persisted delivery prompt. Recovery intentionally
does not re-probe GitHub or re-run the "newer thread run" check: the first worker may already have
queued the deterministic command before crashing, and a resulting continuation must not invalidate
its own retry.

## Future webhook transport

The persisted waitpoint and fenced delivery state are independent of how GitHub changes are
detected. A future GitHub App or webhook receiver can mark matching waitpoints due immediately while
retaining the polling worker as a reconciliation fallback. Webhook delivery must verify GitHub
signatures and installation/repository scope before touching waitpoints.
