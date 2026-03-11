# Plan: Provider-Neutral Runtime Determinism and Flake Elimination

## Summary
Replace timing-sensitive websocket and orchestration behavior with explicit typed runtime boundaries, ordered push delivery, and server-owned completion receipts. The cutover is broad and single-shot: no compatibility shim, no mixed old/new transport. The design must reduce flakes without baking Codex-specific lifecycle semantics into generic runtime code.

## Implementation Status

All 7 sections are implemented. CI passes (format, lint, typecheck, test, browser test, build). One deferred item remains: the shared `WsTestClient` helper from section 7 — tests use direct transport subscription and receipt-based waits instead.

### New files

| File | Purpose |
|------|---------|
| `packages/shared/src/DrainableWorker.ts` | Queue-based Effect worker with deterministic `drain` signal |
| `packages/shared/src/schemaJson.ts` | Two-phase JSON→Schema decode helpers (`decodeJsonResult`, `formatSchemaError`) |
| `apps/server/src/wsServer/pushBus.ts` | `ServerPushBus` — ordered typed push pipeline with auto-incrementing sequence |
| `apps/server/src/wsServer/readiness.ts` | `ServerReadiness` — Deferred-based barriers for startup sequencing |
| `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` | Receipt schema union: checkpoint captured, diff finalized, turn quiesced |
| `apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts` | PubSub-backed receipt bus implementation |
| `apps/server/src/watchFileWithStatPolling.ts` | Stat-polling file watcher for containers where `fs.watch` is unreliable |
| `apps/server/vitest.config.ts` | Server-specific test config (timeout bumps) |
| `apps/server/src/wsServer/pushBus.test.ts` | Push bus serialization and welcome-gating tests |
| `packages/shared/src/DrainableWorker.test.ts` | Drainable worker enqueue/drain lifecycle tests |

### Key modifications

| File | Change |
|------|--------|
| `packages/contracts/src/ws.ts` | Channel-indexed `WsPushPayloadByChannel` map, `WsPush` union schema, `WsPushSequence` |
| `apps/server/src/wsServer.ts` | Integrated `ServerPushBus` and `ServerReadiness`; welcome gated on readiness |
| `apps/server/src/keybindings.ts` | Explicit runtime with `start`/`ready`/`snapshot`; dual `fs.watch` + stat-polling watcher |
| `apps/web/src/wsTransport.ts` | Connection state machine (`connecting`→`open`→`reconnecting`→`closed`→`disposed`); two-phase decode at boundary; cached latest push by channel |
| `apps/web/src/wsNativeApi.ts` | Removed decode logic; delegates to pre-validated transport messages |
| `apps/server/src/orchestration/Layers/CheckpointReactor.ts` | Uses `DrainableWorker`; publishes completion receipts |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | Uses `DrainableWorker` for command processing |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | Uses `DrainableWorker` for event ingestion |
| `apps/server/integration/OrchestrationEngineHarness.integration.ts` | Receipt-based waits replace polling loops |

## Key Changes
### 1. Strengthen the generic boundaries, not the Codex boundary — DONE
- `ProviderRuntimeEvent` remains the canonical provider event contract; `ProviderService` remains the only cross-provider facade.
- Raw Codex payloads and event ordering stay isolated in `CodexAdapter.ts` and `codexAppServerManager.ts`.
- `ProviderKind` was not expanded. The runtime stays provider-neutral by contract.

### 2. Replace loose websocket envelopes with channel-indexed typed pushes — DONE
- `packages/contracts/src/ws.ts` now derives push messages from a `WsPushPayloadByChannel` channel-to-schema map. `WsPush` is a union schema replacing `channel: string` + `data: unknown`.
- Every server push carries `sequence: number`, auto-incremented in `ServerPushBus`.
- `packages/shared/src/schemaJson.ts` provides structured decode diagnostics via `formatSchemaError`.
- `packages/contracts/src/ws.test.ts` covers typed push envelope validation and channel/payload mismatch rejection.

### 3. Introduce explicit server readiness and a single push pipeline — DONE
- `apps/server/src/wsServer/pushBus.ts`: `ServerPushBus` with `publishAll` (broadcast) and `publishClient` (targeted) methods, backed by one ordered path. All pushes flow through it.
- `apps/server/src/wsServer/readiness.ts`: `ServerReadiness` with Deferred-based barriers for HTTP listening, push bus, keybindings, terminal subscriptions, and orchestration subscriptions.
- `server.welcome` is emitted only after connection-scoped and server-scoped readiness is complete.
- `wsServer.ts` no longer publishes directly from ad hoc background streams.

### 4. Turn background watchers into explicit runtimes — DONE
- `apps/server/src/keybindings.ts` refactored as explicit `KeybindingsShape` service with `start`, `ready`, `snapshot` semantics.
- Initial config load, cache warmup, and dual watcher attachment (`fs.watch` + `watchFileWithStatPolling`) complete before `ready` resolves.
- `watchFileWithStatPolling.ts` is the thin adapter for environments where `fs.watch` is unreliable.

### 5. Replace polling-based orchestration waiting with receipts — DONE
- `RuntimeReceiptBus` service defines three receipt types: `CheckpointBaselineCapturedReceipt`, `CheckpointDiffFinalizedReceipt` (with `status: "ready"|"missing"|"error"`), and `TurnProcessingQuiescedReceipt`.
- `CheckpointReactor`, `ProviderCommandReactor`, and `ProviderRuntimeIngestion` use `DrainableWorker` and publish receipts on completion.
- Integration harness and checkpoint tests await receipts instead of polling snapshots and git refs.

### 6. Centralize client transport state and decoding — DONE
- `apps/web/src/wsTransport.ts` implements an explicit connection state machine: `connecting`, `open`, `reconnecting`, `closed`, `disposed`.
- Two-phase decode (JSON parse → Schema validate) happens at the transport boundary. `wsNativeApi.ts` receives pre-validated messages.
- Cached latest welcome/config modeled as explicit `latestPushByChannel` state.

### 7. Replace ad hoc test helpers with semantic test clients — MOSTLY DONE
- `DrainableWorker` replaces timing-sensitive `Effect.sleep` with deterministic `drain()` across reactor tests.
- Orchestration harness waits on receipts/barriers instead of `waitForThread`, `waitForGitRef`, and retry loops.
- Behavioral assertions moved to deterministic unit-style harnesses; narrow integration tests kept for real filesystem/socket behavior.
- **Deferred:** Shared `WsTestClient` helper (connect, awaitSemanticWelcome, awaitTypedPush, trackSequence, matchRpcResponseById). Tests use direct transport subscription instead.

## Provider-Coupling Guardrails
- No generic runtime API may depend on Codex-native event names, thread IDs, or request payload shapes.
- No readiness barrier may be defined as "Codex has emitted X." Readiness is owned by the server runtime, not by provider event order.
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
