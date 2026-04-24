# Provider Capability System

V2 must not assume every provider can do what Codex can do. Provider behavior should be expressed through capabilities and policies, not provider-name conditionals spread across orchestration.

## Capability Shape

```ts
type ProviderCapabilities = {
  sessions: SessionCapabilities;
  threads: ThreadCapabilities;
  turns: TurnCapabilities;
  streaming: StreamingCapabilities;
  tools: ToolCapabilities;
  approvals: ApprovalCapabilities;
  planning: PlanningCapabilities;
  subagents: SubagentCapabilities;
  context: ContextCapabilities;
  checkpointing: CheckpointCapabilities;
  identity: IdentityCapabilities;
};
```

Capabilities should be versioned and emitted by each adapter at session start.

## Session Capabilities

```ts
type SessionCapabilities = {
  supportsMultipleProviderThreadsPerSession: boolean;
  supportsModelSwitchInSession: boolean;
  supportsProviderSwitchingViaHandoff: boolean;
  supportsRuntimeModeSwitchInSession: boolean;
  pendingRequestsSurviveRestart: boolean;
};
```

Policy examples:

- If model switching is unsupported, start a new provider session.
- If pending requests do not survive restart, mark old requests `not_resumable`.

Provider-thread resumption is not a capability. It is a required adapter primitive. Adapters must be able to start from a stored provider cursor/session/thread handle or return a runtime resume failure.

## Thread Capabilities

```ts
type ThreadCapabilities = {
  canCreateEmptyThread: boolean;
  canReadThreadSnapshot: boolean;
  canRollbackThread: boolean;
  canForkThread: boolean;
  canForkFromTurn: boolean;
  canForkFromSubagentThread: boolean;
  exposesNativeThreadId: boolean;
};
```

Codex can expose strong thread ids and rollback snapshots. Claude may support native forking through its own model/session primitives. Other providers may only support synthetic app forks.

## Turn Capabilities

```ts
type TurnCapabilities = {
  exposesNativeTurnId: boolean;
  emitsTurnStarted: boolean;
  emitsTurnCompleted: boolean;
  supportsInterrupt: boolean;
  supportsActiveSteering: boolean;
  supportsSteeringByInterruptRestart: boolean;
  supportsQueuedMessages: boolean;
  terminalStatusQuality: "strong" | "weak" | "none";
};
```

If `terminalStatusQuality` is weak, V2 should use adapter policy to infer terminal state, but still mark correlation strength accordingly.

`supportsActiveSteering` means the provider can modify an in-flight turn directly. `supportsSteeringByInterruptRestart` means V2 can implement app-level steering by interrupting the active turn and starting a replacement attempt. Most providers should support the latter if they support interruption and normal follow-up turns.

## Streaming Capabilities

```ts
type StreamingCapabilities = {
  streamsAssistantText: boolean;
  streamsReasoning: boolean;
  streamsToolOutput: boolean;
  streamsPlanText: boolean;
  emitsMessageCompleted: boolean;
};
```

If message completion is not emitted, the normalizer closes assistant messages at root run terminal.

## Tool Capabilities

```ts
type ToolCapabilities = {
  exposesToolItemIds: boolean;
  emitsToolStarted: boolean;
  emitsToolCompleted: boolean;
  emitsToolOutput: boolean;
  supportsMcpTools: boolean;
  supportsDynamicToolCallbacks: boolean;
};
```

Weak providers may produce only textual tool summaries. The adapter can still create ordered `turnItems` and execution nodes by scoped ordinal.

## Approval Capabilities

```ts
type ApprovalCapabilities = {
  supportsCommandApproval: boolean;
  supportsFileReadApproval: boolean;
  supportsFileChangeApproval: boolean;
  supportsApplyPatchApproval: boolean;
  approvalsHaveNativeRequestIds: boolean;
  approvalCallbacksAreLiveOnly: boolean;
  approvalsCanOriginateFromSubagents: boolean;
};
```

The UI should show pending approvals from any execution node, including subagents, if they are respondable.

## Planning Capabilities

```ts
type PlanningCapabilities = {
  emitsPlanUpdated: boolean;
  emitsTodoList: boolean;
  emitsProposedPlan: boolean;
  supportsStructuredQuestions: boolean;
  planDeltasHaveItemIds: boolean;
};
```

Mapping policy:

- `emitsTodoList`: update live run progress.
- `emitsProposedPlan`: create accept/implementable plan artifacts.
- `supportsStructuredQuestions`: create respondable user-input requests.

If a provider only emits plain assistant text, the app should not pretend it has structured plans.

## Subagent Capabilities

