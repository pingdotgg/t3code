# Plan: Provider-Neutral Runtime Determinism and Flake Elimination

## Summary
Replace timing-sensitive websocket and orchestration behavior with explicit typed runtime boundaries, ordered push delivery, and server-owned completion receipts. The cutover is broad and single-shot: no compatibility shim, no mixed old/new transport. The design must reduce flakes without baking Codex-specific lifecycle semantics into generic runtime code.

## Key Changes
### 1. Strengthen the generic boundaries, not the Codex boundary
- Keep `ProviderRuntimeEvent` as the canonical provider event contract and `ProviderService` as the only cross-provider facade.
- Do not expose raw Codex payloads or Codex event ordering outside `CodexAdapter.ts` and `codexAppServerManager.ts`.
- Do not expand `ProviderKind` in this change. The runtime stays provider-neutral by contract, while the product remains Codex-only in concrete support.

### 2. Replace loose websocket envelopes with channel-indexed typed pushes
- Refactor `packages/contracts/src/ws.ts` so push messages are derived from a channel-to-schema map instead of `channel: string` plus `data: unknown`.
- Add `sequence: number` to every server push. Ordering becomes explicit and testable.
- Add structured decode diagnostics with stable machine fields: `code`, `reason`, `expected`, `actual`, `path`, optional `jsonOffset`.
- Remove runtime/test dependence on engine-specific pretty strings. Human-readable formatting remains a logging helper only.

### 3. Introduce explicit server readiness and a single push pipeline
- Add a `ServerPushBus` service in `apps/server` backed by one ordered queue/pubsub path. All pushes go through it: `server.welcome`, `server.configUpdated`, terminal events, orchestration domain events.
- Add a `ServerReadiness` service with explicit barriers for:
  - HTTP listening
  - push bus ready
  - keybindings runtime ready
  - terminal subscriptions ready
  - orchestration subscriptions ready
- Strengthen `server.welcome` semantics: it is emitted only after connection-scoped and server-scoped readiness is complete.
- `wsServer` should never publish directly from ad hoc background streams once the bus exists.

### 4. Turn background watchers into explicit runtimes
- Extract keybindings watching into a `KeybindingsRuntime` service with `start`, `ready`, `snapshot`, and `changes`.
- Initial config load, startup sync, cache warmup, and watcher attachment complete before `ready` resolves.
- Keep the real `fs.watch` adapter thin. Most behavior tests use a fake watch source and deterministic change stream.

### 5. Replace polling-based orchestration waiting with receipts
- Add server-owned completion receipts for operations that tests currently infer by polling:
  - checkpoint capture complete
  - checkpoint diff finalized
  - turn processing quiesced
- A receipt means append, projection, and required side effects are complete. It must not mean the provider emitted a certain event sequence.
- Update the orchestration harness and checkpoint tests to await receipts/barriers instead of polling snapshots and git refs.

### 6. Centralize client transport state and decoding
- Refactor `apps/web/src/wsTransport.ts` into an explicit connection state machine: `connecting`, `open`, `reconnecting`, `closed`, `disposed`.
- Decode and validate typed push payloads at the transport boundary, not downstream in `apps/web/src/wsNativeApi.ts`.
- Keep cached latest welcome/config behavior only if it is modeled as explicit state, not as a late-subscriber race workaround.

### 7. Replace ad hoc test helpers with semantic test clients
- Add a shared `WsTestClient` for server/websocket tests:
  - connect
  - await semantic welcome
  - await typed push by channel and optional predicate
  - track `sequence`
  - match RPC responses by id
- Add one orchestration test harness that waits on receipts/barriers instead of custom `waitForThread`, `waitForGitRef`, and arbitrary retry loops.
- Keep only a narrow set of integration tests for real filesystem/watch/socket behavior. Move behavioral assertions to deterministic unit-style harnesses.

## Provider-Coupling Guardrails
- No generic runtime API may depend on Codex-native event names, thread IDs, or request payload shapes.
- No readiness barrier may be defined as “Codex has emitted X.” Readiness is owned by the server runtime, not by provider event order.
- No websocket channel payload may contain raw provider-native payloads unless the channel is explicitly debug/internal.
- Any provider-specific divergence must be exposed through provider capabilities from `ProviderService.getCapabilities()`, not `if provider === "codex"` branches in shared runtime code.
- Generic tests must use canonical `ProviderRuntimeEvent` fixtures. Codex-specific ordering and translation tests stay in adapter/app-server suites only.
- Keep UI/provider-specific knobs such as Codex-only options scoped to provider UX code. Do not pull them into generic transport or orchestration state.

## Test Plan
- Contracts:
  - schema tests for typed push envelopes and structured decode diagnostics
  - ordering tests for `sequence`
- Server:
  - readiness tests proving `server.welcome` cannot precede runtime readiness
  - push bus tests proving terminal/config/orchestration pushes are serialized and typed
  - keybindings runtime tests with fake watch source plus one real watcher integration test
- Orchestration:
  - receipt tests proving checkpoint refs and projections are complete before completion signals resolve
  - replacement of polling-based checkpoint/integration waits with receipt-based waits
- Web:
  - transport tests for invalid JSON, invalid envelope, invalid payload, reconnect queue flushing, cached semantic state
- Validation gate:
  - `bun run lint`
  - `bun run typecheck`
  - `mise exec -- bun run test`
  - repeated full-suite run after cutover to confirm flake removal

## Assumptions and Defaults
- This remains a single-provider product during the cutover, but the runtime contracts must stay provider-neutral.
- No backward-compatibility layer is required for old websocket push envelopes.
- The goal is deterministic runtime behavior first; reducing retries and sleeps in tests is a consequence, not the primary mechanism.
- If a completion signal cannot be expressed provider-neutrally, it does not belong in the shared runtime layer and must stay adapter-local.
