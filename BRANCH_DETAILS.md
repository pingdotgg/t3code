# Background Preview Port Polling

Preview-discovery surfaces stay fresh without continuously repeating their most expensive system-wide subprocess work.

Expected behavior:

- In `apps/server/src/preview/PortDiscoverySubscription.ts`, each preview-discovery subscription passes its configured URLs to `PortDiscovery.retain(configuredUrls)` before subscribing. The first retainer, or a retainer that introduces URLs absent from the latest scan, performs one immediate scan; subscription then replays the resulting per-subscriber projection without initiating a duplicate scan. `apps/server/src/ws.ts` delegates the RPC stream to this adapter so unrelated WebSocket changes do not need to carry that ordering logic.
- In `apps/server/src/preview/PortScanner.ts`, broad listener discovery and configured URL probes publish only browser-ready HTTP(S) results. Each listener receives its own configured-URL projection, while shared readiness results remain cached for 15 seconds.
- Subscription replay and concurrent snapshot broadcasts are serialized so a stale replay cannot arrive after a newer scan result.
- A failed initial snapshot replay rolls back listener registration before releasing the notification lock, so the failed subscriber cannot block later broadcasts to healthy subscribers.
- Subscription cleanup is installed before awaiting initial replay, and scope closure removes the registration, acknowledges queued publications, and interrupts blocked callback work without waiting behind it. Dequeue ownership, callback delivery, and publisher acknowledgment share one masked handoff, so interruption cannot strand a notification between queue removal and acknowledgment.
- Subscriber callbacks run from per-listener notification queues outside the global notification lock. External publications still wait for delivery after releasing the scan lock, while callback-reentrant publications and scan requests enqueue in order without waiting on their own delivery or the active scan lock. Public one-off scans can therefore run from a scan-broadcast callback without deadlocking.
- Background poll failures are logged without converting caller-fiber interruption into success, so scoped terminal-process polling can still shut down promptly while an immediate scan is in progress.
- Port scans are serialized before publication, so an older slow scan cannot finish after a newer scan and overwrite its snapshot. Final-retainer snapshot invalidation uses the same scan lock, preventing an in-flight scan from republishing after discovery becomes idle.
- Managed terminal process-set changes trigger an immediate port scan while discovery is retained. The first unchanged registration after a non-empty process-set change performs one settle scan so a child that binds after the initial PID observation is discovered promptly; idle registrations preserve that pending settle scan until retention resumes, while later unchanged registrations and redundant removals do not scan.
- When the final discovery retainer leaves, its published snapshot and subscriber projections are invalidated while the bounded HTTP readiness cache remains available. A failed first-retainer scan therefore cannot replay servers from an earlier retained session.
- Discovery transitions between no known browser-ready servers and at least one known browser-ready server wake the adaptive poll scheduler so it immediately adopts the 20-second idle or 10-second active interval.
- The broad `lsof` safety-net scan runs every 20 seconds when no browser-ready server is known and every 10 seconds while a retained discovery client has at least one known browser-ready server. The first active tick may reuse a readiness result from the 15-second cache; the second active tick, 20 seconds after retention, revalidates it. This preserves discovery for servers started outside T3-managed terminals without a permanent three-second system-wide process sweep.

Primary files:

- `apps/server/src/preview/PortScanner.ts`
- `apps/server/src/preview/PortDiscoverySubscription.ts`
- `apps/server/src/ws.ts`

Focused regression coverage:

- `apps/server/src/preview/PortScanner.test.ts` covers configured-URL retention and per-subscriber replay without duplicate scanning, browser-readiness filtering and cache lifecycle, readiness-cache reuse on the first active tick with revalidation on the second, ordered replay during concurrent broadcasts, replay- and scan-broadcast-reentrant terminal changes and public scans without deadlock, failed/interrupted-replay listener cleanup, caller interruption during terminal-triggered scans, stale-snapshot invalidation across failed retain scans and concurrent final release, blocked-listener scope shutdown, publisher acknowledgment when scope closure races callback work, serialized concurrent scans, adaptive rescheduling after terminal discovery, and one bounded settle scan that survives idle terminal reports without repeating unchanged-terminal probes.
- `apps/server/src/preview/PortDiscoverySubscription.test.ts` covers the WebSocket adapter's configured-URL forwarding, retention-before-subscription ordering, replay envelope, and scoped cleanup.

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`
