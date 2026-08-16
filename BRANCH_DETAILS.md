# Background Preview Port Polling

Preview-discovery surfaces stay fresh without continuously repeating their most expensive system-wide subprocess work.

Expected behavior:

- In `apps/server/src/ws.ts`, each preview-discovery subscription passes its configured URLs to `PortDiscovery.retain(configuredUrls)` before subscribing. The first retainer, or a retainer that introduces URLs absent from the latest scan, performs one immediate scan; subscription then replays the resulting per-subscriber projection without initiating a duplicate scan.
- In `apps/server/src/preview/PortScanner.ts`, broad listener discovery and configured URL probes publish only browser-ready HTTP(S) results. Each listener receives its own configured-URL projection, while shared readiness results remain cached for 15 seconds.
- Subscription replay and concurrent snapshot broadcasts are serialized so a stale replay cannot arrive after a newer scan result.
- A failed initial snapshot replay rolls back listener registration before releasing the notification lock, so the failed subscriber cannot block later broadcasts to healthy subscribers.
- Subscription cleanup is installed before awaiting initial replay, and scope closure removes the registration, acknowledges queued publications, and interrupts blocked callback work without waiting behind it. Active callback delivery is acknowledged atomically before a pending interruption resumes.
- Subscriber callbacks run from per-listener notification queues outside the global notification lock. External publications still wait for delivery, while callback-reentrant publications and scan requests enqueue in order without waiting on their own delivery or the active scan lock.
- Port scans are serialized before publication, so an older slow scan cannot finish after a newer scan and overwrite its snapshot.
- Managed terminal process-set changes trigger an immediate port scan. The first unchanged registration after a non-empty process-set change performs one settle scan so a child that binds after the initial PID observation is discovered promptly; later unchanged registrations and redundant removals do not scan.
- Discovery transitions between no known browser-ready servers and at least one known browser-ready server wake the adaptive poll scheduler so it immediately adopts the 20-second idle or 10-second active interval.
- The broad `lsof` safety-net scan runs every 20 seconds when no browser-ready server is known and every 10 seconds while a retained discovery client has at least one known browser-ready server. The first active tick may reuse a readiness result from the 15-second cache; the second active tick, 20 seconds after retention, revalidates it. This preserves discovery for servers started outside T3-managed terminals without a permanent three-second system-wide process sweep.

Primary files:

- `apps/server/src/preview/PortScanner.ts`
- `apps/server/src/ws.ts`

Focused regression coverage:

- `apps/server/src/preview/PortScanner.test.ts` covers configured-URL retention and per-subscriber replay without duplicate scanning, browser-readiness filtering and cache lifecycle, readiness-cache reuse on the first active tick with revalidation on the second, ordered replay during concurrent broadcasts, replay- and scan-broadcast-reentrant scans without deadlock, failed/interrupted-replay listener cleanup, blocked-listener scope shutdown, publisher acknowledgment when scope closure races callback completion, serialized concurrent scans, adaptive rescheduling after terminal discovery, and one bounded settle scan without repeated unchanged-terminal probes.

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`
