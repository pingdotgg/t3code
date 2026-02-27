# Plan: Claude Code Integration (Orchestration Architecture)

## Why this plan was rewritten

The previous plan targeted a pre-orchestration architecture (`ProviderManager`, provider-native WS event methods, and direct provider UI wiring). The current app now routes everything through:

1. `orchestration.dispatchCommand` (client intent)
2. `OrchestrationEngine` (decide + persist + publish domain events)
3. `ProviderCommandReactor` (domain intent -> `ProviderService`)
4. `ProviderService` (adapter routing + canonical runtime stream)
5. `ProviderRuntimeIngestion` (provider runtime -> internal orchestration commands)
6. `orchestration.domainEvent` (single push channel consumed by web)

Claude integration must plug into this path instead of reintroducing legacy provider-specific flows.

---

## Current constraints to design around (post-Stage 1)

1. Provider runtime ingestion expects canonical `ProviderRuntimeEvent` shapes, not provider-native payloads.
2. Start input now uses typed `providerOptions` and generic `resumeCursor`; top-level provider-specific fields were removed.
3. `resumeCursor` is intentionally opaque outside adapters and must never be synthesized from `providerThreadId`.
4. `ProviderService` still requires adapter `startSession()` to return a `ProviderSession` with `threadId`.
5. Checkpoint revert currently calls `providerService.rollbackConversation()`, so Claude adapter needs a rollback strategy compatible with current reactor behavior.
6. Web currently marks Claude as unavailable (`"Claude Code (soon)"`) and model picker is Codex-only.

---

## Architecture target

Add Claude as a first-class provider adapter that emits canonical runtime events and works with existing orchestration reactors without adding new WS channels or bypass paths.

Key decisions:

1. Keep orchestration provider-agnostic; adapt Claude inside adapter/layer boundaries.
2. Use the existing canonical runtime stream (`ProviderRuntimeEvent`) as the only ingestion contract.
3. Keep provider session routing in `ProviderService` and `ProviderSessionDirectory`.
4. Add explicit provider selection to turn-start intent so first turn can start Claude session intentionally.

---

## Phase 1: Contracts and command shape updates

### 1.1 Provider-aware model contract

Update `packages/contracts/src/model.ts` so model resolution can be provider-aware instead of Codex-only.

Expected outcomes:

1. Introduce provider-scoped model lists (Codex + Claude).
2. Add helpers that resolve model by provider.
3. Preserve backwards compatibility for existing Codex defaults.

### 1.2 Turn-start provider intent

Update `packages/contracts/src/orchestration.ts`:

1. Add optional `provider: ProviderKind` to `ThreadTurnStartCommand`.
2. Carry provider through `ThreadTurnStartRequestedPayload`.
3. Keep existing command valid when provider is omitted.

This removes the implicit “Codex unless session already exists” behavior as the only path.

### 1.3 Provider session start input for Claude runtime knobs (completed)

Update `packages/contracts/src/provider.ts`:

1. Move provider-specific start fields into typed `providerOptions`:
   - `providerOptions.codex`
   - `providerOptions.claudeCode`
2. Keep `resumeCursor` as the single cross-provider resume input in `ProviderSessionStartInput`.
3. Deprecate/remove `resumeThreadId` from the generic start contract.
4. Treat `resumeCursor` as adapter-owned opaque state.

### 1.4 Contract tests (completed)

Update/add tests in `packages/contracts/src/*.test.ts` for:

1. New command payload shape.
2. Provider-aware model resolution behavior.
3. Breaking-change expectations for removed top-level provider fields.

---

## Phase 2: Claude adapter implementation

### 2.1 Add adapter service + layer

Create:

1. `apps/server/src/provider/Services/ClaudeCodeAdapter.ts`
2. `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`

Adapter must implement `ProviderAdapterShape<ProviderAdapterError>`.

### 2.1.a SDK dependency and baseline config

Add server dependency:

1. `@anthropic-ai/claude-agent-sdk`

Baseline adapter options to support from day one:

1. `cwd`
2. `model`
3. `pathToClaudeCodeExecutable` (from `providerOptions.claudeCode.binaryPath`)
4. `permissionMode` (from `providerOptions.claudeCode.permissionMode`)
5. `maxThinkingTokens` (from `providerOptions.claudeCode.maxThinkingTokens`)
6. `resume`
7. `resumeSessionAt`
8. `includePartialMessages`
9. `canUseTool`
10. `hooks`
11. `env` and `additionalDirectories` (if needed for sandbox/workspace parity)

