# Plan: Cursor CLI (`agent`) Provider Integration

## Goal

Add Cursor as a first-class provider in T3 Code using Cursor CLI stream JSON mode (`agent -p --output-format stream-json`), with robust session lifecycle handling and canonical `ProviderRuntimeEvent` projection.

---

## 1) Exploration Findings (from live CLI runs)

### 1.1 Core invocation shape

1. Binary is `agent` on PATH (`2026.02.27-e7d2ef6` observed).
2. Non-interactive streaming mode:
   - `agent -p --trust --output-format stream-json --stream-partial-output ...`
3. Session continuity:
   - `agent create-chat` returns a chat UUID.
   - `--resume <chatId>` and `--continue` preserve history.
   - Stream `session_id` equals chat UUID.

### 1.2 Stream JSON event families observed

1. `system/init`
2. `user`
3. `thinking/delta`, `thinking/completed`
4. `assistant` (partial and final)
5. `tool_call/started`, `tool_call/completed`
6. `result/success` (`is_error: false` in all successful process exits)
7. Previously observed under load/rate-limit:
   - `connection/reconnecting`, `connection/reconnected`
   - `retry/starting`, `retry/resuming`
   - followed by non-JSON terminal line `v: [resource_exhausted] Error` and process exit code `1`

### 1.3 Tool call variants observed

1. `shellToolCall`
2. `readToolCall`
3. `editToolCall`
4. `grepToolCall`
5. `globToolCall`

Tool completion outcomes observed:

1. `result.success`
2. `result.failure` (non-zero exit, stderr)
3. `result.rejected` (permission denied by Cursor approval layer)

### 1.4 Critical protocol quirks

1. `tool_call.call_id` contains embedded newline characters (must sanitize for IDs).
2. Startup failures are plain text, not JSON:
   - invalid model -> plain error + exit `1`
   - invalid API key -> plain warning + exit `1`
3. `result.subtype` can be `success` even when tool calls failed/rejected inside the turn.
4. Running multiple `agent` commands concurrently can race on `~/.cursor/cli-config.json` writes (`ENOENT rename ...cli-config.json.tmp` observed).

Fixtures recorded in repo:

1. `.tmp/cursor-observations/*.ndjson`
2. `.tmp/cursor-observations/startup-invalid-*.txt`

---

## 2) Integration Constraints for T3

