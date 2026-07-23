# Background Git Ref And Port Polling

Frequently mounted Git-ref and preview-discovery surfaces stay fresh without continuously repeating their most expensive subprocess work.

Expected behavior:

- Git ref lists revalidate their first page every 20 seconds instead of every five seconds. Loaded cursor pages are one-shot snapshots, and inactive ref atoms expire after 30 seconds.
- The composer branch selector's open-triggered ref refresh originated upstream. This branch preserves that behavior while routing it through the same branch-owned open-only refresh helper used by the Diff panel comparison-ref menu, which explicitly refreshes both local and remote refs on open.
- Closing either menu resets its query state without triggering another ref refresh, so user interaction stays fresh without adding close-triggered work.
- Preview port discovery performs one immediate scan when the first subscriber retains it. Subscriptions replay the latest snapshot instead of initiating a duplicate scan.
- Subscription replay and concurrent snapshot broadcasts are serialized so a stale replay cannot arrive after a newer scan result.
- Managed terminal process-set changes trigger an immediate port scan; unchanged registrations and redundant removals do not.
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
- `apps/web/src/components/vcsRefMenuRefresh.test.ts` covers the shared helper's one-callback and multiple-callback open paths plus its no-refresh-on-close path; component wiring remains visible in the two primary component files above.
- `apps/server/src/preview/PortScanner.test.ts` covers snapshot replay without rescanning, ordered replay during concurrent broadcasts, and unchanged terminal registrations avoiding redundant probes.

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`
