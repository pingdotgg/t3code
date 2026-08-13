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
- Shell resume sends deltas plus compact repository-enrichment metadata, not another full project
  and thread snapshot.
- Known idle sends and interrupts do not fetch a full thread projection before dispatch.

When changing projection schemas, paging, shell synchronization, or thread state, run this command
alongside the focused package typechecks and a real-client pass on every affected surface. Payload
budgets belong in these tests rather than logs or one-off recordings so regressions fail locally.
