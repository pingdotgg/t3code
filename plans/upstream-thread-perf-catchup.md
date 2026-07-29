# Upstream thread-perf catch-up list

Source: analysis of `pingdotgg/t3code` (read-only) between our fork point
`4ac094f` (2026-07-03) and upstream `v0.0.30` / nightlies through 2026-07-29.
Upstream landed a wave of "thread performance / less data to view threads"
work. Much of it is already ported here (ActivityPayloadProjection, settled
lifecycle, HTTP snapshots + `afterSequence`, deferred client cache writes,
shell/detail two-tier schema). What follows is what is **not** here yet,
ranked by expected impact for SergeCode (mac is the flagship client).

Upstream refs are commit SHAs in t3code and their PR numbers. Do not touch
the upstream repo; use a local read-only clone for diffs.

## Top 10

### 1. Gzip large HTTP snapshot responses (upstream `8829e2f9b` #4788 + `8650f05f9` #4798)

Global `HttpRouter.middleware` that gzips JSON responses when body is
`Uint8Array`, `contentLength >= 1024`, content type `application/json`, no
existing `content-encoding`. Full `Accept-Encoding` q-value parsing, always
sets `Vary: Accept-Encoding`, streams with `content-encoding: gzip`.
Follow-up #4798 puts the compressor behind a Context.Service with
`layerNode` (`node:zlib` `createGzip`) and `layerBun`
(`CompressionStream("gzip")`).

Us today: snapshot endpoints (`apps/server/src/orchestration/http.ts`)
return plain JSON. Comments in
`packages/client-runtime/src/state/threadSnapshotHttp.ts:26` and
`shellSnapshotHttp.ts:22` already **assume** transport gzip that never
shipped. Large thread snapshots are exactly the payload gzip loves (~10x on
repetitive JSON).

### 2. WebSocket permessage-deflate (upstream `887dd6e45` #4705)