1. T3 requires adapter contract support for:
   - `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `readThread`, `rollbackThread`, `stopSession`, `listSessions`, `hasSession`, `stopAll`, `streamEvents`.
2. Orchestration depends on canonical runtime events (`ProviderRuntimeEvent`) only.
3. Current `ProviderCommandReactor` ignores `thread.turn-start-requested.payload.provider` and prefers existing provider/session; this must be fixed for reliable provider selection (including Cursor).
4. Cursor CLI currently has no external approval callback API; approvals are internal to CLI behavior.

---

## 3) Proposed Architecture

## 3.1 New server components

1. `apps/server/src/provider/Services/CursorAdapter.ts` (service contract/tag only for DI parity)
2. `apps/server/src/provider/Layers/CursorAdapter.ts` (single implementation unit; owns Cursor process lifecycle + stream parsing + runtime projection)
3. No separate `cursorCliManager.ts` abstraction in v1.

### 3.2 Session model

1. T3 `ProviderSessionId` = synthetic UUID managed by adapter (stable for T3 APIs).
2. Cursor chat UUID stored as:
   - `ProviderSession.resumeCursor = { chatId: string }`
   - `ProviderSession.threadId = ProviderThreadId(chatId)` for adapter contract compatibility.
3. Adapter keeps runtime map:
   - `sessionId -> { chatId, cwd, model, activeChildProcess?, activeTurnId?, turnLog }`

### 3.3 Command strategy

1. `startSession`:
   - call `agent create-chat` unless `resumeCursor.chatId` exists.
   - validate provider is `cursor` when provided.
2. `sendTurn`:
   - spawn `agent -p --trust --output-format stream-json --stream-partial-output --resume <chatId>`.
   - add `--model` when provided.
   - map runtime mode:
     - `approvalPolicy = never` -> include `--force`
     - otherwise omit `--force` (commands may be rejected by CLI).
   - use `--workspace <cwd>` when available.
3. `interruptTurn`:
   - terminate active child process for session (`SIGINT` then hard kill fallback).

### 3.4 Effect-first implementation style (required)

1. Keep adapter logic inside `CursorAdapterLive` layer constructor (no manager indirection).
2. Use Effect process primitives first:
   - `ChildProcessSpawner` + `ChildProcess.make` from `effect/unstable/process` for `agent` execution.
3. Use Effect concurrency/state primitives:
   - `Queue` for adapter event queue, `Stream.fromQueue` for `streamEvents`
   - `Ref` / `Ref.Synchronized` for session maps and active-turn process handles
   - `Effect.scoped` + `Effect.forkScoped` for worker fibers and cleanup
4. Use Effect stream parsing path for stdout/stderr:
   - decode bytes -> line buffer -> JSON parse -> typed projection
   - keep non-JSON lines on a fallback branch that emits `runtime.error`
5. Keep errors in typed adapter error algebra (`ProviderAdapter*Error`) via `Effect.mapError` boundaries, not ad-hoc exceptions.

---

## 4) Canonical Event Mapping Plan

For each parsed NDJSON line, emit zero or more `ProviderRuntimeEvent`s:

1. `system/init`
   - emit `session.started` (once per adapter session lifecycle)
   - emit `thread.started` if thread not yet emitted
2. `assistant` partial chunks
   - emit `message.delta` with stable per-turn synthetic `itemId`
3. final `assistant` message
   - emit `message.completed`
4. `tool_call/started`
   - emit `tool.started`
   - map kind:
     - shell -> `command`
     - edit -> `file-change`
     - read/grep/glob -> `other`
5. `tool_call/completed`
   - emit `tool.completed`
   - include summary detail from nested payload (`command`, `path`, stderr fragment, rejection reason)
6. `thinking/*`
   - initial version: ignore for canonical events (optional later: map to `tool.*` “Thinking”)
7. `result/success`
   - emit `turn.completed` with `status: completed` unless unrecoverable parse/process error already set failure
8. non-JSON stdout/stderr protocol line
   - emit `runtime.error`
   - emit `turn.completed` with `status: failed`
9. `connection/*` + `retry/*` (when present)
   - emit `tool.started/completed` with `toolKind: other`, title like “Connection retry”
   - if final failure follows, also emit `runtime.error`

Synthetic IDs:

1. `turnId`: adapter-generated UUID per `sendTurn`.
2. `itemId`: `${turnId}:assistant` for assistant stream; `${turnId}:${sanitizedCallId}` for tool calls.
3. `call_id` sanitization: replace whitespace (including newline) with `_`.

---

## 5) Approval and Checkpoint Behavior (explicit limitations)

### 5.1 Approvals

1. Cursor CLI approval is internal; adapter cannot accept/reject mid-turn via `respondToRequest`.
2. Plan for v1:
   - `respondToRequest` returns `ProviderAdapterRequestError` (“Cursor CLI does not expose external approval response API”).
   - approval-required runtime uses no `--force`, so dangerous commands become `tool_call.result.rejected`.
3. Future:
   - if Cursor exposes approval RPC/hooks, implement `approval.requested` + `approval.resolved` fully.

### 5.2 Rollback / thread read

1. Cursor CLI has no observed equivalent to `thread/read` or `thread/rollback`.
2. Plan for v1:
   - `readThread` returns adapter-maintained in-memory turn snapshot.
   - `rollbackThread` returns `ProviderAdapterRequestError` unsupported.
3. Product guard:
   - disable checkpoint revert for Cursor threads until rollback is implemented.

---

## 6) Required Contract and Runtime Changes

## 6.1 Contracts

1. `packages/contracts/src/orchestration.ts`
   - add `cursor` to `ProviderKind`.
2. `packages/contracts/src/provider.ts`
   - add `CursorProviderStartOptions` under `providerOptions.cursor`:
     - `binaryPath?`
     - `apiKey?` (optional; default login auth)
     - `trust?` (default true for headless)
3. `packages/contracts/src/model.ts`
   - add `cursor` provider model options baseline.
   - initial set should mirror observed supported IDs that are stable enough for UX.
4. Update related contract tests.

## 6.2 Server orchestration and registry

1. Add `CursorAdapter` to provider registry and server layer wiring.
2. Update provider-kind decoding in:
   - `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
   - persistence schemas that currently literal-match provider kinds.
3. Fix provider selection in `ProviderCommandReactor`:
   - honor `thread.turn-start-requested.payload.provider` as highest precedence.
   - fallback to existing session provider, then default.

## 6.3 Web

1. Enable Cursor in provider selector (`apps/web/src/session-logic.ts`).
2. Add Cursor label/icon treatment.
3. Add optional Cursor settings fields if using per-user overrides (binary path/api key).
4. Ensure thread/provider display and legacy mapping code handles `cursor`.

---

## 7) Implementation Phases

### Phase A: Protocol-safe adapter skeleton

1. Implement `CursorAdapter` service/layer with all runtime logic in `CursorAdapterLive` (no CLI manager), plus session map + event queue.
2. Implement robust NDJSON parser with:
   - line buffering
   - tolerant non-JSON handling
   - explicit process-exit mapping.
3. Wire into registry and server layers.

### Phase B: Event projection completeness

1. Map assistant/tool/result events to canonical runtime events.
2. Add synthetic ID strategy and item lifecycle consistency.
3. Add runtime error and retry handling.

### Phase C: Provider selection and UX

1. Fix `ProviderCommandReactor` provider precedence.
2. Enable Cursor provider in web UI.
3. Add Cursor model defaults/options.

### Phase D: Safeguards and unsupported surfaces

1. Explicit unsupported errors for `respondToRequest` and `rollbackThread` (v1).
2. Guard checkpoint-revert path for Cursor threads.
3. Document limitations in UI/help text.

---

## 8) Test Plan

Follow project rule: backend external-service integrations tested via layered fakes, not by mocking core business logic.

### 8.1 Unit tests (`CursorAdapter`)

1. stream JSON parse and mapping:
   - assistant partial/final
   - each tool type
   - shell success/failure/rejected
   - non-JSON line failure
2. process lifecycle:
   - start/send/interrupt/stop
   - stale session errors
3. ID sanitization:
   - `call_id` with newline.

### 8.2 Provider service/routing tests

1. Registry resolves `cursor`.
2. Session directory persistence reads/writes `cursor` provider.
3. ProviderService fan-out/order with Cursor events.

### 8.3 Orchestration tests

1. `thread.turn.start` with `provider: cursor` routes to Cursor adapter.
2. checkpoint revert on Cursor thread returns controlled failure activity.
3. approval response command on Cursor session surfaces “unsupported approval API”.

### 8.4 Smoke/integration harness

1. Optional local smoke behind env flag (`CURSOR_SMOKE=1`) to run real `agent`:
   - create session
   - send simple turn
   - verify message delta/completion + turn completion.

---

## 9) Operational Notes

1. Do not run concurrent `agent` processes per workspace by default; serialize per adapter session to avoid config races.
2. Keep native event NDJSON logs for Cursor similar to Codex adapter logs.
3. Treat startup plain-text failures as process-level errors and surface full message.

---

## 10) Open Questions

1. Should Cursor provider expose full model list dynamically (`agent --list-models`) or use curated static list in contracts?
2. Should T3 keep strict approval UX parity with Codex, or accept Cursor’s current non-interactive approval limitation in v1?
3. Is checkpoint revert required for initial Cursor release, or can it ship as explicitly unsupported?

---

## 11) Delivery Checklist

1. Contracts updated (`ProviderKind`, provider start options, models).
2. Cursor adapter + layer implemented and registered.
3. Provider selection precedence fixed in `ProviderCommandReactor`.
4. Cursor enabled in web provider picker.
5. Tests added for adapter mapping, routing, and orchestration behavior.
6. Lint + test suite green.
