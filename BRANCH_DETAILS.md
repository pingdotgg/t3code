# Background Git Ref And Port Polling

Frequently mounted Git-ref and preview-discovery surfaces stay fresh without continuously repeating their most expensive subprocess work.

Expected behavior:

- Git ref lists revalidate their first page every 20 seconds instead of every five seconds. Loaded cursor pages are one-shot snapshots, and inactive ref atoms expire after 30 seconds.
- The composer branch selector's open-triggered ref refresh originated upstream. This branch preserves that behavior while routing it through the same branch-owned open-only refresh helper used by the Diff panel comparison-ref menu, which explicitly refreshes both local and remote refs on open.
- Closing either menu resets its query state without triggering another ref refresh, so user interaction stays fresh without adding close-triggered work.
- Closing either menu resets both its visible and backing ref query, cancels any pending open-triggered refresh, and prevents deferred query settlement from refreshing after close.
- Preview port discovery performs one immediate scan when the first subscriber retains it. Subscriptions replay the latest snapshot instead of initiating a duplicate scan.
- Subscription replay and concurrent snapshot broadcasts are serialized so a stale replay cannot arrive after a newer scan result.
- A failed initial snapshot replay rolls back listener registration before releasing the notification lock, so the failed subscriber cannot block later broadcasts to healthy subscribers.
- Subscription cleanup is installed before awaiting initial replay, and scope closure removes the registration, acknowledges queued publications, and interrupts blocked callback work without waiting behind it.
- Subscriber callbacks run from per-listener notification queues outside the global notification lock. External publications still wait for delivery, while callback-reentrant publications and scan requests enqueue in order without waiting on their own delivery or the active scan lock.
- Port scans are serialized before publication, so an older slow scan cannot finish after a newer scan and overwrite its snapshot.
- Managed terminal process-set changes trigger an immediate port scan; unchanged registrations and redundant removals do not.
- Discovery transitions between no known servers and at least one known server wake the adaptive poll scheduler so it immediately adopts the 20-second idle or 10-second active interval.
- The broad `lsof` safety-net scan runs every 20 seconds when no server is known and every 10 seconds while a listener is present. This preserves discovery for servers started outside T3-managed terminals without a permanent three-second system-wide process sweep.

Primary files:

- `packages/client-runtime/src/state/vcs.ts`
- `apps/web/src/components/BranchToolbarBranchSelector.tsx`
- `apps/web/src/components/DiffPanel.tsx`
- `apps/web/src/components/vcsRefMenuRefresh.ts`
- `apps/server/src/preview/PortScanner.ts`
- `apps/server/src/ws.ts`

Focused regression coverage:

- `packages/client-runtime/src/state/vcs.test.ts` covers the 20-second first-page revalidation interval.
- `apps/web/src/components/vcsRefMenuRefresh.test.ts` covers the shared helper's one-callback and multiple-callback open paths, complete query cleanup on close, deferred-refresh cancellation after close, and open-menu refresh after query reset; component wiring remains visible in the two primary component files above.
- `apps/server/src/preview/PortScanner.test.ts` covers snapshot replay without rescanning, ordered replay during concurrent broadcasts, replay- and scan-broadcast-reentrant scans without deadlock, failed/interrupted-replay listener cleanup, blocked-listener scope shutdown, serialized concurrent scans, adaptive rescheduling after terminal discovery, and unchanged terminal registrations avoiding redundant probes.

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`
