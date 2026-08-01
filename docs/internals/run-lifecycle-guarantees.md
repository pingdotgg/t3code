# Run lifecycle guarantees

State-management bugs in orchestration share one root cause: a persisted status
that claims something ("this run is working") with no mechanism forcing the
claim to stay true. This document describes the three mechanisms that make the
worst classes of those bugs unrepresentable rather than merely recoverable.

The invariant they enforce together:

> Every non-terminal run is either owned by live work (a valid lease), covered
> by durable queued work (an unsettled outbox effect), or on a bounded clock
> toward terminalization. Every terminal run stays terminal.

## 1. The transition gate

`orchestration-v2/RunLifecycle.ts` is the single source of truth for which
status transitions are legal. `EventSink` validates every status-bearing event
(`run.created/updated`, `run-attempt.created/updated`, `node.updated`) inside
the commit transaction, folding statuses through the batch, and rejects the
whole commit on an illegal transition (`EventSinkIllegalTransitionError`).

The policy is deliberately minimal:

- Same-status rewrites and unknown rows are always legal.
- Non-terminal → anything is legal; sequencing is the deciders' business.
- Terminal is absorbing for runs (except checkpoint rollback retiring a
  completed run to `rolled_back`) and absolutely absorbing for attempts.
- Nodes may retire to `rolled_back`; `subagent` and `root_turn` node kinds are
  exempt entirely because providers deliberately reopen settled tasks (Claude
  `task_started` resume, Codex collab turn restarts).
- Subagent rows are not gated for the same reason; their cleanup guarantee is
  the run cascade plus the janitor.

Migration 045 installs matching SQLite triggers on the projection tables as a
storage-level backstop, so even direct SQL cannot resurrect a terminal run.
Projection rebuilds flip `orchestration_v2_projection_guard` to `replay` inside
the rebuild transaction, because historical logs may contain sequences written
before the gate existed.

## 2. Liveness leases

A persisted `running` status is a claim that some fiber is driving the run.
`orchestration-v2/RunLeaseService.ts` makes the claim falsifiable: the
provider-event ingestion fiber (and the thread-launch preparation fiber) holds
a row in `orchestration_v2_run_leases` and renews it while alive. The renewal
fiber is scoped to the work, so it dies with its owner on any exit path — the
lease then expires on its own. No code has to remember to clear anything.

Timings come from `RunLeaseTimingsRef` (ttl 30s, renew 10s, sweep 15s, grace
90s) and can be overridden with `PIKU_ORCH_RUN_LEASE_TTL_MS`,
`PIKU_ORCH_RUN_LEASE_RENEW_MS`, `PIKU_ORCH_RUN_JANITOR_INTERVAL_MS`,
`PIKU_ORCH_RUN_JANITOR_GRACE_MS`.

## 3. The janitor

`orchestration-v2/RunJanitorService.ts` runs continuously (started right after
boot recovery, which remains the sweep's synchronous first tick). Each tick it:

1. Settles expired effect-outbox leases. A claimed effect whose worker hung or
   died stops wedging its thread's queue: replay-safe effects requeue (bounded
   by the worker's max attempts), process-bound effects fail. Claim tokens
   (`worker#attempt`) stop an abandoned claimer from settling a row that was
   reclaimed. Override the effect lease with `PIKU_ORCH_EFFECT_LEASE_MS`.
2. Terminalizes orphaned runs: non-terminal runs in threads with no valid
   lease, no unsettled effects, and no recent event activity are cancelled
   with the same cascade the boot sweep uses ("Cancelled because no live
   process owned this work."), without touching live idle provider sessions.

The thread-level sparing rules protect queued runs sequenced behind a leased
sibling and fresh runs whose execution has not acquired its lease yet.

## Thread shell status

The sidebar's "working" label derives from the shell's status run. That run is
the live one (lowest-ordinal non-terminal), not simply the newest row — a
cancelled queued run (for example after promoting a queued message to a steer)
must never outrank the turn that is actually running, and its stale
`requestedAt` must not anchor the "Working for…" timer.

## What this does not solve

Hung-but-alive work renews its lease and is invisible to the janitor — that is
interrupt/timeout territory, not liveness. And the gate enforces the encoded
policy faithfully, including its mistakes: transition-policy changes belong in
`RunLifecycle.ts` with tests, nowhere else.
