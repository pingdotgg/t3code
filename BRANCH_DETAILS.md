# Thread Detail Subscription Reliability

Thread-detail synchronization distinguishes an authoritative missing resource from a transient snapshot failure across both HTTP snapshot loading and WebSocket snapshot fallback so stale thread state cannot enter an unbounded subscription retry loop.

## Fork Customizations

- An HTTP `thread_not_found` response clears the persisted detail cache and marks the client thread state deleted.
- When a bounded WebSocket resume falls back to a fresh snapshot, clients advertise `ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY` (`orchestration.thread-not-found-error.v1`) in the subscription capability list and receive a dedicated `OrchestrationThreadNotFoundError`. The error applies the same cache removal and deleted-state transition for a warm cached thread.
- The subscription input retains the optional legacy `threadNotFoundError` boolean for backward compatibility. Current clients advertise it alongside the versioned capability until every supported server understands the capability list. Servers emit the dedicated error for either opt-in. Servers predating both opt-ins ignore them and emit `OrchestrationGetSnapshotError`, which remains decodable and transient for current clients. Capability names are open strings so current servers can decode future names and act only on versions they understand.
- `packages/client-runtime/src/errors/orchestration.ts` is the canonical terminal missing-thread classifier for both transports. It preserves an HTTP `EnvironmentResourceNotFoundError` whose reason is `thread_not_found` at any typed failure position in a combined cause and recognizes the WebSocket error through the same classification. Standalone defects are not classified as terminal missing-thread errors, while unrelated expected failures remain transient.
- Cache removal is serialized with snapshot persistence, and persistence rechecks deleted state under the same lock, so a queued or in-flight save cannot resurrect an authoritatively deleted thread. The semaphore is retained in `ThreadResumeCache` across atom disposal and remount, so a previous owner's in-flight finalizer save completes before its successor removes the cache. The terminal deletion transition is uninterruptible, so disposing the successor cannot cancel cache removal while it waits for that save.
- The missing-thread subscription terminates before opening or retrying its WebSocket stream. A subscription resumed after session replacement advertises the same capability and, when the server authoritatively reports the thread missing, deletes the warm cache and does not subscribe again on later session or foreground wakeups.
- Once thread state is deleted, subscription input creation fails closed both before and after synchronization setup, preventing foreground wakeups or replacement sessions from reopening the stream.
- `classifyThreadDetail` produces the canonical `ThreadDetailClassification` consumed by `resolveThreadDetailRef`, `useThread`, and direct route detail/status lookups. Local drafts wait for the shell whether draft-store detection or an explicit `waitForShell` request identifies the pre-creation thread. Draft workspace-mode changes before shell creation preserve lookup by the reserved thread ref, so this guard remains active while switching between current-checkout and new-worktree modes. The expected pre-creation HTTP 404 therefore cannot mark the draft deleted, and the new shell starts fresh synchronization after the first send.
- Other HTTP snapshot failures remain transient and fall back to the socket snapshot path. Other WebSocket snapshot failures remain transient and retain the existing retry behavior.

## Merge-Sensitive Seams

- `packages/contracts/src/orchestration.ts` owns the exact versioned capability token, the open capability list, and the deprecated boolean. Current clients dual-advertise while boolean-era servers remain supported; keep both fields aligned with the pre-feature and boolean-era decoding coverage in `packages/contracts/src/rpc.test.ts`.
- `packages/contracts/src/rpc.ts` includes `OrchestrationThreadNotFoundError` in the subscription error union. `apps/server/src/ws.ts` must emit that variant only when the exact versioned capability or legacy boolean is present and only when the bounded resume fallback cannot load a snapshot. Live delivery starts before the fallback snapshot load; an absent snapshot must terminate the stream before any buffered live event or synchronization marker is emitted. `apps/server/src/server.test.ts` covers this ordering.
- `packages/client-runtime/src/state/threads.ts` dual-advertises the versioned capability and legacy boolean on initial and resumed subscriptions. Its terminal missing-thread path must remain serialized with snapshot persistence across retained `ThreadResumeCache` owner handoffs and must win over reconnect, session-replacement, and foreground wakeups. `packages/client-runtime/src/state/threads-sync.test.ts` covers restart continuation from a warm cache; `packages/client-runtime/src/state/threads-atoms.test.ts` covers an old finalizer save overlapping its successor's terminal deletion.
- `apps/web/src/state/entities.ts` owns the only readiness classification for thread-detail subscriptions. `apps/web/src/components/ThreadRouteView.tsx` derives one classification and passes it to both detail and status consumers; it does not maintain a parallel readiness shape. `useThread` feeds its draft-store detection and explicit `waitForShell` input through the same classifier.
- `apps/web/src/composerDraftStore.test.ts` protects reserved draft lookup across workspace-mode changes. `apps/web/src/state/entities.test.ts` protects both hook consumers and all classification states.

## Primary Files

- `packages/client-runtime/src/errors/orchestration.ts`
- `packages/client-runtime/src/errors/orchestration.test.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.test.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `packages/client-runtime/src/state/threads-atoms.test.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/rpc.test.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/newThreadSubscriptionGate.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/components/ThreadRouteView.tsx`

## Development Ports

- Web: `5741`
- Server/WebSocket: `13781`
