# Thread Detail Subscription Reliability

Thread-detail synchronization distinguishes an authoritative missing resource from a transient snapshot failure across both HTTP snapshot loading and WebSocket snapshot fallback so stale thread state cannot enter an unbounded subscription retry loop.

Expected behavior:

- An HTTP `thread_not_found` response clears the persisted detail cache and marks the client thread state deleted.
- When a bounded WebSocket resume falls back to a fresh snapshot, a dedicated `OrchestrationThreadNotFoundError` applies the same cache removal and deleted-state transition for a warm cached thread.
- Cache removal is serialized with snapshot persistence, and persistence rechecks deleted state under the same lock, so a queued or in-flight save cannot resurrect an authoritatively deleted thread.
- The missing-thread subscription terminates before opening or retrying its WebSocket stream, including after session replacement and application-foreground resubscription signals.
- `resolveThreadDetailRef` is the canonical web detail-subscription gate. `useThread` waits for the shell when either automatic draft-store detection or an explicit `waitForShell` request identifies a pre-creation thread, while direct detail/status consumers such as the server-thread route map their local-draft readiness through the same resolver. Draft workspace-mode changes before shell creation preserve lookup by the reserved thread ref, so this guard remains active while switching between current-checkout and new-worktree modes. The expected pre-creation HTTP 404 therefore cannot mark the draft deleted, and the new shell starts fresh synchronization after the first send.
- Other HTTP snapshot failures remain transient and fall back to the socket snapshot path. Other WebSocket snapshot failures remain transient and retain the existing retry behavior.

Primary files:

- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/rpc.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

## Development Ports

- Web: `5741`
- Server/WebSocket: `13781`