Upstream patches `@effect/platform-node` / `@effect/platform-bun` to pass
`perMessageDeflate: { compress: "dedicated", decompress: "shared" }` in the
ws serve options. `dedicated` compress keeps a per-connection sliding window
so successive JSON activity frames share a dictionary; `shared` decompress
dodges a uWebSockets abort bug (uNetworking/uWebSockets.js#633). Upstreamed
as Effect-TS/effect#6691 — lands natively in `@effect/platform` beta.103, so
check whether an Effect upgrade gets it for free before patching.

Us today: `apps/server/src/ws.ts:1901` creates the WS route with no socket
options; no `perMessageDeflate` anywhere.

### 3. Mac client: HTTP snapshot + `afterSequence` resume

Not one upstream commit — this closes _our_ gap to the architecture upstream
completed. TS clients load snapshots over HTTP and subscribe with
`afterSequence` + `requestCompletionMarker`
(`packages/client-runtime/src/state/threads.ts:270`). Mac does neither:
`apps/mac/Sources/T3Kit/T3Client.swift:238` sends `subscribeThread` with
only `threadId`, so every thread open downloads a full WS snapshot frame,
and catch-up rides the legacy `replayEvents` RPC (`T3Client.swift:215`).
Port the snapshot-first + sequence-resume flow to T3Kit. Prerequisite for
item 5's RPC deletion.

### 4. Trim stale context-window rows from detail snapshots (upstream `5fcdefd05` #4791)

`dropStaleContextWindowActivities()` in ActivityPayloadProjection: keep only
the last _resolvable_ `context-window.updated` activity per `turnId`
(resolvable = finite `usedTokens >= 0`), pass malformed rows through, leave
live events untouched. Upstream's rationale: long threads carry thousands of
context-window rows and clients only ever read the latest per turn. Our
`ActivityPayloadProjection.ts` has no such trim.

### 5. Bound the replay paths; then retire `replayEvents` (upstream `5fcdefd05` #4791 + `db4b2d8a0` #4177)

Our `replayEvents` handler (`apps/server/src/ws.ts:1071`) does
`readEvents(fromSequenceExclusive)` → `Stream.runCollect` with
`maximum: Number.MAX_SAFE_INTEGER` — a stale cursor collects the whole tail
into memory. Upstream added `SHELL_RESUME_MAX_GAP = 1000`: a resumer more
than 1000 events behind head skips per-event replay and gets one fresh
snapshot instead. Adopt the cap on all resume paths; once item 3 moves mac
off `replayEvents`, delete the RPC entirely as upstream did.

### 6. Shell stream coalescing (upstream `db4b2d8a0` #4177)

`Stream.groupedWithin(512, "50 millis")` on the shell subscription, keep
only the highest-sequence event per `aggregateKind:aggregateId`, re-sort,
refetch shells with concurrency 8. Requires upsert-or-remove correctness:
emit `*-removed` when the projection read returns none (a delete coalesced
into a later event), with one retry + log on read errors. Our
`apps/server/src/ws.ts:1878` shares one firehose across subscribers but maps
every event 1:1 — a streaming turn hammers one thread's shell refetch per
delta and new-thread events queue behind them.

### 7. Mobile: defer work-log detail serialization (upstream `b4680cbfd` #4607)

`apps/mobile/src/lib/threadActivity.ts:1717` builds
`buildWorkEntryExpandedBody(entry)` (including
`JSON.stringify(entry.toolData, null, 2)` for MCP calls) and `copyText` for
**every** row at feed-build time; `thread-work-log.tsx:210` reads it only
when a row expands. Upstream replaced eager `fullDetail`/`copyText` with
`canExpand: boolean` (cheap predicate) plus memoized `getFullDetail()` /
`getCopyText()` thunks called on expand/long-press. Hurts us extra because
`mcp_tool_call` payloads are exempt from server-side pruning
(`ActivityPayloadProjection.ts:163`).

### 8. Mobile: page the settled thread section (upstream Thread List v2, default via `b0c4992c7` #4717)

Upstream's mobile list renders 10 settled rows initially and pages by 25
with a "show more" control (`THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10`,
`THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25`). We partition settled threads
(`apps/mobile/src/features/home/homeThreadList.ts:31`) but materialize the
whole set; only _archived_ threads are paginated server-side
(`getArchivedShellSnapshot`). Add settled paging to mobile home +
navigation sidebar; consider the same for mac sidebar's settled disclosure.

### 9. Thread snoozing (upstream `202e5609f` #4311)

Server-backed snooze on top of the settled lifecycle we already share:
snoozed threads leave the active list until a timer or new activity wakes
them. Zero `snooze` hits in our repo today. Needs contracts + server
command/event + mac sidebar and mobile UI. Feature, not pure perf, but it
directly shrinks the active list users scan.

### 10. Git ref refresh storm fix (upstream `38a6e3ce6` #4727)

Upstream rewrote `GitVcsDriverCore` ref refresh (+841 lines churn) and added
`paginatedBranches` state: branch lists are paginated/cached and refreshes
coalesced instead of re-enumerating refs per consumer. We have no branch
pagination anywhere (server, client-runtime, or mac). Matters for repos with
hundreds of branches feeding branch pickers and PR-state polling.

## Bonus fixes worth porting while in there

- **Image paths lost in payload pruning** (upstream regression fix
  `0a9ea4bbe`): our `ActivityPayloadProjection.ts` port predates it — image
  view items get pruned to nothing (no type/path kept, base64 dropped), so
  chat image galleries can render blank. Small, arguably a live bug.
- **Settle merged-PR threads immediately** (`9cf9fc9c5` #4704): upstream
  removed the grace delay; verify our `threadSettled.ts:132` matches the
  final semantics, including keep-warm exception (`193e3c62e` #4309).
- **Thread loading flash** (`91dfe60a9` #4396): hold the previous thread
  render until the new snapshot resolves. Web-side upstream; check the
  mobile thread screen for the same flash.
- **Draft-thread detail polling gate** (`e77f42c11` #4670): don't subscribe
  to thread detail before the thread exists in the shell projection.

## Explicitly not applicable

- Sidebar v2 flat list (`32c6012da` #4026): ours is project-grouped by
  design across mac and mobile; the settled _lifecycle_ underneath is
  already ported.
- Duty-cycled CSS status animations / noise overlay removal (`2fdc704bb`
  #3978): web-only rendering costs; mac is native, mobile uses different
  animation machinery.