### 2.2 Claude runtime bridge

Implement a Claude runtime bridge (either directly in adapter layer or via dedicated manager file) that wraps Agent SDK query lifecycle.

Required capabilities:

1. Long-lived session context per adapter session.
2. Multi-turn input queue.
3. Interrupt support.
4. Approval request/response bridge.
5. Resume support via opaque `resumeCursor` (parsed inside Claude adapter only).

#### 2.2.a Agent SDK details to preserve

The adapter should explicitly rely on these SDK capabilities:

1. `query()` returns an async iterable message stream and control methods (`interrupt`, `setModel`, `setPermissionMode`, `setMaxThinkingTokens`, account/status helpers).
2. Multi-turn input is supported via async-iterable prompt input.
3. Tool approval decisions are provided via `canUseTool`.
4. Resume support uses `resume` and optional `resumeSessionAt`, both derived by parsing adapter-owned `resumeCursor`.
5. Hooks can be used for lifecycle signals (`Stop`, `PostToolUse`, etc.) when we need adapter-originated checkpoint/runtime events.

#### 2.2.b Effect-native session lifecycle skeleton

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

const acquireSession = (input: ProviderSessionStartInput) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const claudeOptions = input.providerOptions?.claudeCode;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const abortController = new AbortController();
        const result = query({
          prompt: makePromptAsyncIterable(),
          options: {
            cwd: input.cwd,
            model: input.model,
            permissionMode: claudeOptions?.permissionMode,
            maxThinkingTokens: claudeOptions?.maxThinkingTokens,
            pathToClaudeCodeExecutable: claudeOptions?.binaryPath,
            resume: resumeState?.threadId,
            resumeSessionAt: resumeState?.sessionAt,
            signal: abortController.signal,
            includePartialMessages: true,
            canUseTool: makeCanUseTool(),
            hooks: makeClaudeHooks(),
          },
        });
        return { abortController, result };
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: "claudeCode",
          sessionId: "pending",
          detail: "Failed to start Claude runtime session.",
          cause,
        }),
    }),
    ({ abortController }) => Effect.sync(() => abortController.abort()),
  );
```

#### 2.2.c AsyncIterable -> Effect Stream integration

Preferred when available in the pinned Effect version:

```ts
const sdkMessageStream = Stream.fromAsyncIterable(
  session.result,
  (cause) =>
    new ProviderAdapterProcessError({
      provider: "claudeCode",
      sessionId,
      detail: "Claude runtime stream failed.",
      cause,
    }),
);
```

Portable fallback (already aligned with current server patterns):

```ts
const queue = yield* Queue.unbounded<ClaudeSdkMessage>();
yield* Effect.forkScoped(
  Effect.tryPromise({
    try: async () => {
      for await (const message of session.result) {
        Queue.offerAllUnsafe(queue, [message]);
      }
    },
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: "claudeCode",
        sessionId,
        detail: "Claude runtime stream pump failed.",
        cause,
      }),
  }),
);
const sdkMessageStream = Stream.fromQueue(queue);
```

#### 2.2.d Multi-turn prompt queue pattern (Effect)

Use an Effect queue as the single input boundary:

```ts
const promptQueue = yield* Queue.unbounded<ClaudePromptEnvelope>();