```ts
type SubagentCapabilities = {
  supportsSubagents: boolean;
  exposesSubagentThreadIds: boolean;
  emitsSubagentLifecycle: boolean;
  canWaitForSubagents: boolean;
  canCloseSubagents: boolean;
  canForkSubagentThread: boolean;
};
```

When `exposesSubagentThreadIds` is true, subagent provider threads become addressable `ProviderThread` records. When false, subagents can still be shown as nested execution nodes if the provider exposes enough lifecycle information.

## Context Handoff Capabilities

Context handoff controls provider switching and provider-thread reconstruction.

```ts
type ContextCapabilities = {
  acceptsSystemContext: boolean;
  acceptsDeveloperContext: boolean;
  acceptsSyntheticUserContext: boolean;
  canGenerateSummaries: boolean;
  canConsumeHandoffSummaries: boolean;
  supportsDeltaHandoff: boolean;
  supportsFullThreadHandoff: boolean;
  maxRecommendedHandoffChars: number | null;
};
```

Policy examples:

- If `supportsDeltaHandoff` is available, return to a previous provider thread with a summary of only off-provider runs.
- If delta handoff is unsupported or low quality, create a new provider thread with a full thread summary.
- If the provider cannot accept explicit context, provider switching should require synthetic user context or be marked unsupported.
- If no provider can generate summaries, use the app's configured summarization provider or a local summarizer capability.

## Checkpoint Capabilities

Checkpointing is primarily app-owned, but provider conversation rollback is provider-dependent.

```ts
type CheckpointCapabilities = {
  appCanCheckpointFilesystem: boolean;
  supportsNestedCheckpointScopes: boolean;
  providerCanRollbackConversation: boolean;
  providerRollbackReturnsSnapshot: boolean;
  providerCanReadConversationSnapshot: boolean;
};
```

If provider rollback is unsupported, filesystem rollback can still happen, but provider conversation state must be restarted or marked divergent. Nested checkpoint scopes are app-owned; providers only affect whether their nested provider conversations can be rolled back to match restored filesystem state.

## Identity Capabilities

```ts
type IdentityCapabilities = {
  nativeThreadIds: "strong" | "weak" | "none";
  nativeTurnIds: "strong" | "weak" | "none";
  nativeItemIds: "strong" | "weak" | "none";
  nativeRequestIds: "strong" | "weak" | "none";
};
```

This controls how the normalizer correlates events:

- `strong`: use native id as scoped provider ref.
- `weak`: use native id plus ordinal/fingerprint.
- `none`: allocate by scoped ordinal.

## Degradation Policies

Every feature should declare what happens when capability is missing.

Examples:

```text
interrupt unsupported
  -> stop session if allowed, otherwise mark unsupported

active steering unsupported
  -> interrupt active turn and restart the run as a steering replacement attempt

fork unsupported
  -> synthetic fork from app projection if policy allows

rollback unsupported
  -> restore filesystem checkpoint, restart provider context, mark provider state divergent

nested checkpoint unsupported
  -> capture only root-run checkpoint and record child filesystem activity as uncheckpointed

provider switch return unsupported
  -> create fresh provider thread with full app-thread summary

structured approvals unsupported
  -> provider runs under configured sandbox policy; no approval UI

plan_updated unsupported
  -> no live todo UI; rely on assistant messages
```

The UI should not hide unsupported behavior behind provider-specific errors. It should receive typed capability results.

## Adapter Contract

Each provider adapter should expose:

```ts
type ProviderAdapter = {
  getCapabilities(): ProviderCapabilities;
  startSession(input): ProviderSession;
  ensureProviderThread(input): ProviderThread;
  sendRun(input): ProviderTurnStartResult;
  steerRun?(input): void;
  interrupt(input): void;
  respondToRequest(input): void;
  readThreadSnapshot?(input): ProviderThreadSnapshot;
  rollbackThread?(input): ProviderThreadSnapshot | void;
  forkThread?(input): ProviderThread;
  streamEvents(): Stream<ProviderAdapterEvent>;
};
```

Optional methods are guarded by capabilities. The orchestration layer should not call optional methods without checking capability or going through a policy wrapper.

Raw provider frames should be logged by the provider transport/runtime as bounded diagnostics. Adapter streams should expose normalized provider events that the V2 normalizer can turn into app orchestration events.

## Capability-Driven UI

The UI should receive capability-informed affordances:

- show or hide fork action by fork source.
- show interrupt as available, destructive fallback, or unavailable.
- show approvals as respondable or expired.
- show plan/todo panels only when structured plan artifacts exist.
- show rollback only when app checkpoint exists, and annotate provider rollback support.

This keeps the product predictable across Codex, Claude, Cursor, OpenCode, and future providers.
