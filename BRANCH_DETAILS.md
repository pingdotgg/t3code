# Thread Detail Subscription Reliability

Thread-detail synchronization distinguishes an authoritative missing resource from a transient snapshot failure so stale thread state cannot enter an unbounded subscription retry loop.

Expected behavior:

- An HTTP `thread_not_found` response clears the persisted detail cache and marks the client thread state deleted.
- The missing-thread subscription terminates before opening or retrying its WebSocket stream, including after session replacement and application-foreground resubscription signals.
- Every server-detail consumer, including the server-thread route, gates known local drafts until the shell observes `thread.created`, so the expected pre-creation HTTP 404 cannot mark the draft deleted and the new shell starts fresh synchronization after the first send.
- Other HTTP snapshot failures remain transient and fall back to the socket snapshot path.

Primary files:

- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

## Development Ports

- Web: `5741`
- Server/WebSocket: `13781`
