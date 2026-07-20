# Background Git Ref And Port Polling

Frequently mounted Git-ref and preview-discovery surfaces stay fresh without continuously repeating their most expensive subprocess work.

Expected behavior:

- Git ref lists revalidate their first page every 20 seconds instead of every five seconds. Loaded cursor pages are one-shot snapshots, and inactive ref atoms expire after 30 seconds.
- Opening the composer branch selector or Diff panel comparison-ref menu explicitly refreshes local and remote refs, so user interaction does not wait for the background interval.
- Preview port discovery performs one immediate scan when the first subscriber retains it. Subscriptions replay the latest snapshot instead of initiating a duplicate scan.
- Subscription replay and concurrent snapshot broadcasts are serialized so a stale replay cannot arrive after a newer scan result.
- Managed terminal process-set changes trigger an immediate port scan; unchanged registrations and redundant removals do not.
- The broad `lsof` safety-net scan runs every 20 seconds when no server is known and every 10 seconds while a listener is present. This preserves discovery for servers started outside T3-managed terminals without a permanent three-second system-wide process sweep.

Primary files:

- `packages/client-runtime/src/state/vcs.ts`
- `apps/web/src/components/DiffPanel.tsx`
- `apps/server/src/preview/PortScanner.ts`
- `apps/server/src/ws.ts`

Focused regression coverage lives in `apps/server/src/preview/PortScanner.test.ts`. Keep coverage for snapshot replay without rescanning, ordered replay during concurrent broadcasts, and unchanged terminal registrations avoiding redundant probes.

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`
