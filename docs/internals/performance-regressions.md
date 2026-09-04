# Performance regression checks

The v2 transport has a focused regression command:

```bash
vp run test:perf:v2-wire
```

It exercises the real v2 projection and client reducers. This matters because the older
built-app benchmark fixtures seed v1 orchestration events; running those fixtures against a v2
client can produce reassuring timings while missing the active transport path.

The v2 checks pin these invariants:

- Client cold opens use a recent timeline window capped at 75 rows and about 1 MiB of encoded
  timeline data.
- The bounded snapshot does not retain the full duplicate conversation-message table.
- Older activity is fetched in bounded HTTP pages and merged without disturbing the live scroll
  window.
- Resume catch-up replays at most 128 thread events and 1 MiB of projected event JSON before
  replacing stale state with a current snapshot.
- Oversized dynamic-tool results and detail strings are reduced only at the wire boundary; the
  persisted event remains complete.
- The initial shell contains active navigation rows only. Archived rows use the dedicated archive
  query, and transcript message bodies stay in thread detail regardless of message size.
- Shell resume sends deltas plus compact repository-enrichment metadata, not another full project
  and thread snapshot.
- Known idle sends and interrupts do not fetch a full thread projection before dispatch.

When changing projection schemas, paging, shell synchronization, or thread state, run this command
alongside the focused package typechecks and a real-client pass on every affected surface. Payload
budgets belong in these tests rather than logs or one-off recordings so regressions fail locally.

## Event store and startup

Sequence cursors must seek an index rather than scan retained history. The application sequence
index contains project events and v2 thread events; the per-thread sequence index contains only v2
thread events. Legacy-only and unknown threads must return zero without scanning other threads.
Catch-up queries keep sequence ranges and optional thread or command predicates indexable.

Startup selects recovery candidates from current projection state before reading full thread
projections. Candidate selection includes queued runs, pending runtime requests, live provider
sessions, background work, and unfinished delegated deliveries. Archived threads still participate
where recovery requires them. Completed thread history is not loaded merely to discover that no
work remains.

Projection verification decodes canonical rows in bounded pages, including shared provider records
and fork ancestry. Rebuild replays event pages through a fixed sequence within its transaction;
it must not collect the entire event log before projecting it.

The focused regression coverage lives in `OrchestrationEventStore.sequence.test.ts`,
`ProjectionRecovery.test.ts`, and the provider runtime recovery tests under `apps/server/src`.
