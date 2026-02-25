# Plan: Frontend Contract Schema Validation Alignment

## Summary
Align frontend input/output validation with `@t3tools/contracts` schemas so the web client stops relying on ad-hoc checks and unsafe casts at critical boundaries.

## Goals
1. Decode all WebSocket envelopes with shared contract schemas.
2. Decode push payloads before handing them to app logic.
3. Replace duplicated frontend range/input checks with contract schema decoding.
4. Validate project search params with shared constraints before dispatch.
5. Validate script keybinding updates with `KeybindingRule` schema before RPC.
6. Propagate branded IDs (`ThreadId`, `ProjectId`, etc.) through typed app flow after single ingress conversion.

## Non-Goals
- No protocol shape changes.
- No server behavior changes unless uncovered by failing tests.
- No UI redesign; only validation/transport boundary hardening.

## Phase 1: WebSocket Envelope Decoding

### Issue
`apps/web/src/wsTransport.ts` parses JSON and performs manual object/cast checks (`as WsPush`) instead of decoding with contracts.

### Changes
1. Decode inbound messages with contract schema union (`WsResponse`).
2. Remove manual push/response shape checks that duplicate schema logic.
3. Convert decode failures into safe no-op handling with structured debug logging.

### Target Files
- `apps/web/src/wsTransport.ts`
- `apps/web/src/wsTransport.test.ts`

### Tests
1. Accept valid push envelope and route to channel listener.
2. Accept valid response envelope and resolve pending request.
3. Reject malformed envelope without crashing transport.

## Phase 2: Push Payload Decoding at API Boundary

### Issue
`apps/web/src/wsNativeApi.ts` forwards unknown push payloads and uses direct casts (`data as WsWelcomePayload`).

### Changes
1. Decode `server.welcome` payload with `WsWelcomePayload`.
2. Decode `terminal.event` payload with `TerminalEvent`.
3. Decode `orchestration.domainEvent` payload with `OrchestrationEvent`.
4. Skip invalid payloads safely and keep subscriptions alive.

### Target Files
- `apps/web/src/wsNativeApi.ts`
- `apps/web/src/wsNativeApi.test.ts`

### Tests
1. Valid welcome payload is delivered and cached.
2. Invalid welcome payload is ignored.
3. Valid terminal/orchestration events are forwarded.
4. Invalid push data does not invoke consumers.

## Phase 3: Replace Duplicated Checkpoint Range Validation

### Issue
`apps/web/src/lib/providerReactQuery.ts` duplicates `fromTurnCount`/`toTurnCount` validation rules already represented in contracts.

### Changes
1. Use `OrchestrationGetTurnDiffInput` / `OrchestrationGetFullThreadDiffInput` decoding before RPC calls.
2. Remove bespoke integer/range checks where schema decoding can be authoritative.
3. Preserve current UX behavior (`enabled` gating + retry policy).

### Target Files
- `apps/web/src/lib/providerReactQuery.ts`
- `apps/web/src/lib/providerReactQuery.test.ts`

### Tests
1. Valid range decodes and calls expected RPC.
2. Invalid range fails fast and avoids RPC call.
3. `fromTurnCount === 0` path still routes to `getFullThreadDiff`.

## Phase 4: Project Search Input Validation from Contracts

### Issue
`apps/web/src/lib/projectReactQuery.ts` forwards search inputs without enforcing `ProjectSearchEntriesInput` constraints, and `ChatView` can pass empty query strings.

### Changes
1. Decode project search input with `ProjectSearchEntriesInput` before request dispatch.
2. Gate query execution when query is empty after trim.
3. Replace magic search limit usage with shared constant (`PROJECT_SEARCH_ENTRIES_MAX_LIMIT`) or schema-safe value.

### Target Files
- `apps/web/src/lib/projectReactQuery.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/lib/projectReactQuery.test.ts`

### Tests
1. Empty query does not dispatch request.
2. Over-limit values are rejected or clamped via schema-safe path.
3. Valid queries still return prior placeholder behavior.

## Phase 5: Script/Keybinding Validation Consistency