const prompt: AsyncIterable<ClaudePromptEnvelope> = {
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const item = await Effect.runPromise(Queue.take(promptQueue));
        if (item.type === "terminate") {
          return { done: true, value: undefined };
        }
        return { done: false, value: item };
      },
    };
  },
};
```

`sendTurn()` enqueues a user envelope, while `stopSession()` enqueues terminate and aborts.

#### 2.2.e Approval bridge with `canUseTool`

Map SDK approval checks to existing orchestration approval flows:

```ts
const canUseTool = async (toolName: string, toolInput: Record<string, unknown>) => {
  if (approvalModeIsFullAccess(sessionId)) {
    return { behavior: "allow", updatedInput: toolInput };
  }

  const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
  emitRuntimeEvent({
    type: "approval.requested",
    provider: "claudeCode",
    sessionId,
    requestId,
    requestKind: classifyTool(toolName),
    detail: summarizeToolRequest(toolName, toolInput),
    // ... eventId/createdAt
  });

  const decision = await waitForApprovalDecision(requestId);
  emitRuntimeEvent({
    type: "approval.resolved",
    provider: "claudeCode",
    sessionId,
    requestId,
    decision,
    // ... eventId/createdAt
  });

  return decision === "accept" || decision === "acceptForSession"
    ? { behavior: "allow", updatedInput: toolInput }
    : { behavior: "deny", message: "User declined tool execution." };
};
```

#### 2.2.f Hooks and checkpoint signals

If Claude hooks provide cleaner turn boundaries, convert them into canonical runtime events (`turn.completed` and optionally `checkpoint.captured`) so `CheckpointReactor` remains unchanged:

```ts
hooks: {
  Stop: [
    {
      matcher: {},
      hooks: [
        async () => {
          emitRuntimeEvent({
            type: "checkpoint.captured",
            provider: "claudeCode",
            sessionId,
            threadId,
            turnId: activeTurnId,
            turnCount: nextTurnCount(),
            // ... eventId/createdAt
          });
        },
      ],
    },
  ],
}
```

#### 2.2.g Runtime control method wiring

Adapter should expose SDK controls through existing service methods and runtime payload updates:

1. `interruptTurn()` -> `result.interrupt()`
2. Model override on send turn -> `result.setModel(model)` before enqueuing prompt
3. Runtime mode changes -> `result.setPermissionMode(mode)` if we support live mode switching
4. Thinking budget updates -> `result.setMaxThinkingTokens(tokens)` when configured

### 2.3 Canonical event mapping

Map Claude SDK events to `ProviderRuntimeEvent`:

1. `session.started` / `session.exited`
2. `turn.started` / `turn.completed`
3. `message.delta` / `message.completed`
4. `tool.started` / `tool.completed`
5. `approval.requested` / `approval.resolved`
6. `runtime.error`

No provider-native event methods should leak beyond the adapter boundary.

Reference mapping table:

| Claude SDK message/callback | Canonical runtime event(s) | Notes |
|---|---|---|
| assistant partial text | `message.delta` | Emit deltas only (do not resend full content each chunk). |
| assistant final message | `message.completed` | Must include stable `itemId` for dedupe/finalize behavior. |
| result (success) | `turn.completed` (`status: "completed"`) | This is the main turn boundary for checkpointing. |
| result (interrupted/cancelled) | `turn.completed` (`status: "interrupted"`/`"cancelled"`) | Preserve state semantics used by ingestion + UI. |
| result (error) | `runtime.error` and `turn.completed` (`status: "failed"`) | Include concise error message. |
| tool start | `tool.started` | Set `toolKind` using shared classifier (`command`, `file-change`, `other`). |
| tool result | `tool.completed` | Include detail summary used by activity feed. |
| canUseTool prompt | `approval.requested` | Source of request id shown in UI. |
| approval decision returned | `approval.resolved` | Must correlate using same request id. |
| session initialization | `session.started`, optional `thread.started` | Ensure `threadId` is emitted early and consistently. |
| process exit/close | `session.exited` | Required for session status projection cleanup. |

### 2.4 Session/thread/resume identifiers

Define explicit adapter semantics:

1. `sessionId`: adapter-owned stable session id.
2. `threadId`: Claude conversation/session identifier returned as `ProviderThreadId`.
3. `resumeCursor`: provider-specific cursor (for example thread id + message cursor) needed for precise recovery/rollback.
4. Orchestration/shared services persist and forward `resumeCursor` unchanged without provider-specific parsing.

### 2.5 Rollback/read strategy

Implement `readThread()` and `rollbackThread()` in a way compatible with `CheckpointReactor`.

Preferred:

1. Track per-turn resume cursors and reconstruct session state on rollback.
2. Keep adapter `sessionId` stable across internal rehydration/restart.

Fallback (explicitly documented if chosen):

1. Filesystem revert succeeds even when conversation rewind is partial.
2. Reactor behavior is updated to surface a clear warning activity instead of silent drift.

### 2.6 Adapter unit tests

Add tests mirroring Codex adapter coverage:

1. Provider validation (`provider === "claudeCode"`).
2. Event mapping to canonical runtime events.
3. Approval request lifecycle.
4. Resume/recovery behavior.
5. Rollback behavior.

---

## Phase 3: Register adapter in runtime composition

### 3.1 Adapter registry wiring

Update:

1. `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`

Register both Codex and Claude adapters.

### 3.2 Server layer composition

Update:

1. `apps/server/src/serverLayers.ts`

Provide `ClaudeCodeAdapterLive` alongside Codex in `makeServerProviderLayer()`.

### 3.3 Composition tests

Update integration tests to ensure:

1. Registry exposes Claude provider.
2. Provider service can route Claude sessions.

---

## Phase 4: Orchestration command/reactor updates

### 4.1 Decider propagation (completed)

Update `apps/server/src/orchestration/decider.ts`:

1. Carry optional `provider` from `thread.turn.start` command into `thread.turn-start-requested` event payload.
2. Keep this behavior provider-agnostic (no provider-specific runtime fields in the event payload).

### 4.2 ProviderCommandReactor provider selection

Update `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`:

1. Prefer provider from turn-start event payload when starting a new session.
2. Fallback to existing thread session provider when payload omitted.
3. Fallback to default provider only when neither is present.
4. On restart/rebind, forward the runtime session's persisted `resumeCursor` as-is (no reconstruction from `providerThreadId`).

Switch behavior policy (explicit in implementation):

1. If active session provider differs from requested provider, stop and recreate session before sending turn.
2. Keep current provider when request omits provider.

### 4.3 Reactor/invariant tests

Update/add tests in:

1. `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
2. `apps/server/src/orchestration/*.test.ts` as needed

