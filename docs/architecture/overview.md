# Architecture overview

SergeCode has two maintained client surfaces and one backend:

1. The native SwiftUI macOS app starts and supervises `apps/server/dist/bin.mjs` as a child process. It exchanges a one-time bootstrap credential for a local session, then speaks the HTTP and WebSocket protocols implemented by `T3Kit`.
2. The iPhone companion uses `packages/client-runtime` and the shared schemas in `packages/contracts` to connect over LAN or the optional relay.
3. The Node backend owns provider processes, orchestration, persistence, worktrees, source control, terminal sessions, assets, authentication, and pairing.

The backend is UI-independent. It does not bundle or serve a browser application. Native clients consume its API directly.

## Boundaries

- `packages/contracts` stays schema-only.
- Shared executable TypeScript logic belongs in `packages/shared` or `packages/client-runtime`.
- Swift wire models are maintained in `apps/mac/Sources/T3Kit` and verified with fixture-driven tests.
- Provider protocol adapters live behind backend services so client code does not depend on provider-specific transports.

See [the native macOS architecture](../../apps/mac/ARCHITECTURE.md), [connection runtime](./connection-runtime.md), and [provider architecture](./providers.md).
