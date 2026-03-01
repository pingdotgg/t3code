# Plan: Cursor ACP (`agent acp`) Provider Integration

## Goal

Add Cursor as a first-class provider in T3 Code using ACP (`agent acp`) over JSON-RPC 2.0 stdio, with robust session lifecycle handling and canonical `ProviderRuntimeEvent` projection.

---

## 1) Exploration Findings (from live ACP probes)

### 1.1 Core invocation and transport

1. Binary is `agent` on PATH (`2026.02.27-e7d2ef6` observed).
2. ACP server command is `agent acp`.
3. Transport is newline-delimited JSON-RPC 2.0 over stdio.
4. Messages:
   - client -> server: requests and responses to server-initiated requests
   - server -> client: responses, notifications (`session/update`), and server requests (`session/request_permission`)

### 1.2 Handshake and session calls observed

1. `initialize` returns:
   - `protocolVersion`
   - `agentCapabilities` (`loadSession`, `mcpCapabilities`, `promptCapabilities`)
   - `authMethods` (includes `cursor_login`)
2. `authenticate { methodId: "cursor_login" }` returns `{}` when logged in.
3. `session/new` returns:
   - `sessionId`
   - `modes` (`agent`, `plan`, `ask`)
4. `session/load` works and requires `sessionId`, `cwd`, `mcpServers`.
5. `session/prompt` returns terminal response `{ stopReason: "end_turn" | "cancelled" }`.

Important sequence note:
1. ACP currently allows `session/new` even without explicit `initialize`/`authenticate` when local auth already exists.
2. For adapter consistency and forward compatibility, we should still send `initialize` and `authenticate` during startup.

### 1.3 `session/update` event families observed

Observed `params.update.sessionUpdate` values:

1. `available_commands_update`
2. `agent_thought_chunk`
3. `agent_message_chunk`
4. `tool_call`
5. `tool_call_update`

Observed payload behavior:

1. `agent_*_chunk` provides `content: { type: "text", text: string }`.
2. `tool_call` may be emitted multiple times for same `toolCallId`:
   - initial generic form (`title: "Terminal"`, `rawInput: {}`)
   - enriched form (`title: "\`pwd\`"`, `rawInput: { command: "pwd" }`)
3. `tool_call_update` statuses observed:
   - `in_progress`
   - `completed`
4. `tool_call_update` on completion may include `rawOutput`:
   - terminal: `{ exitCode, stdout, stderr }`
   - search/find: `{ totalFiles, truncated }`

### 1.4 Permission flow observed

1. ACP server sends `session/request_permission` (JSON-RPC request with `id`).
2. Request shape includes:
   - `params.sessionId`
   - `params.toolCall`
   - `params.options` (`allow-once`, `allow-always`, `reject-once`)
3. Client must respond on same `id` with:
   - `{ outcome: { outcome: "selected", optionId: "<one-option-id>" } }`
4. Reject path still results in tool lifecycle completion events (`tool_call_update status: completed`), typically without `rawOutput`.

### 1.5 Error and capability quirks

1. `session/cancel` currently returns:
   - JSON-RPC error `-32601` Method not found
2. Error shape examples:
   - unknown auth method: `-32602`
   - `session/load` missing/invalid params: `-32602`
   - `session/prompt` unknown session: `-32603` with details
3. Parallel prompts on same session are effectively single-flight:
   - second prompt can cause first to complete with `stopReason: "cancelled"`.
4. `session/new` accepts a `model` field (no explicit echo in response).

Probe artifacts:
1. `.tmp/acp-probe/*/transcript.ndjson`
2. `.tmp/acp-probe/*/summary.json`
3. `scripts/cursor-acp-probe.mjs`

---

## 2) Integration Constraints for T3

