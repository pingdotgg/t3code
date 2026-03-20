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

1. `apps/server/src/provider/Services/ClaudeAdapter.ts`
2. `apps/server/src/provider/Layers/ClaudeAdapter.ts`

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
const sdkMessageStream = Stream.async<ClaudeSdkMessage, ProviderAdapterProcessError>((emit) => {
  let cancelled = false;
  void (async () => {
    try {
      for await (const message of session.result) {
        if (cancelled) break;
        emit.single(message);
      }
      emit.end();
    } catch (cause) {
      emit.fail(
        new ProviderAdapterProcessError({
          provider: "claudeCode",
          sessionId,
          detail: "Claude runtime stream failed.",
          cause,
        }),
      );
    }
  })();
  return Effect.sync(() => {
    cancelled = true;
  });
});
```

### 2.3 Canonical event mapping

Claude adapter must translate Agent SDK output into canonical `ProviderRuntimeEvent`.

Initial mapping target:

1. assistant text deltas -> `content.delta`
2. final assistant text -> `item.completed` and/or `turn.completed`
3. approval requests -> `request.opened`
4. approval results -> `request.resolved`
5. system lifecycle -> `session.*`, `thread.*`, `turn.*`
6. errors -> `runtime.error`
7. plan/proposed-plan content when derivable

Implementation note:

1. Keep raw Claude message on `raw` for debugging.
2. Prefer canonical item/request kinds over provider-native enums.
3. If Claude emits extra event kinds we do not model yet, map them to `tool.summary`, `runtime.warning`, or `unknown`-compatible payloads instead of dropping silently.

### 2.4 Resume cursor strategy

Define Claude-owned opaque resume state, e.g.:

```ts
interface ClaudeResumeCursor {
  readonly version: 1;
  readonly threadId?: string;
  readonly sessionAt?: string;
}
```

Rules:

1. Serialize only adapter-owned state into `resumeCursor`.
2. Parse/validate only inside Claude adapter.
3. Store updated cursor when Claude runtime yields enough data to resume safely.
4. Never overload orchestration thread id as Claude thread id.

### 2.5 Interrupt and stop semantics

Map orchestration stop/interrupt expectations onto SDK controls:

1. `interruptTurn()` -> active query interrupt.
2. `stopSession()` -> close session resources and prevent future sends.
3. `rollbackThread()` -> see Phase 4.

---

## Phase 3: Provider service and composition

### 3.1 Register Claude adapter

Update provider registry layer to include Claude:

1. add `claudeCode` -> `ClaudeAdapter`
2. ensure `ProviderService.listProviderStatuses()` reports Claude availability

### 3.2 Persist provider binding

Current `ProviderSessionDirectory` already stores provider/thread binding and opaque `resumeCursor`.

Required validation:

1. Claude bindings survive restart.
2. resume cursor remains opaque and round-trips untouched.
3. stopAll + restart can recover Claude sessions when possible.

### 3.3 Provider start routing

Update `ProviderCommandReactor` / orchestration flow:

1. If a thread turn start requests `provider: "claudeCode"`, start Claude if no active session exists.
2. If a thread already has Claude session binding, reuse it.
3. If provider switches between Codex and Claude, explicitly stop/rebind before next send.

---

## Phase 4: Checkpoint and revert strategy

Claude does not necessarily expose the same conversation rewind primitive as Codex app-server. Current architecture expects `providerService.rollbackConversation()`.

Pick one explicit strategy:

### Option A: provider-native rewind

If SDK/runtime supports safe rewind:

1. implement in Claude adapter
2. keep `CheckpointReactor` unchanged

### Option B: session restart + state truncation shim

If no native rewind exists:

1. Claude adapter returns successful rollback by:
   - stopping current Claude session
   - clearing/rewriting stored Claude resume cursor to last safe resumable point
   - forcing next turn to recreate session from persisted orchestration state
2. Document that rollback is “conversation reset to checkpoint boundary”, not provider-native turn deletion.

Whichever option is chosen:

1. behavior must be deterministic
2. checkpoint revert tests must pass under orchestration expectations
3. user-visible activity log should explain failures clearly when provider rollback is impossible

---

## Phase 5: Web integration

### 5.1 Provider picker and model picker

Update web state/UI:

1. allow choosing Claude as thread provider before first turn
2. show Claude model list from provider-aware model helpers
3. preserve existing Codex default behavior when provider omitted

Likely touch points:

1. `apps/web/src/store.ts`
2. `apps/web/src/components/ChatView.tsx`
3. `apps/web/src/types.ts`
4. `packages/shared/src/model.ts`

### 5.2 Settings for Claude executable/options

Add app settings if needed for:

1. Claude binary path
2. default permission mode
3. default max thinking tokens

Do not hardcode provider-specific config into generic session state if it belongs in app settings or typed `providerOptions`.

### 5.3 Session rendering

No new WS channel should be needed. Claude should appear through existing:

1. thread messages
2. activities/worklog
3. approvals
4. session state
5. checkpoints/diffs

---

## Phase 6: Testing strategy

### 6.1 Contract tests

Cover:

1. provider-aware model schemas
2. provider field on turn-start command
3. provider-specific start options schema

### 6.2 Adapter layer tests

Add `ClaudeAdapter.test.ts` covering:

1. session start
2. event mapping
3. approval bridge
4. resume cursor parse/serialize
5. interrupt behavior
6. rollback behavior or explicit unsupported error path

Use SDK-facing layer tests/mocks only at the boundary. Do not mock orchestration business logic in higher-level tests.

### 6.3 Provider service integration tests

Extend provider integration coverage so Claude is exercised through `ProviderService`:

1. start Claude session
2. send turn
3. receive canonical runtime events
4. restart/recover using persisted binding

### 6.4 Orchestration integration tests

Add/extend integration tests around:

1. first-turn provider selection
2. Claude approval requests routed through orchestration
3. Claude runtime ingestion -> messages/activities/session updates
4. checkpoint revert behavior under Claude
5. stopAll/restart recovery

These should validate real orchestration flows, not just adapter behavior.

---

## Phase 7: Rollout order

Recommended implementation order:

1. contracts/provider-aware models
2. provider field on turn-start
3. Claude adapter skeleton + start/send/stream
4. canonical event mapping
5. provider registry/service wiring
6. orchestration recovery + checkpoint strategy
7. web provider/model picker
8. full integration tests

---

## Non-goals

1. Reintroducing provider-specific WS methods/channels.
2. Storing provider-native thread ids as orchestration ids.
3. Bypassing orchestration engine for Claude-specific UI flows.
4. Encoding Claude resume semantics outside adapter-owned `resumeCursor`.
