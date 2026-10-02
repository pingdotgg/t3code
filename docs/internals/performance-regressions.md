# Performance regression checks

The v2 transport has a focused regression command:

```bash
vp run test:perf:v2-wire
```

It exercises the real v2 projection and client reducers. This matters because the older
built-app benchmark fixtures seed v1 orchestration events; running those fixtures against a v2
client can produce reassuring timings while missing the active transport path.

The v2 checks pin these invariants:

- Client cold opens target 75 recent timeline rows and about 1 MiB of encoded data. Required
  control records and the at-least-one-row rule can exceed the byte target; it is not a hard cap.
- The bounded snapshot does not retain the full duplicate conversation-message table.
- Older activity is fetched in bounded HTTP pages and merged without disturbing the live scroll
  window.
- Clients with confirmed history paging opt into socket snapshot fallbacks that use the same
  bounded recent-history window and carry the cursor needed to fetch older history. Older clients
  and WebSocket-only starts retain the compatible full-snapshot fallback.
- Snapshot queries bound timeline reads per fork ancestor, not total rows: dependency and
  control records still accompany the window. Smaller socket frames alone do not establish a
  whole-server memory reduction.
- Resume catch-up checks the original 1 MiB persisted-payload budget before decoding, then
  replays at most 128 thread events and 1 MiB of projected event JSON before falling back to a
  snapshot. Raw JSON bytes are not a heap-memory cap. Raising this budget merely because output
  projects small can increase server allocations on repeated large tool updates.
- Raw command output, dynamic-tool result bodies, and inline file-change bodies are omitted at
  the wire boundary, including small outputs. Explicit failure flags and bounded result IDs
  preserve status and grouped action counts without shipping those bodies. Persisted events
  remain complete; the existing diff endpoints still provide file content when requested.
- The initial shell contains active navigation rows only. Archived rows use the dedicated archive
  query, and transcript message bodies stay in thread detail regardless of message size.
- Shell resume sends deltas plus compact repository-enrichment metadata, not another full project
  and thread snapshot.
- Auto, steer, and restart sends resolve delivery from authoritative state inside the
  server's per-thread dispatch lock. Model selection and identified-checkpoint rollback also
  dispatch without first fetching a full thread projection when the server advertises support.
  Older servers retain projection-based validation. Explicit start sends already skipped that
  read, so this saving does not apply to every client send path.

When changing projection schemas, paging, shell synchronization, or thread state, run this command
alongside the focused package typechecks and a real-client pass on every affected surface. The
transport performance fixtures validate contract encoding and compare pre-compression RPC JSON
for the same synthetic workload, preserving historical application-object counts separately.
These are neither compressed WebSocket captures nor measurements of server RSS, and command
fixtures exclude unrelated settings calls and subscription events. Payload budgets belong in
these tests so regressions fail locally.

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

## Background work and navigation

The settlement worker reads active, unpinned threads without explicit settlement overrides from
`ProjectionStore.getSettlementCandidates`. It reads the latest run and user-message timestamps,
rejects active runs and pending requests, and checks background work using the same derivation as
the shell. It does not load archived histories, fork ancestry, transcript counts, or provider
sessions. The orchestrator still validates the current thread before applying settlement.

Read receipts use `ProjectionStore.getThread` to load only canonical thread metadata. A visit
advances `lastVisitedAt` monotonically without changing `updatedAt` or decoding history. Shell
queries use a covering thread/run index for item counts and a partial index for nonterminal
background items, including idle items. Latest user-message reads use an index ordered by update
time.

Command palette results keep live VCS and linked pull-request queries leased to the visible
viewport, including a small overscan region. Cached badges remain available while leases are
released. Local Git status reads skip divergence calculations; callers that need ahead/behind
counts keep the full status path. Cached fetch failures share the existing backoff and log only
the actual failed attempt. Unchanged desktop environment bootstrap reads retain their array
identity so polling does not invalidate subscribers.

Relay awareness queues one pending publication per thread and retains a follow-up when the thread
changes during a send. Transcript deltas and tool output do not enqueue awareness work. Run,
request, and relevant thread metadata events do. Configuration is checked before shell reads, and
connection changes invalidate published identities so relinking can publish unchanged state.
Failed publications retry the latest state up to five times with exponential delays. A new
relevant event resets the budget; successful publication, disabling, or unlinking cancels retries.
After the budget is exhausted, publication waits for another relevant event instead of generating
continuous traffic during an outage.

Focused coverage: `ProjectionSettlement.test.ts`, `ThreadSettlementService.test.ts`,
`runtimeLayer.test.ts`, `AgentAwarenessRelay.test.ts`, `GitVcsDriverCore.test.ts`,
`ThreadStatusIndicators.subscriptions.test.tsx`, and `desktopLocal.test.ts`.
