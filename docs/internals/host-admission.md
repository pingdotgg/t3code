# Host admission

The server decides whether a new run may leave `queued`. Admission is per environment and global across threads, because the thing it protects, the host, is shared by all of them. [`HostAdmission`](../../apps/server/src/orchestration-v2/HostAdmission.ts) owns the decision; `dispatchMessage` and `startNextQueuedRun` in the orchestrator consult it, so every entry point (composer, scheduled tasks, delegated children, wakes, restart continuations) is covered by one rule. A denial queues the run with `admissionWait` and never fails a command.

## Why a global lock and a pump

Dispatch is serialized per thread only, so two threads could both take the last slot. `decide` counts and reserves under one global semaphore. The lock order is always the thread lock first, then the admission lock. The pump takes thread locks one at a time and never holds the admission lock across a thread lock.

Nothing else restarts queued runs in other threads: `handleRunUpdate` only restarts the thread whose run ended. The pump does that. It runs when a run changes status, a `t3_thread_wait` starts or ends, host-capacity settings change, memory pressure changes, or the pacing timer fires. One indexed query (`getHostAdmissionSnapshot`) returns the live runs and the waiting runs, and the pump starts the oldest first until one is denied. A missed trigger leaves runs queued forever, so add a trigger for any new reason a slot can free.

## Traps

- A slot is reserved when `decide` admits, but the run only counts in the projection once its events commit. `scopedReservations` holds the reservation until the enclosing dispatch finishes, so a concurrent decision cannot miss it.
- Deferred-start runs (thread launch, pipeline steps) are `preparing` while their workspace is made, and count as running. They are admitted at `prepared-run.release`, when the provider turn is about to start, and requeue there if the host is full. Gating at creation would skip workspace preparation.
- `queued-run.start` is the only bypass, and only clients reach it. The MCP queue tool has no start action.
- Startup recovery must not mark admission-queued runs `queueHeld`; a held queue is only released by a user.
- Pressure is sampled only while pacing is on, because [#27253](https://github.com/pingdotgg/t3code/pull/27253)'s stream samples only while someone listens.