Validate first-turn provider choice, provider switching semantics, and backward compatibility when provider is omitted.

---

## Phase 5: Web provider UX enablement

### 5.1 Enable Claude option

Update `apps/web/src/session-logic.ts`:

1. Mark Claude provider option as available.

### 5.2 Provider selection in composer

Update `apps/web/src/components/ChatView.tsx`:

1. Add provider picker near model/runtime controls.
2. Include selected provider in `thread.turn.start` command payload.
3. Keep selected provider sticky per thread in client state (or derive from active session provider when present).

### 5.3 Provider-aware model picker

Update model picker usage so model options reflect selected provider.

### 5.4 Web tests

Update/add tests for:

1. Provider picker interactions.
2. Turn-start command includes provider.
3. Model list switches by provider.

---

## Phase 6: Checkpoint and revert compatibility

### 6.1 Validate checkpoint reactor expectations

Exercise `apps/server/src/orchestration/Layers/CheckpointReactor.ts` flows with Claude:

1. Turn baseline capture.
2. Turn completion checkpoint capture.
3. Revert + provider rollback coordination.

### 6.2 Policy for partial rollback support

If Claude cannot support full conversation rewind at parity with Codex:

1. Document behavior clearly.
2. Emit explicit thread activity for degraded rollback behavior.
3. Ensure filesystem state remains correct and predictable.

### 6.3 Checkpoint tests

Add/update tests in checkpoint + provider service integration suites for Claude revert behavior.

---

## Phase 7: End-to-end hardening and observability

### 7.1 Integration tests

Add integration coverage for:

1. `thread.turn.start` with `provider: "claudeCode"` from fresh thread.
2. Session recovery after restart (provider session alias/recovery path).
3. Approval request/respond flow.
4. Interrupt behavior.
5. Revert flow with rollback.

### 7.2 WS behavior regression check

Ensure no contract regressions:

1. Client still consumes only `orchestration.domainEvent`.
2. No new provider-specific WS channels introduced.

### 7.3 Logging

Confirm both native and canonical provider logs remain useful with multi-adapter setup:

1. `provider-native.ndjson`
2. `provider-canonical.ndjson`

---

## File checklist

Likely remaining files to touch:

1. `apps/server/src/provider/Services/ClaudeCodeAdapter.ts` (new)
2. `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts` (new)
3. `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
4. `apps/server/src/serverLayers.ts`
5. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
6. `apps/web/src/session-logic.ts`
7. `apps/web/src/components/ChatView.tsx`
8. Related tests under `apps/server/src/provider/Layers`, `apps/server/src/orchestration/Layers`, `apps/server/integration`, and `apps/web/src`.

---

## Delivery order

1. Claude adapter + unit tests on top of the new `providerOptions`/opaque-cursor contracts.
2. Registry/layer wiring.
3. Remaining reactor updates for provider-aware session selection/switching invariants.
4. Web provider picker + provider-aware models.
5. Checkpoint/revert compatibility.
6. End-to-end integration tests and stabilization.

This order keeps risk isolated and maintains a working orchestrated path at each stage.