### Issue
`ProjectScriptsControl` and `ChatView` rely mostly on local non-empty checks while sending keybinding data into a contract-validated endpoint (`server.upsertKeybinding`).

### Changes
1. Add pre-submit decode for keybinding payload using `KeybindingRule`.
2. Normalize and validate keybinding values via schema before calling `upsertKeybinding`.
3. Keep existing script ID command generation logic, but ensure command + key are schema-valid before mutation.

### Target Files
- `apps/web/src/components/ProjectScriptsControl.tsx`
- `apps/web/src/components/ChatView.tsx`
- (optional helper) `apps/web/src/projectScripts.ts`
- `apps/web/src/components/ProjectScriptsControl.test.tsx` (or logic test file)

### Tests
1. Invalid keybinding string surfaces UI validation error and blocks submission.
2. Valid keybinding updates still persist and refresh cached server config.
3. Editing existing script preserves valid keybinding mapping behavior.

## Phase 6: Branded ID Flow (Single Ingress Branding)

### Issue
Frontend currently converts plain strings to branded IDs repeatedly (`asThreadId`, `asProjectId`, etc.) at many callsites, which spreads unsafe conversions across app logic.

### Desired Model
1. Convert/decode to branded IDs once at ingress boundaries.
2. Keep IDs branded through store state, selectors, and command/query builders.
3. Avoid repeated `*.makeUnsafe` wrappers in feature logic.

### Boundary Rules
1. Router/search params (string) -> decode to branded IDs at route boundary.
2. Storage/network payloads (untyped JSON) -> decode with contract schemas at transport/query boundary.
3. ID generation (`newThreadId`, `newProjectId`, etc.) remains branded at source.
4. UI components should consume typed IDs from store/hooks, not raw strings.

### Changes
1. Introduce a thin typed ID layer in web app (or reuse contracts decoders directly) for safe `unknown -> branded` conversion at boundaries.
2. Refactor web store and thread/project domain types to carry branded IDs where feasible.
3. Replace repeated `asThreadId`/`asProjectId` callsites in:
   - `apps/web/src/components/ChatView.tsx`
   - `apps/web/src/components/Sidebar.tsx`
   - `apps/web/src/components/BranchToolbar.tsx`
   - `apps/web/src/lib/providerReactQuery.ts`
4. Keep unavoidable casts isolated in one boundary module (not feature components).
5. Minimize/remove broad `asXId` helpers from `apps/web/src/lib/orchestrationIds.ts` once flow is typed.

### Target Files
- `apps/web/src/lib/orchestrationIds.ts`
- `apps/web/src/types.ts`
- `apps/web/src/store.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/BranchToolbar.tsx`
- `apps/web/src/lib/providerReactQuery.ts`
- route boundary files (`apps/web/src/routes/*`) as needed

### Tests
1. Type-level regression checks (compile-time) proving command builders accept branded IDs directly.
2. Route/load path tests verifying invalid ID ingress is rejected/fails safely.
3. Existing behavior tests still pass for thread/project operations after refactor.

## Cross-Cutting Execution Notes
1. Prefer a small shared frontend utility for Effect schema decoding to avoid repeated `decodeUnknownSync` boilerplate.
2. Use `Schema.decodeUnknownEither` or equivalent non-throwing path where event stream robustness matters.
3. Keep failure behavior fail-soft at stream boundaries (drop invalid events, keep transport running).
4. Brands are TypeScript-level constraints; JSON boundaries still require decode/re-brand at ingress.

## Validation Checklist
1. `bun run lint`
2. `bun run test --filter=@t3tools/web` (or equivalent web test command in repo)
3. Manual smoke checks:
   - App boot + welcome sync
   - Terminal stream still renders
   - Diff panel loads checkpoint ranges
   - Path autocomplete search remains responsive
   - Script add/edit with keybinding works in Electron flow

## Done Criteria
1. No unsafe push/event casts remain at core WebSocket boundaries.
2. Frontend no longer duplicates contract input validation for checkpoint range and project search.
3. Keybinding submission path is schema-validated before RPC.
4. Branded IDs flow through frontend feature code without repeated `asThreadId`/`asProjectId` wrappers.
5. Updated tests cover malformed payload and invalid input regressions.