1. T3 adapter contract still requires:
   - `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `readThread`, `rollbackThread`, `stopSession`, `listSessions`, `hasSession`, `stopAll`, `streamEvents`.
2. Orchestration consumes canonical `ProviderRuntimeEvent` only.
3. `ProviderCommandReactor` provider precedence fix remains required (respect explicit provider on turn start).
4. ACP now supports external permission decisions, so Cursor can participate in T3 approval UX via adapter-managed request/response plumbing.

---

## 3) Proposed Architecture

### 3.1 New server components

1. `apps/server/src/provider/Services/CursorAdapter.ts` (service contract/tag + ACP event schemas).
2. `apps/server/src/provider/Layers/CursorAdapter.ts` (single implementation unit; owns ACP process lifecycle, JSON-RPC routing, runtime projection).
3. No manager indirection; keep logic in layer implementation.

### 3.2 Session model

1. One long-lived ACP child process per T3 Cursor provider session.
2. Track:
   - `providerSessionId` (T3 synthetic ID)
   - `acpSessionId` (from `session/new` or restored via `session/load`)
   - `cwd`, `model`, in-flight turn state
   - pending permission requests by JSON-RPC request id
3. Resume support:
   - persist `acpSessionId` in provider resume metadata and call `session/load` on reattach.

### 3.3 Command strategy

1. `startSession`:
   - spawn `agent acp`
   - `initialize`
   - `authenticate(cursor_login)` (best-effort, typed failure handling)
   - `session/new` or `session/load`
2. `sendTurn`:
   - send `session/prompt { sessionId, prompt: [...] }`
   - consume streaming `session/update` notifications until terminal prompt response
3. `interruptTurn`:
   - no native `session/cancel` today; implement fallback:
     - terminate ACP process + restart + `session/load` for subsequent turns
     - mark in-flight turn as interrupted/failed in canonical events
4. `respondToRequest`:
   - map T3 approval decision -> ACP `optionId`
   - reply to exact JSON-RPC request id from `session/request_permission`

### 3.4 Effect-first implementation style (required)

1. Keep logic inside `CursorAdapterLive`.
2. Use Effect primitives:
   - `Queue` + `Stream.fromQueue` for event fan-out
   - `Ref` / `Ref.Synchronized` for session/process/request state
   - scoped fibers for stdout/stderr read loops
3. Typed JSON decode at boundary:
   - request/response envelopes
   - `session/update` union schema
   - permission-request schema
4. Keep adapter errors in typed error algebra with explicit mapping at process/protocol boundaries.

---

## 4) Canonical Event Mapping Plan (ACP -> ProviderRuntimeEvent)

1. `session/update: agent_message_chunk`
   - emit `message.delta` for assistant stream
2. prompt terminal response (`session/prompt` result `stopReason: end_turn`)
   - emit `message.completed` + `turn.completed`
3. `session/update: agent_thought_chunk`
   - initial mapping: emit thinking activity (or ignore if we keep current canonical surface minimal)
4. `session/update: tool_call`
   - first-seen `toolCallId` emits `tool.started`
   - subsequent `tool_call` for same ID treated as metadata update (no duplicate started event)
5. `session/update: tool_call_update`
   - `in_progress`: optional progress activity
   - `completed`: emit `tool.completed` with summarized `rawOutput` when present
6. `session/request_permission`
   - emit `approval.requested` with mapped options
   - when client decision sent, emit `approval.resolved`
7. protocol/process error
   - emit `runtime.error`
   - fail active turn/session as appropriate

Synthetic IDs:
1. `turnId`: T3-generated UUID per `sendTurn`.
2. `itemId`:
   - assistant stream: `${turnId}:assistant`
   - tools: `${turnId}:${toolCallId}`

---

## 5) Approval, Resume, and Rollback Behavior

### 5.1 Approvals

1. Cursor ACP permission requests are externally controllable; implement full `respondToRequest` path in v1.
2. Decision mapping:
   - allow once -> `allow-once`
   - allow always -> `allow-always`
   - reject -> `reject-once`

### 5.2 Resume

1. `session/load` is available and should be first-class for adapter restart/reconnect.
2. Must send required params: `sessionId`, `cwd`, `mcpServers`.

### 5.3 Rollback / thread read

1. ACP currently has no observed rollback API.
2. Plan for v1:
   - `readThread`: adapter-maintained snapshot projection
   - `rollbackThread`: explicit unsupported error
3. Product guard:
   - disable checkpoint revert for Cursor threads in UI until rollback exists.

---

## 6) Required Contract and Runtime Changes

### 6.1 Contracts

1. Add `cursor` to `ProviderKind`.
2. Add Cursor provider start options (`providerOptions.cursor`), ACP-oriented:
   - optional `binaryPath`
   - optional auth/mode knobs if needed later
3. Extend model options for Cursor list and traits mapping.
4. Add schemas for ACP-native event union in Cursor adapter service file.

### 6.2 Server orchestration and registry

1. Register `CursorAdapter` in provider registry and server layer wiring.
2. Update provider-kind persistence decoding for `cursor`.
3. Fix `ProviderCommandReactor` precedence to honor explicit provider in turn-start command.

### 6.3 Web

1. Cursor in provider picker and model picker (already partially done).
2. Trait controls map to concrete Cursor model identifiers.
3. Surface unsupported rollback behavior in UX.

---

## 7) Implementation Phases

### Phase A: ACP process and protocol skeleton

1. Implement ACP process lifecycle in `CursorAdapterLive`.
2. Implement JSON-RPC request/response multiplexer.
3. Implement `initialize`/`authenticate`/`session/new|load` flow.
4. Wire `streamEvents` from ACP notifications.

### Phase B: Runtime projection and approvals

1. Map `session/update` variants to canonical runtime events.
2. Implement permission-request bridging to `respondToRequest`.
3. Implement dedupe for repeated `tool_call` on same `toolCallId`.

### Phase C: Turn control and interruption

1. Implement single in-flight prompt protection per session.
2. Implement interruption fallback (process restart + reload) because `session/cancel` unavailable.
3. Ensure clean state recovery on ACP process crash.

### Phase D: Orchestration + UX polish

1. Provider routing precedence fix.
2. Cursor-specific UX notes for unsupported rollback.
3. End-to-end smoke and event log validation.

---

## 8) Test Plan

Follow project rule: backend external-service integrations tested via layered fakes, not by mocking core business logic.

### 8.1 Unit tests (`CursorAdapter`)

1. JSON-RPC envelope parsing:
   - response matching by id
   - server request handling (`session/request_permission`)
   - notification decode (`session/update`)
2. Event projection:
   - `agent_message_chunk` / `agent_thought_chunk`
   - `tool_call` + `tool_call_update` dedupe/lifecycle
   - permission request -> approval events
3. Error mapping:
   - unknown session
   - method-not-found (`session/cancel`)
   - invalid params

### 8.2 Provider service/routing tests

1. Registry resolves `cursor`.
2. Session directory persistence reads/writes `cursor`.
3. ProviderService fan-out ordering with Cursor ACP events.

### 8.3 Orchestration tests

1. `thread.turn.start` with `provider: cursor` routes to Cursor adapter.
2. approval response command maps to ACP permission response.
3. checkpoint revert on Cursor thread returns controlled unsupported failure.

### 8.4 Optional live smoke

1. Env-gated ACP smoke:
   - start session
   - run prompt
   - observe deltas + completion
   - exercise permission request path with one tool call

---

## 9) Operational Notes

1. Keep one in-flight turn per ACP session.
2. Keep per-session ACP process logs/NDJSON artifacts for debugging.
3. Treat `session/cancel` as unsupported until Cursor ships it; avoid relying on it.
4. Preserve resume metadata (`acpSessionId`) for crash recovery.

---

## 10) Open Questions

1. Should we call `authenticate` always, or only after auth-required errors?
2. Should model selection be passed at `session/new` only, or can/should we support model switching mid-session if ACP adds API?
3. For interruption UX, do we expose “hard interrupt” semantics (process restart) explicitly?

---

## 11) Delivery Checklist

1. Plan/documentation switched from headless `agent -p` to ACP `agent acp`.
2. Contracts updated (`ProviderKind`, Cursor options, model/trait mapping).
3. Cursor ACP adapter layer implemented and registered.
4. Provider precedence fixed in orchestration router.
5. Approval response path wired through ACP permission requests.
6. Tests added for protocol decode, projection, approval flow, and routing.
7. Lint + tests green.
