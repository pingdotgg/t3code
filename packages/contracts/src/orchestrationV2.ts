import { OrchestrationMessageContext } from "./composerContext.ts";
import { withRecordIdTable } from "./orchestrationV2IdTable.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  EventId,
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  MessageId,
  NodeId,
  ForwardCompatibleUnion,
  ForwardCompatibleUnionArray,
  hasUnknownUnionTag,
  isUnknownUnionMember,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ThreadGuestShare } from "./guestShare.ts";
import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "./checkpointDiff.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  ThreadPullRequestWatch,
} from "./threadPullRequest.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  UserInputAttachments,
  UserInputAttachmentAnswerPayload,
  RuntimeMode,
} from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import {
  TurnTokenUsage,
  ToolActivitySurface,
  ToolActivityIcon,
  ToolActivitySource,
} from "./providerRuntime.ts";
import { ThreadTokenUsageSnapshot } from "./providerRuntime.ts";

export const OrchestrationV2Actor = Schema.Literals(["user", "agent", "system"]);
export type OrchestrationV2Actor = typeof OrchestrationV2Actor.Type;

export const OrchestrationV2CreationSource = Schema.Literals([
  "web",
  "mobile",
  "mcp",
  "provider",
  "server",
]);
export type OrchestrationV2CreationSource = typeof OrchestrationV2CreationSource.Type;

export const OrchestrationV2ThreadHistoryOrigin = Schema.Literals(["native", "v1_import"]);
export type OrchestrationV2ThreadHistoryOrigin = typeof OrchestrationV2ThreadHistoryOrigin.Type;

const OrchestrationV2CreationFields = {
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
} as const;

export const OrchestrationV2NativeRefStrength = Schema.Literals(["strong", "weak", "none"]);
export type OrchestrationV2NativeRefStrength = typeof OrchestrationV2NativeRefStrength.Type;

export const OrchestrationV2ProviderRef = Schema.Struct({
  driver: ProviderDriverKind,
  nativeId: Schema.NullOr(TrimmedNonEmptyString),
  strength: OrchestrationV2NativeRefStrength,
  fingerprint: Schema.optional(TrimmedNonEmptyString),
  ordinal: Schema.optional(NonNegativeInt),
});
export type OrchestrationV2ProviderRef = typeof OrchestrationV2ProviderRef.Type;

export const OrchestrationV2AppThreadLineage = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  rootThreadId: ThreadId,
});
export type OrchestrationV2AppThreadLineage = typeof OrchestrationV2AppThreadLineage.Type;

export const OrchestrationV2ContextTransferType = Schema.Literals([
  "fork",
  "provider_handoff",
  "merge_back",
  "subagent_spawn",
  "subagent_result",
]);
export type OrchestrationV2ContextTransferType = typeof OrchestrationV2ContextTransferType.Type;

export const OrchestrationV2ContextSourcePoint = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  checkpointId: Schema.optional(CheckpointId),
  turnItemId: Schema.optional(TurnItemId),
  providerThreadRef: Schema.optional(OrchestrationV2ProviderRef),
  providerTurnRef: Schema.optional(OrchestrationV2ProviderRef),
});
export type OrchestrationV2ContextSourcePoint = typeof OrchestrationV2ContextSourcePoint.Type;

export const OrchestrationV2ThreadForkSourcePoint = Schema.Union([
  Schema.Struct({ type: Schema.Literal("latest_stable") }),
  Schema.Struct({ type: Schema.Literal("run"), runId: RunId }),
  Schema.Struct({ type: Schema.Literal("checkpoint"), checkpointId: CheckpointId }),
]);
export type OrchestrationV2ThreadForkSourcePoint = typeof OrchestrationV2ThreadForkSourcePoint.Type;

export const OrchestrationV2ContextTransferResolution = Schema.Union([
  Schema.Struct({
    strategy: Schema.Literal("native_fork"),
    providerThreadRef: OrchestrationV2ProviderRef,
  }),
  Schema.Struct({
    strategy: Schema.Literal("portable_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("delta_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("fork_delta_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("checkpoint_context"),
    contextHandoffId: ContextHandoffId,
  }),
]);
export type OrchestrationV2ContextTransferResolution =
  typeof OrchestrationV2ContextTransferResolution.Type;

export const OrchestrationV2ProviderTurnTokenUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  maxTokens: Schema.optional(Schema.NullOr(NonNegativeInt)),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  promptCacheTtlMs: Schema.optional(PositiveInt),
  autoCompactThreshold: Schema.optional(PositiveInt),
  promptCacheExpiresAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type OrchestrationV2ProviderTurnTokenUsage =
  typeof OrchestrationV2ProviderTurnTokenUsage.Type;

export const OrchestrationV2ContextTransfer = Schema.Struct({
  id: ContextTransferId,
  type: OrchestrationV2ContextTransferType,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ContextSourcePoint,
  basePoint: Schema.NullOr(OrchestrationV2ContextSourcePoint),
  sourceProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  sourceTokenUsage: Schema.optional(OrchestrationV2ProviderTurnTokenUsage),
  targetProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  targetRunId: Schema.NullOr(RunId),
  status: Schema.Literals([
    "pending",
    "resolved_native",
    "resolved_portable",
    "failed",
    "consumed",
    "superseded",
  ]),
  resolution: Schema.NullOr(OrchestrationV2ContextTransferResolution),
  createdBy: OrchestrationV2Actor,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  consumedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2ContextTransfer = typeof OrchestrationV2ContextTransfer.Type;

export const OrchestrationV2SessionCapabilities = Schema.Struct({
  supportsMultipleProviderThreadsPerSession: Schema.Boolean,
  supportsModelSwitchInSession: Schema.Boolean,
  supportsProviderSwitchingViaHandoff: Schema.Boolean,
  supportsRuntimeModeSwitchInSession: Schema.Boolean,
  pendingRequestsSurviveRestart: Schema.Boolean,
});
export type OrchestrationV2SessionCapabilities = typeof OrchestrationV2SessionCapabilities.Type;

export const OrchestrationV2ThreadCapabilities = Schema.Struct({
  canCreateEmptyThread: Schema.Boolean,
  canReadThreadSnapshot: Schema.Boolean,
  canRollbackThread: Schema.Boolean,
  canForkThread: Schema.Boolean,
  canForkFromTurn: Schema.Boolean,
  canForkFromSubagentThread: Schema.Boolean,
  exposesNativeThreadId: Schema.Boolean,
});
export type OrchestrationV2ThreadCapabilities = typeof OrchestrationV2ThreadCapabilities.Type;

export const OrchestrationV2TurnCapabilities = Schema.Struct({
  exposesNativeTurnId: Schema.Boolean,
  emitsTurnStarted: Schema.Boolean,
  emitsTurnCompleted: Schema.Boolean,
  supportsInterrupt: Schema.Boolean,
  supportsActiveSteering: Schema.Boolean,
  // Some native steering mechanisms cancel pending tools before consuming the message.
  activeSteeringInterruptsTools: Schema.optional(Schema.Boolean),
  supportsSteeringByInterruptRestart: Schema.Boolean,
  supportsQueuedMessages: Schema.Boolean,
  terminalStatusQuality: Schema.Literals(["strong", "weak", "none"]),
});
export type OrchestrationV2TurnCapabilities = typeof OrchestrationV2TurnCapabilities.Type;

export const OrchestrationV2StreamingCapabilities = Schema.Struct({
  streamsAssistantText: Schema.Boolean,
  streamsReasoning: Schema.Boolean,
  streamsToolOutput: Schema.Boolean,
  streamsPlanText: Schema.Boolean,
  emitsMessageCompleted: Schema.Boolean,
});
export type OrchestrationV2StreamingCapabilities = typeof OrchestrationV2StreamingCapabilities.Type;

export const OrchestrationV2ToolCapabilities = Schema.Struct({
  exposesToolItemIds: Schema.Boolean,
  emitsToolStarted: Schema.Boolean,
  emitsToolCompleted: Schema.Boolean,
  emitsToolOutput: Schema.Boolean,
  supportsMcpTools: Schema.Boolean,
  supportsDynamicToolCallbacks: Schema.Boolean,
});
export type OrchestrationV2ToolCapabilities = typeof OrchestrationV2ToolCapabilities.Type;

export const OrchestrationV2ApprovalCapabilities = Schema.Struct({
  supportsCommandApproval: Schema.Boolean,
  supportsFileReadApproval: Schema.Boolean,
  supportsFileChangeApproval: Schema.Boolean,
  supportsApplyPatchApproval: Schema.Boolean,
  approvalsHaveNativeRequestIds: Schema.Boolean,
  approvalCallbacksAreLiveOnly: Schema.Boolean,
  approvalsCanOriginateFromSubagents: Schema.Boolean,
});
export type OrchestrationV2ApprovalCapabilities = typeof OrchestrationV2ApprovalCapabilities.Type;

export const OrchestrationV2PlanningCapabilities = Schema.Struct({
  emitsPlanUpdated: Schema.Boolean,
  emitsTodoList: Schema.Boolean,
  emitsProposedPlan: Schema.Boolean,
  supportsStructuredQuestions: Schema.Boolean,
  planDeltasHaveItemIds: Schema.Boolean,
});
export type OrchestrationV2PlanningCapabilities = typeof OrchestrationV2PlanningCapabilities.Type;

export const OrchestrationV2SubagentCapabilities = Schema.Struct({
  supportsSubagents: Schema.Boolean,
  exposesSubagentThreadIds: Schema.Boolean,
  emitsSubagentLifecycle: Schema.Boolean,
  canWaitForSubagents: Schema.Boolean,
  canCloseSubagents: Schema.Boolean,
  canForkSubagentThread: Schema.Boolean,
});
export type OrchestrationV2SubagentCapabilities = typeof OrchestrationV2SubagentCapabilities.Type;

export const OrchestrationV2ContextCapabilities = Schema.Struct({
  acceptsSystemContext: Schema.Boolean,
  acceptsDeveloperContext: Schema.Boolean,
  acceptsSyntheticUserContext: Schema.Boolean,
  canGenerateSummaries: Schema.Boolean,
  canConsumeHandoffSummaries: Schema.Boolean,
  supportsDeltaHandoff: Schema.Boolean,
  supportsFullThreadHandoff: Schema.Boolean,
  maxRecommendedHandoffChars: Schema.NullOr(PositiveInt),
});
export type OrchestrationV2ContextCapabilities = typeof OrchestrationV2ContextCapabilities.Type;

export const OrchestrationV2CheckpointCapabilities = Schema.Struct({
  appCanCheckpointFilesystem: Schema.Boolean,
  supportsNestedCheckpointScopes: Schema.Boolean,
  providerCanRollbackConversation: Schema.Boolean,
  providerRollbackReturnsSnapshot: Schema.Boolean,
  providerCanReadConversationSnapshot: Schema.Boolean,
});
export type OrchestrationV2CheckpointCapabilities =
  typeof OrchestrationV2CheckpointCapabilities.Type;

export const OrchestrationV2RuntimePolicyCapabilities = Schema.Struct({
  enforcement: Schema.Literals(["native", "client-boundary"]),
});
export type OrchestrationV2RuntimePolicyCapabilities =
  typeof OrchestrationV2RuntimePolicyCapabilities.Type;

export const OrchestrationV2IdentityCapabilities = Schema.Struct({
  nativeThreadIds: OrchestrationV2NativeRefStrength,
  nativeTurnIds: OrchestrationV2NativeRefStrength,
  nativeItemIds: OrchestrationV2NativeRefStrength,
  nativeRequestIds: OrchestrationV2NativeRefStrength,
});
export type OrchestrationV2IdentityCapabilities = typeof OrchestrationV2IdentityCapabilities.Type;

export const OrchestrationV2ProviderCapabilities = Schema.Struct({
  sessions: OrchestrationV2SessionCapabilities,
  threads: OrchestrationV2ThreadCapabilities,
  turns: OrchestrationV2TurnCapabilities,
  streaming: OrchestrationV2StreamingCapabilities,
  tools: OrchestrationV2ToolCapabilities,
  approvals: OrchestrationV2ApprovalCapabilities,
  planning: OrchestrationV2PlanningCapabilities,
  subagents: OrchestrationV2SubagentCapabilities,
  context: OrchestrationV2ContextCapabilities,
  checkpointing: OrchestrationV2CheckpointCapabilities,
  identity: OrchestrationV2IdentityCapabilities,
  // Replay defaults old events to the weaker client-boundary guarantee.
  runtimePolicy: OrchestrationV2RuntimePolicyCapabilities.pipe(
    Schema.withDecodingDefault(Effect.succeed({ enforcement: "client-boundary" as const })),
  ),
});
export type OrchestrationV2ProviderCapabilities = typeof OrchestrationV2ProviderCapabilities.Type;

export const OrchestrationV2LimitRecovery = Schema.Struct({
  requestId: Schema.optional(CommandId),
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.Boolean,
  snooze: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2LimitRecovery = typeof OrchestrationV2LimitRecovery.Type;

export const OrchestrationV2LimitRecoveryUpdate = Schema.Struct({
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.optional(Schema.Boolean),
  snooze: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (update) =>
      update.autoResume !== undefined ||
      update.snooze !== undefined ||
      "A recovery update must include autoResume or snooze.",
  ),
);
export type OrchestrationV2LimitRecoveryUpdate = typeof OrchestrationV2LimitRecoveryUpdate.Type;

/**
 * `score` is an open count that halves every two weeks, as of `openedAt`.
 * `picks` stores lowercase palette queries, newest first.
 * Times are epoch milliseconds for ranking arithmetic.
 */
export const OrchestrationV2ThreadOpens = Schema.Struct({
  openedAt: Schema.Finite,
  score: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  picks: Schema.Array(
    Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(32)), at: Schema.Finite }),
  ).check(Schema.isMaxLength(3)),
});
export type OrchestrationV2ThreadOpens = typeof OrchestrationV2ThreadOpens.Type;

// Open stats only rank search results, so a value this build cannot read (an
// older or newer shape) becomes null instead of failing the whole thread.
const LenientThreadOpens = Schema.NullOr(OrchestrationV2ThreadOpens).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

export const OrchestrationV2AppThread = Schema.Struct({
  ...OrchestrationV2CreationFields,
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
      Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
      Schema.Struct({
        type: Schema.Literal("provider_thread"),
        providerThreadId: ProviderThreadId,
        providerTurnId: Schema.optional(ProviderTurnId),
      }),
    ]),
  ),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  lastSnoozeWakeAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  limitRecovery: Schema.optional(Schema.NullOr(OrchestrationV2LimitRecovery)),
  guestShare: Schema.optional(Schema.NullOr(ThreadGuestShare)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  lastVisitedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  opens: Schema.optional(LenientThreadOpens),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtc,
      }),
    ),
  ),
  rollbackRequestId: Schema.optional(CommandId),
  rollbackFailure: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        message: TrimmedNonEmptyString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2AppThread = typeof OrchestrationV2AppThread.Type;

/** Provider-native children cannot receive messages; T3 delegate_task children can. */
export function isProviderNativeSubagentThread(
  thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">,
): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource === "provider";
}

export const IDLE_COMPACTION_TEXT = "/compact";

interface CompactionMessageFields {
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
  readonly idleCompaction?: OrchestrationV2IdleCompaction | undefined;
}

/** A prompt that only asks the provider to compact, so its turn is the compaction itself. */
export function isCompactionCommandMessage(message: CompactionMessageFields): boolean {
  return (
    message.role === "user" &&
    message.text.trim().toLowerCase() === IDLE_COMPACTION_TEXT &&
    (message.attachments?.length ?? 0) === 0
  );
}

/** Why T3 Code sent this `/compact` on its own, or undefined for one someone asked for. */
export function idleCompactionOf(
  message: CompactionMessageFields,
): OrchestrationV2IdleCompaction | undefined {
  if (!isCompactionCommandMessage(message)) return undefined;
  if (message.idleCompaction !== undefined) return message.idleCompaction;
  // Servers before `idleCompaction` marked their own as agent-created.
  return message.createdBy === "agent" && message.creationSource === "server"
    ? "beforeCacheExpires"
    : undefined;
}

export const OrchestrationV2RunStatus = Schema.Literals([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type OrchestrationV2RunStatus = typeof OrchestrationV2RunStatus.Type;

export const OrchestrationV2DelegatedCompletionTaskDeliveryState = Schema.Literals([
  "pending",
  "claimed",
  "acknowledged",
  "delivered",
  "disposed",
]);
export type OrchestrationV2DelegatedCompletionTaskDeliveryState =
  typeof OrchestrationV2DelegatedCompletionTaskDeliveryState.Type;

export const OrchestrationV2DelegatedCompletionTaskDelivery = Schema.Struct({
  state: OrchestrationV2DelegatedCompletionTaskDeliveryState,
  observedByRunId: Schema.NullOr(RunId),
});
export type OrchestrationV2DelegatedCompletionTaskDelivery =
  typeof OrchestrationV2DelegatedCompletionTaskDelivery.Type;

export const OrchestrationV2DelegatedCompletionDelivery = Schema.Struct({
  generation: PositiveInt,
  messageId: MessageId,
  taskIds: Schema.Array(NodeId),
});
export type OrchestrationV2DelegatedCompletionDelivery =
  typeof OrchestrationV2DelegatedCompletionDelivery.Type;

export const OrchestrationV2DelegatedCompletionCohort = Schema.Struct({
  disposition: Schema.Literals(["open", "stopped", "disposed"]),
  nextGeneration: PositiveInt,
  delivery: Schema.NullOr(OrchestrationV2DelegatedCompletionDelivery),
});
export type OrchestrationV2DelegatedCompletionCohort =
  typeof OrchestrationV2DelegatedCompletionCohort.Type;

export const OrchestrationV2RestartCancelledBackgroundWork = Schema.Struct({
  kind: Schema.Literals(["subagent", "shell", "monitor", "task"]),
  label: TrimmedNonEmptyString,
  id: Schema.optional(TrimmedNonEmptyString),
  /** The agent was waiting on this work, so its restart note wakes the agent even for a shell. */
  awaited: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2RestartCancelledBackgroundWork =
  typeof OrchestrationV2RestartCancelledBackgroundWork.Type;

export const OrchestrationV2RunBackgroundWorkCancelled = Schema.Struct({
  runId: RunId,
  restartCancelledBackgroundWork: Schema.Array(OrchestrationV2RestartCancelledBackgroundWork),
});
export type OrchestrationV2RunBackgroundWorkCancelled =
  typeof OrchestrationV2RunBackgroundWorkCancelled.Type;

export const OrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("root"),
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2ThreadLaunchWorkspaceStrategy =
  typeof OrchestrationV2ThreadLaunchWorkspaceStrategy.Type;

export const ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE = "workspace_preparation_failed";

export const OrchestrationV2Run = Schema.Struct({
  id: RunId,
  threadId: ThreadId,
  ordinal: PositiveInt,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  userMessageId: MessageId,
  rootNodeId: Schema.NullOr(NodeId),
  activeAttemptId: Schema.NullOr(RunAttemptId),
  status: OrchestrationV2RunStatus,
  queuePosition: Schema.optional(Schema.NullOr(PositiveInt)),
  queueHeld: Schema.optional(Schema.Boolean),
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  checkpointId: Schema.NullOr(CheckpointId),
  contextHandoffId: Schema.NullOr(ContextHandoffId),
  restartContinuationOfRunId: Schema.optional(RunId),
  delegatedTaskId: Schema.optional(NodeId),
  workStartedAt: Schema.optional(Schema.DateTimeUtc),
  restartCancelledBackgroundWork: Schema.optional(
    Schema.Array(OrchestrationV2RestartCancelledBackgroundWork),
  ),
  sourcePlanRef: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      planId: PlanId,
    }),
  ),
  delegatedCompletion: Schema.optional(OrchestrationV2DelegatedCompletionCohort),
  workspacePreparation: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
});
export type OrchestrationV2Run = typeof OrchestrationV2Run.Type;

export function orchestrationV2RunWorkStartedAt(
  run: Pick<OrchestrationV2Run, "workStartedAt" | "startedAt" | "requestedAt">,
): OrchestrationV2Run["requestedAt"] {
  return run.workStartedAt ?? run.startedAt ?? run.requestedAt;
}

export const OrchestrationV2RunAttempt = Schema.Struct({
  id: RunAttemptId,
  // Provider-thread rows can be reused after recovery; retain the native input destination.
  nativeThreadId: Schema.optional(Schema.String),
  runId: RunId,
  attemptOrdinal: PositiveInt,
  rootNodeId: NodeId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: ProviderThreadId,
  providerTurnId: Schema.NullOr(ProviderTurnId),
  reason: Schema.Literals(["initial", "steering_restart", "retry", "provider_recovery"]),
  status: Schema.Literals([
    "pending",
    "running",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "superseded",
  ]),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2RunAttempt = typeof OrchestrationV2RunAttempt.Type;

export const OrchestrationV2ExecutionNode = Schema.Struct({
  id: NodeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  parentNodeId: Schema.NullOr(NodeId),
  rootNodeId: NodeId,
  kind: Schema.Literals([
    "root_turn",
    "assistant_message",
    "reasoning",
    "plan",
    "todo_list",
    "tool_call",
    "approval_request",
    "user_input_request",
    "subagent",
    "hook",
    "system",
  ]),
  status: Schema.Literals([
    "idle",
    "pending",
    "running",
    "waiting",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ]),
  countsForRun: Schema.Boolean,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerTurnId: Schema.NullOr(ProviderTurnId),
  nativeItemRef: Schema.NullOr(OrchestrationV2ProviderRef),
  runtimeRequestId: Schema.NullOr(RuntimeRequestId),
  checkpointScopeId: Schema.NullOr(CheckpointScopeId),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2ExecutionNode = typeof OrchestrationV2ExecutionNode.Type;

/** Append-only: phases discovered at runtime join when they start. */
export const OrchestrationV2WorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyString,
});
export type OrchestrationV2WorkflowPhase = typeof OrchestrationV2WorkflowPhase.Type;

/** Nested timestamps use epoch milliseconds; only top-level DateTimeUtc fields are remapped for JSON. */
export const OrchestrationV2WorkflowAgent = Schema.Struct({
  index: NonNegativeInt,
  label: TrimmedNonEmptyString,
  agentId: Schema.optional(TrimmedNonEmptyString),
  childThreadId: Schema.optional(ThreadId),
  state: Schema.Literals(["queued", "running", "completed", "failed"]),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  attempt: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
  toolCalls: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  queuedAt: Schema.optional(NonNegativeInt),
  startedAt: Schema.optional(NonNegativeInt),
  completedAt: Schema.optional(NonNegativeInt),
  prompt: Schema.optional(Schema.NonEmptyString),
  result: Schema.optional(Schema.NonEmptyString),
});
export type OrchestrationV2WorkflowAgent = typeof OrchestrationV2WorkflowAgent.Type;

export const OrchestrationV2WorkflowRunHandles = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyString),
  transcriptDir: Schema.optional(TrimmedNonEmptyString),
  scriptPath: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2WorkflowRunHandles = typeof OrchestrationV2WorkflowRunHandles.Type;

export const OrchestrationV2SubagentWorkflow = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  runHandles: Schema.optional(OrchestrationV2WorkflowRunHandles),
  phases: Schema.Array(OrchestrationV2WorkflowPhase),
  agents: Schema.Array(OrchestrationV2WorkflowAgent),
  totalTokens: Schema.optional(NonNegativeInt),
  toolCalls: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
});
export type OrchestrationV2SubagentWorkflow = typeof OrchestrationV2SubagentWorkflow.Type;

/**
 * Wire-only, for clients that opted in with `acceptDedupedBodies` or `dedupeBodies=1`: the field
 * was blanked because an earlier record on the same response or stream holds the same value.
 * Restore with `@t3tools/shared/orchestrationV2DedupedBodies`; never store or forward a marked
 * value. Clients restore only these fields, so blanking another field needs a new opt-in.
 */
const DedupedBodyMarker = Schema.optionalKey(Schema.Literal(true));

export const OrchestrationV2Subagent = Schema.Struct({
  id: NodeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  parentNodeId: NodeId,
  origin: Schema.Literals(["provider_native", "app_owned"]),
  createdBy: OrchestrationV2Actor,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  childThreadId: Schema.NullOr(ThreadId),
  nativeTaskRef: Schema.NullOr(OrchestrationV2ProviderRef),
  prompt: Schema.String,
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  completionWake: Schema.optional(Schema.Literals(["always", "settled_only"])),
  completionDelivery: Schema.optional(OrchestrationV2DelegatedCompletionTaskDelivery),
  status: Schema.Literals([
    "idle",
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  progress: Schema.optional(Schema.String),
  workflow: Schema.optional(OrchestrationV2SubagentWorkflow),
  result: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
  /** Same as this subagent's previous record on this stream: its snapshot or `subagent.updated`. */
  promptOmitted: DedupedBodyMarker,
  resultOmitted: DedupedBodyMarker,
});
export type OrchestrationV2Subagent = typeof OrchestrationV2Subagent.Type;

export function isOrchestrationV2WorkActive(
  status: OrchestrationV2ExecutionNode["status"],
): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export const OrchestrationV2CheckpointScope = Schema.Struct({
  id: CheckpointScopeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  parentScopeId: Schema.NullOr(CheckpointScopeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  kind: Schema.Literals(["root_run", "subagent", "tool", "provider_thread", "manual"]),
  ordinalWithinParent: NonNegativeInt,
  advancesAppRunCount: Schema.Boolean,
  cwd: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
});
export type OrchestrationV2CheckpointScope = typeof OrchestrationV2CheckpointScope.Type;

export const OrchestrationV2ProviderSession = Schema.Struct({
  id: ProviderSessionId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  status: Schema.Literals(["starting", "ready", "running", "waiting", "stopped", "error"]),
  cwd: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: OrchestrationV2ProviderCapabilities,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  lastError: Schema.NullOr(Schema.String),
});
export type OrchestrationV2ProviderSession = typeof OrchestrationV2ProviderSession.Type;

export const OrchestrationV2ProviderSessionDetached = Schema.Struct({
  providerSessionId: ProviderSessionId,
  detachedAt: Schema.DateTimeUtc,
  reason: Schema.optional(Schema.String),
});
export type OrchestrationV2ProviderSessionDetached =
  typeof OrchestrationV2ProviderSessionDetached.Type;

function encodedKind(member: Schema.Top): string {
  const encoded = SchemaAST.toEncoded(member.ast);
  const kind = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "kind")?.type
    : undefined;
  if (kind !== undefined && SchemaAST.isLiteral(kind) && typeof kind.literal === "string") {
    return kind.literal;
  }
  throw new Error("Each member of a kind union needs a literal string `kind`.");
}

function kindUnionWithFallback<
  const Members extends ReadonlyArray<Schema.Top & { readonly Encoded: { readonly kind: string } }>,
  Unknown extends Schema.Top,
>(
  members: Members,
  unknown: (kind: Schema.optional<Schema.String>) => Unknown,
  fallback: (value: Unknown["Type"]) => Schema.Union<Members>["Encoded"],
) {
  const knownKinds: ReadonlySet<string> = new Set(members.map(encodedKind));
  const unknownKind = unknown(
    Schema.optional(
      Schema.String.check(
        Schema.makeFilter(
          (kind: string) => !knownKinds.has(kind) || "A known kind must decode in full.",
        ),
      ),
    ),
  ).pipe(
    Schema.decodeTo(Schema.Union(members), {
      decode: SchemaGetter.transform(fallback),
      encode: SchemaGetter.forbidden(() => "Unknown kinds are decode-only."),
    }),
  );
  return Schema.Union([...members, unknownKind]);
}

const PendingBackgroundTaskFields = {
  taskId: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  /** The subagent task that started this work and waits on it. */
  parentTaskId: Schema.optional(TrimmedNonEmptyString),
  /**
   * The agent declared it resumes when this work ends, so the thread holds like it does for a
   * subagent. Only the agent knows whether a command is a wait or a dev server it left running.
   */
  awaited: Schema.optional(Schema.Literal(true)),
};

export const OrchestrationV2PendingBackgroundTask = kindUnionWithFallback(
  [
    Schema.Struct({
      ...PendingBackgroundTaskFields,
      kind: Schema.Literal("subagent"),
      /** The owning provider thread's instance, populated in derived pending work. */
      providerInstanceId: Schema.optional(ProviderInstanceId),
      childThreadId: Schema.optional(ThreadId),
    }),
    Schema.Struct({ ...PendingBackgroundTaskFields, kind: Schema.Literal("command") }),
    Schema.Struct({ ...PendingBackgroundTaskFields, kind: Schema.Literal("monitor") }),
    Schema.Struct({ ...PendingBackgroundTaskFields, kind: Schema.Literal("background_task") }),
  ],
  (kind) => Schema.Struct({ ...PendingBackgroundTaskFields, kind }),
  ({ taskId, description, parentTaskId }) => ({
    taskId,
    ...(description === undefined ? {} : { description }),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    kind: "background_task",
  }),
);
export type OrchestrationV2PendingBackgroundTask = typeof OrchestrationV2PendingBackgroundTask.Type;

export const OrchestrationV2ProviderThreadNativeMetadata = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  itemIdentityVersion: Schema.optional(Schema.Literal(2)),
  forkHeadMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2ProviderThreadNativeMetadata =
  typeof OrchestrationV2ProviderThreadNativeMetadata.Type;

export const OrchestrationV2ProviderGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);
export type OrchestrationV2ProviderGoalStatus = typeof OrchestrationV2ProviderGoalStatus.Type;

export const OrchestrationV2ProviderGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: OrchestrationV2ProviderGoalStatus,
  tokensUsed: Schema.optional(NonNegativeInt),
  tokenBudget: Schema.optional(Schema.NullOr(NonNegativeInt)),
  timeUsedSeconds: Schema.optional(NonNegativeInt),
  checks: Schema.optional(NonNegativeInt),
  lastCheck: Schema.optional(Schema.String),
});
export type OrchestrationV2ProviderGoal = typeof OrchestrationV2ProviderGoal.Type;

export const OrchestrationV2ProviderThread = Schema.Struct({
  id: ProviderThreadId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: Schema.NullOr(ProviderSessionId),
  appThreadId: Schema.NullOr(ThreadId),
  ownerNodeId: Schema.NullOr(NodeId),
  nativeThreadRef: Schema.NullOr(OrchestrationV2ProviderRef),
  nativeConversationHeadRef: Schema.NullOr(OrchestrationV2ProviderRef),
  status: Schema.Literals(["not_loaded", "idle", "active", "archived", "closed", "error"]),
  firstRunOrdinal: Schema.NullOr(PositiveInt),
  lastRunOrdinal: Schema.NullOr(PositiveInt),
  handoffIds: Schema.Array(ContextHandoffId),
  forkedFrom: Schema.NullOr(
    Schema.Struct({
      providerThreadId: ProviderThreadId,
      providerTurnId: Schema.optional(ProviderTurnId),
      checkpointId: Schema.optional(CheckpointId),
    }),
  ),
  pendingBackgroundTasks: Schema.optional(Schema.Array(OrchestrationV2PendingBackgroundTask)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  contextUsage: Schema.optional(Schema.NullOr(ThreadTokenUsageSnapshot)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  nativeMetadata: Schema.optional(Schema.NullOr(OrchestrationV2ProviderThreadNativeMetadata)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  goal: Schema.optional(Schema.NullOr(OrchestrationV2ProviderGoal)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ProviderThread = typeof OrchestrationV2ProviderThread.Type;

export const OrchestrationV2HistoricalMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  runStatus: Schema.optional(Schema.String),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  itemId: TurnItemId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  status: Schema.String,
  kind: Schema.String,
});
export type OrchestrationV2HistoricalMessage = typeof OrchestrationV2HistoricalMessage.Type;

export const OrchestrationV2ContextHandoff = Schema.Struct({
  id: ContextHandoffId,
  transferId: Schema.optional(Schema.NullOr(ContextTransferId)),
  threadId: ThreadId,
  targetRunId: RunId,
  fromProviderThreadIds: Schema.Array(ProviderThreadId),
  toProviderThreadId: ProviderThreadId,
  coveredRunOrdinals: Schema.Struct({
    from: PositiveInt,
    to: PositiveInt,
  }),
  strategy: Schema.Literals([
    "delta_since_target_last_seen",
    "fork_delta_summary",
    "full_thread_summary",
    "checkpoint_summary",
    "manual_context",
  ]),
  status: Schema.Literals(["pending", "ready", "failed", "superseded"]),
  summaryMessageId: Schema.NullOr(MessageId),
  summaryText: Schema.String,
  history: Schema.optional(
    Schema.Struct({
      messages: Schema.Array(OrchestrationV2HistoricalMessage),
      coverage: Schema.String,
      omittedItems: NonNegativeInt,
      omittedItemIds: Schema.optional(Schema.Array(TurnItemId)),
    }),
  ),
  delivery: Schema.optional(
    Schema.Struct({
      nativeThreadId: Schema.String,
      status: Schema.Literals(["pending", "injected", "inline"]),
      itemIds: Schema.Array(TurnItemId),
      omittedItemIds: Schema.optional(Schema.Array(TurnItemId)),
    }),
  ),
  detailInTurnItem: Schema.optional(Schema.Literal(true)),
  createdByProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ContextHandoff = typeof OrchestrationV2ContextHandoff.Type;

export const OrchestrationV2ProviderTurn = Schema.Struct({
  id: ProviderTurnId,
  providerThreadId: ProviderThreadId,
  nodeId: NodeId,
  runAttemptId: Schema.NullOr(RunAttemptId),
  nativeTurnRef: Schema.NullOr(OrchestrationV2ProviderRef),
  ordinal: PositiveInt,
  status: Schema.Literals([
    "pending",
    "running",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
  ]),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  tokenUsage: Schema.optional(OrchestrationV2ProviderTurnTokenUsage),
  turnTokenUsage: Schema.optional(TurnTokenUsage),
});
export type OrchestrationV2ProviderTurn = typeof OrchestrationV2ProviderTurn.Type;

/** Codex goals can span multiple native turns within one attempt. */
export function latestProviderTurnForAttempt<
  Turn extends Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "ordinal">,
>(
  providerTurns: ReadonlyArray<Turn>,
  attemptId: RunAttemptId | null | undefined,
): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of providerTurns) {
    if (attemptId == null || turn.runAttemptId !== attemptId) continue;
    if (latest === undefined || turn.ordinal > latest.ordinal) latest = turn;
  }
  return latest;
}

export const OrchestrationV2RuntimeRequest = Schema.Struct({
  id: RuntimeRequestId,
  nodeId: NodeId,
  providerTurnId: Schema.NullOr(ProviderTurnId),
  nativeRequestRef: Schema.NullOr(OrchestrationV2ProviderRef),
  kind: Schema.Union([
    ProviderRequestKind,
    Schema.Literals(["dynamic_tool_call", "user_input", "auth_refresh"]),
  ]),
  status: Schema.Literals(["pending", "resolved", "expired", "cancelled"]),
  responseCapability: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("live"),
      providerSessionId: ProviderSessionId,
      supportsFeedback: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({ type: Schema.Literal("message") }),
    Schema.Struct({ type: Schema.Literal("not_resumable"), reason: Schema.String }),
  ]),
  createdAt: Schema.DateTimeUtc,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
  decision: Schema.optional(ProviderApprovalDecision),
  feedback: Schema.optional(Schema.String),
  answers: Schema.optional(ProviderUserInputAnswers),
});
export type OrchestrationV2RuntimeRequest = typeof OrchestrationV2RuntimeRequest.Type;

const SubagentNotificationSource = Schema.Struct({
  kind: Schema.Literal("subagent"),
  childThreadId: Schema.optional(ThreadId),
});
const CommandNotificationSource = Schema.Struct({ kind: Schema.Literal("command") });

/** Encode legacy background_command/background_task shapes first so older clients accept command/subagent sources. */
export const OrchestrationV2NotificationSource = kindUnionWithFallback(
  [
    Schema.Struct({
      kind: Schema.Literal("delegated_task"),
      taskIds: Schema.Array(NodeId),
      childThreadId: Schema.optional(ThreadId),
    }),
    Schema.Struct({
      kind: Schema.Literal("background_task"),
      work: Schema.Literal("subagent"),
      childThreadId: Schema.optional(ThreadId),
    }).pipe(
      Schema.decodeTo(Schema.toType(SubagentNotificationSource), {
        decode: SchemaGetter.transform(({ childThreadId }) =>
          childThreadId === undefined
            ? { kind: "subagent" as const }
            : { kind: "subagent" as const, childThreadId },
        ),
        encode: SchemaGetter.transform(({ childThreadId }) => ({
          kind: "background_task" as const,
          work: "subagent" as const,
          ...(childThreadId === undefined ? {} : { childThreadId }),
        })),
      }),
    ),
    Schema.Struct({ kind: Schema.Literal("background_command").transform("command") }),
    SubagentNotificationSource,
    CommandNotificationSource,
    Schema.Struct({ kind: Schema.Literal("monitor") }),
    Schema.Struct({ kind: Schema.Literal("background_task") }),
    Schema.Struct({ kind: Schema.Literal("system") }),
  ],
  (kind) => Schema.Struct({ kind }),
  () => ({ kind: "background_task" }),
);
export type OrchestrationV2NotificationSource = typeof OrchestrationV2NotificationSource.Type;

export const OrchestrationV2Notification = Schema.Struct({
  source: OrchestrationV2NotificationSource,
  outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.String),
});
export type OrchestrationV2Notification = typeof OrchestrationV2Notification.Type;

/** Why T3 Code compacted a thread on its own, on the `/compact` it sent. */
export const OrchestrationV2IdleCompaction = Schema.Literals(["beforeCacheExpires", "onReturn"]);
export type OrchestrationV2IdleCompaction = typeof OrchestrationV2IdleCompaction.Type;

export const OrchestrationV2ConversationMessage = Schema.Struct({
  notification: Schema.optional(OrchestrationV2Notification),
  ...OrchestrationV2CreationFields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  senderThreadId: Schema.optional(ThreadId),
  idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
  /**
   * The message is the script a provider-native workflow run executes, not prose. Clients show
   * the workflow's opening instead and keep the script behind a disclosure.
   */
  workflowScript: Schema.optional(Schema.Boolean),
  id: MessageId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.Array(ChatAttachment),
  streaming: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  delegatedCompletion: Schema.optional(
    Schema.Struct({
      parentRunId: RunId,
      generation: PositiveInt,
      taskIds: Schema.Array(NodeId),
    }),
  ),
});
export type OrchestrationV2ConversationMessage = typeof OrchestrationV2ConversationMessage.Type;

export const OrchestrationV2PlanStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "completed"]),
  durationAnchorAt: Schema.optional(IsoDateTime),
  durationMs: Schema.optional(NonNegativeInt),
});
export type OrchestrationV2PlanStep = typeof OrchestrationV2PlanStep.Type;

export const OrchestrationV2UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      description: TrimmedNonEmptyString,
      value: Schema.optional(Schema.String),
      preview: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2UserInputQuestion = typeof OrchestrationV2UserInputQuestion.Type;

const OrchestrationV2PlanArtifactBaseFields = {
  id: PlanId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  status: Schema.Literals(["draft", "active", "completed", "superseded"]),
  detailInTurnItem: Schema.optional(Schema.Literal(true)),
} as const;

export const OrchestrationV2PlanArtifact = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2PlanArtifactBaseFields,
    kind: Schema.Literal("proposed_plan"),
    markdown: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2PlanArtifactBaseFields,
    kind: Schema.Literal("todo_list"),
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
]);
export type OrchestrationV2PlanArtifact = typeof OrchestrationV2PlanArtifact.Type;

export const OrchestrationV2CheckpointFileSummary = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationV2CheckpointFileSummary = typeof OrchestrationV2CheckpointFileSummary.Type;

export const OrchestrationV2Checkpoint = Schema.Struct({
  id: CheckpointId,
  threadId: ThreadId,
  scopeId: CheckpointScopeId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  parentCheckpointId: Schema.NullOr(CheckpointId),
  ordinalWithinScope: NonNegativeInt,
  appRunOrdinal: Schema.NullOr(PositiveInt),
  ref: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error", "stale"]),
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  capturedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2Checkpoint = typeof OrchestrationV2Checkpoint.Type;

export const OrchestrationV2CheckpointRollbackRequest = Schema.Struct({
  scopeId: CheckpointScopeId,
  checkpointId: CheckpointId,
  requestedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2CheckpointRollbackRequest =
  typeof OrchestrationV2CheckpointRollbackRequest.Type;

export class OrchestrationV2CheckpointUnavailableError extends Schema.TaggedError<OrchestrationV2CheckpointUnavailableError>()(
  "OrchestrationV2CheckpointUnavailableError",
  {
    threadId: ThreadId,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Rollback target ${this.target} is unavailable for thread ${this.threadId}.`;
  }
}

export const OrchestrationV2TurnItemStatus = Schema.Literals([
  "idle",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type OrchestrationV2TurnItemStatus = typeof OrchestrationV2TurnItemStatus.Type;

export const OrchestrationV2FileChangeDetail = Schema.Struct({
  operation: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  oldPath: Schema.optional(TrimmedNonEmptyString),
  fileType: Schema.optional(TrimmedNonEmptyString),
  mimeType: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2FileChangeDetail = typeof OrchestrationV2FileChangeDetail.Type;

export const OrchestrationV2ProviderFailureClass = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type OrchestrationV2ProviderFailureClass = typeof OrchestrationV2ProviderFailureClass.Type;

const OrchestrationV2ProviderFailureMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_096),
);
const OrchestrationV2ProviderFailureCode = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Producers must redact credentials before construction. */
export const OrchestrationV2ProviderFailure = Schema.Struct({
  class: OrchestrationV2ProviderFailureClass,
  message: OrchestrationV2ProviderFailureMessage,
  code: Schema.NullOr(OrchestrationV2ProviderFailureCode),
  retryable: Schema.NullOr(Schema.Boolean),
  resetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestrationV2ProviderFailure = typeof OrchestrationV2ProviderFailure.Type;

export const OrchestrationV2ProviderRetry = Schema.Struct({
  attempt: PositiveInt,
  maxAttempts: Schema.NullOr(PositiveInt),
  retryDelayMs: Schema.NullOr(NonNegativeInt),
});
export type OrchestrationV2ProviderRetry = typeof OrchestrationV2ProviderRetry.Type;

export const OrchestrationV2ProviderThreadDisposition = Schema.Literals(["reusable", "broken"]);
export type OrchestrationV2ProviderThreadDisposition =
  typeof OrchestrationV2ProviderThreadDisposition.Type;

export const OrchestrationV2UserMessageInputIntent = Schema.Literals([
  "turn_start",
  "queued_turn",
  "steer",
  "promoted_queued_to_steer",
]);
export type OrchestrationV2UserMessageInputIntent =
  typeof OrchestrationV2UserMessageInputIntent.Type;

const OrchestrationV2TurnItemBaseFields = {
  toolNonExecutionKind: Schema.optional(Schema.String),
  toolSurface: Schema.optional(ToolActivitySurface),
  toolIcon: Schema.optional(ToolActivityIcon),
  toolSource: Schema.optional(ToolActivitySource),
  id: TurnItemId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerTurnId: Schema.NullOr(ProviderTurnId),
  nativeItemRef: Schema.NullOr(OrchestrationV2ProviderRef),
  parentItemId: Schema.NullOr(TurnItemId),
  ordinal: NonNegativeInt,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
} as const;

export const OrchestrationV2FileSearchResult = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  line: Schema.optional(PositiveInt),
  column: Schema.optional(PositiveInt),
  preview: Schema.optional(Schema.String),
});
export type OrchestrationV2FileSearchResult = typeof OrchestrationV2FileSearchResult.Type;

export const OrchestrationV2WebSearchResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(TrimmedNonEmptyString),
  snippet: Schema.optional(Schema.String),
});
export type OrchestrationV2WebSearchResult = typeof OrchestrationV2WebSearchResult.Type;

export const OrchestrationV2SecretRequestStatus = Schema.Literals([
  "pending",
  "saved",
  "declined",
  "cancelled",
]);
export type OrchestrationV2SecretRequestStatus = typeof OrchestrationV2SecretRequestStatus.Type;

const OrchestrationV2SecretRequestFields = {
  type: Schema.Literal("secret_request"),
  label: TrimmedNonEmptyString,
  reason: Schema.String,
  placeholder: Schema.optional(Schema.String),
  secretStatus: OrchestrationV2SecretRequestStatus,
} as const;

export const OrchestrationV2TurnItem = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("notification"),
    ...OrchestrationV2Notification.fields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    senderThreadId: Schema.optional(ThreadId),
    idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
    workflowScript: OrchestrationV2ConversationMessage.fields.workflowScript,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    /** Same as the text of message `messageId`. */
    textOmitted: DedupedBodyMarker,
    context: Schema.optional(OrchestrationMessageContext),
    attachments: Schema.Array(ChatAttachment),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
    textOmitted: DedupedBodyMarker,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("reasoning"),
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("proposed_plan"),
    planId: PlanId,
    markdown: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("todo_list"),
    planId: PlanId,
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("user_input_request"),
    requestId: RuntimeRequestId,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    questionAnswer: Schema.optional(UserInputAttachmentAnswerPayload),
    responseMode: Schema.optional(Schema.Literal("message")),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("file_change"),
    fileName: TrimmedNonEmptyString,
    additions: Schema.optional(NonNegativeInt),
    deletions: Schema.optional(NonNegativeInt),
    diffStr: Schema.optional(Schema.String),
    oldStr: Schema.optional(Schema.String),
    newStr: Schema.optional(Schema.String),
    changes: Schema.optional(Schema.Array(OrchestrationV2FileChangeDetail)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.optional(Schema.String),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
    outputIndicatesFailure: Schema.optional(Schema.Boolean),
    exitCode: Schema.optional(Schema.Int),
    /** Set when the command is a monitor, so background work lists it as a monitor. */
    monitor: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("file_search"),
    pattern: Schema.optional(Schema.String),
    results: Schema.optional(Schema.Array(OrchestrationV2FileSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("web_search"),
    patterns: Schema.optional(Schema.Array(Schema.String)),
    results: Schema.optional(Schema.Array(OrchestrationV2WebSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("approval_request"),
    requestId: RuntimeRequestId,
    requestKind: ProviderRequestKind,
    prompt: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    fullAccessOverride: Schema.optional(ProviderApprovalFullAccessOverride),
    appName: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(ProviderApprovalOption)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("checkpoint"),
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
    files: Schema.Array(OrchestrationV2CheckpointFileSummary),
    /** Same as the files of checkpoint `checkpointId`. */
    filesOmitted: DedupedBodyMarker,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("run_interrupt_request"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("run_interrupt_result"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("compaction"),
    driver: Schema.NullOr(ProviderDriverKind),
    summary: Schema.optional(Schema.String),
    beforeTokenCount: Schema.optional(NonNegativeInt),
    afterTokenCount: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("handoff"),
    contextHandoffId: ContextHandoffId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    fromProviderInstanceIds: Schema.Array(ProviderInstanceId),
    toProviderInstanceId: ProviderInstanceId,
    fromModelSelections: Schema.optional(Schema.Array(ModelSelection)),
    toModel: Schema.optional(Schema.String),
    strategy: Schema.Literals([
      "delta_since_target_last_seen",
      "fork_delta_summary",
      "full_thread_summary",
      "checkpoint_summary",
      "manual_context",
    ]),
    summary: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("fork"),
    source: Schema.Union([
      Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
      Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
      Schema.Struct({
        type: Schema.Literal("provider_thread"),
        providerThreadId: ProviderThreadId,
        providerTurnId: Schema.optional(ProviderTurnId),
      }),
    ]),
    targetThreadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("thread_created"),
    targetThreadId: ThreadId,
    targetRunId: Schema.NullOr(RunId),
    targetProviderInstanceId: ProviderInstanceId,
    targetModel: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2SecretRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("subagent"),
    subagentId: NodeId,
    origin: Schema.Literals(["provider_native", "app_owned"]),
    driver: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    childThreadId: Schema.NullOr(ThreadId),
    prompt: Schema.String,
    progress: Schema.optional(Schema.String),
    result: Schema.NullOr(Schema.String),
    /** Same as the prompt and result of subagent `subagentId`. */
    promptOmitted: DedupedBodyMarker,
    resultOmitted: DedupedBodyMarker,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    viewedImagePath: Schema.optional(TrimmedNonEmptyString),
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2TurnItem = typeof OrchestrationV2TurnItem.Type;

const isUnknownTurnItem = hasUnknownUnionTag(OrchestrationV2TurnItem.members, "type");

const turnItemArray = <Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>>(
  union: Schema.Union<Members>,
) => ForwardCompatibleUnionArray(union.members, "type");

const projectedTurnItemArray = <Row extends Schema.Top, Item extends Schema.Top>(
  row: Row,
  rowWithUnknownItem: Item,
) =>
  Schema.Array(rowWithUnknownItem).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(row)),
      SchemaTransformation.transform<ReadonlyArray<Row["Type"]>, ReadonlyArray<Item["Type"]>>({
        decode: (rows) =>
          rows.filter(
            (projected) => !isUnknownUnionMember((projected as { readonly item: unknown }).item),
          ) as ReadonlyArray<Row["Type"]>,
        encode: (rows) => rows,
      }),
    ),
  );

export const OrchestrationV2ProjectedTurnItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  item: OrchestrationV2TurnItem,
});
export type OrchestrationV2ProjectedTurnItem = typeof OrchestrationV2ProjectedTurnItem.Type;

export const OrchestrationV2RawProviderEvent = Schema.Struct({
  id: RawEventId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId,
  sequence: PositiveInt,
  direction: Schema.Literals(["incoming", "outgoing"]),
  messageKind: Schema.Literals(["request", "response", "notification", "error"]),
  method: Schema.NullOr(TrimmedNonEmptyString),
  jsonRpcId: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  payload: Schema.Unknown,
  observedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2RawProviderEvent = typeof OrchestrationV2RawProviderEvent.Type;

const OrchestrationV2EventBase = Schema.Struct({
  id: EventId,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  nodeId: Schema.optional(NodeId),
  driver: Schema.optional(ProviderDriverKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  rawEventId: Schema.optional(RawEventId),
  occurredAt: Schema.DateTimeUtc,
});

export const OrchestrationV2DomainEvent = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("thread.created"),
    payload: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literals([
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.visited",
      "thread.marked-unread",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ]),
    payload: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("thread.pull-request-link-updated"),
    payload: ThreadPullRequestLink,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.created"),
    payload: OrchestrationV2Run,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.updated"),
    payload: OrchestrationV2Run,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.background-work-cancelled"),
    payload: OrchestrationV2RunBackgroundWorkCancelled,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run-attempt.created"),
    payload: OrchestrationV2RunAttempt,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run-attempt.updated"),
    payload: OrchestrationV2RunAttempt,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("node.updated"),
    payload: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("subagent.updated"),
    payload: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literals(["provider-session.attached", "provider-session.updated"]),
    payload: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-session.detached"),
    payload: OrchestrationV2ProviderSessionDetached,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-thread.updated"),
    payload: OrchestrationV2ProviderThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-turn.updated"),
    payload: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("runtime-request.updated"),
    payload: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("message.updated"),
    payload: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("turn-item.updated"),
    payload: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("plan.updated"),
    payload: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint-scope.created"),
    payload: OrchestrationV2CheckpointScope,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint.captured"),
    payload: OrchestrationV2Checkpoint,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint.rollback-requested"),
    payload: OrchestrationV2CheckpointRollbackRequest,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-handoff.updated"),
    payload: OrchestrationV2ContextHandoff,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-transfer.created"),
    payload: OrchestrationV2ContextTransfer,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-transfer.updated"),
    payload: OrchestrationV2ContextTransfer,
  }),
]);
export type OrchestrationV2DomainEvent = typeof OrchestrationV2DomainEvent.Type;

export const OrchestrationV2ThreadProjection = Schema.Struct({
  thread: OrchestrationV2AppThread,
  runs: Schema.Array(OrchestrationV2Run),
  attempts: Schema.Array(OrchestrationV2RunAttempt),
  nodes: Schema.Array(OrchestrationV2ExecutionNode),
  subagents: Schema.Array(OrchestrationV2Subagent),
  providerSessions: Schema.Array(OrchestrationV2ProviderSession),
  providerThreads: Schema.Array(OrchestrationV2ProviderThread),
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  plans: Schema.Array(OrchestrationV2PlanArtifact),
  turnItems: turnItemArray(OrchestrationV2TurnItem),
  checkpointScopes: Schema.Array(OrchestrationV2CheckpointScope),
  checkpoints: Schema.Array(OrchestrationV2Checkpoint),
  contextHandoffs: Schema.Array(OrchestrationV2ContextHandoff),
  contextTransfers: Schema.Array(OrchestrationV2ContextTransfer),
  visibleTurnItems: projectedTurnItemArray(
    OrchestrationV2ProjectedTurnItem,
    OrchestrationV2ProjectedTurnItem.mapFields((fields) => ({
      ...fields,
      item: ForwardCompatibleUnion(OrchestrationV2TurnItem.members, "type"),
    })),
  ),
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ThreadProjection = typeof OrchestrationV2ThreadProjection.Type;

export const OrchestrationV2ThreadTranscript = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  updatedAt: Schema.DateTimeUtc,
  items: Schema.Array(OrchestrationV2ProjectedTurnItem),
});
export type OrchestrationV2ThreadTranscript = typeof OrchestrationV2ThreadTranscript.Type;

export const OrchestrationV2ShellThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestrationV2ShellThreadStatus = typeof OrchestrationV2ShellThreadStatus.Type;

export const OrchestrationV2PendingRuntimeRequestSummary = Schema.Struct({
  id: RuntimeRequestId,
  kind: OrchestrationV2RuntimeRequest.fields.kind,
  createdAt: Schema.DateTimeUtc,
  /** False for async questions the run keeps working past. Absent from older servers. */
  blocking: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2PendingRuntimeRequestSummary =
  typeof OrchestrationV2PendingRuntimeRequestSummary.Type;

export const OrchestrationV2LatestVisibleMessageSummary = Schema.Struct({
  id: MessageId,
  role: OrchestrationV2ConversationMessage.fields.role,
  text: Schema.String,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2LatestVisibleMessageSummary =
  typeof OrchestrationV2LatestVisibleMessageSummary.Type;

export const OrchestrationV2ThreadShell = Schema.Struct({
  ...OrchestrationV2CreationFields,
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: Schema.NullOr(OrchestrationV2AppThread.fields.forkedFrom),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
  latestRunId: Schema.NullOr(RunId),
  latestRunRequestedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunCompletedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunStopRequested: Schema.optional(Schema.Boolean),
  /** Suppress routine notifications for idle compaction; failures still notify. */
  latestRunSilent: Schema.optional(Schema.Boolean),
  activeRunId: Schema.NullOr(RunId),
  activityRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  activityRunStatus: Schema.optional(
    Schema.NullOr(Schema.Literals(["preparing", "starting", "running", "waiting"])),
  ),
  blockedOnThreadWait: Schema.optional(Schema.Boolean),
  status: OrchestrationV2ShellThreadStatus,
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  lastErrorClass: Schema.optional(Schema.NullOr(OrchestrationV2ProviderFailureClass)),
  lastErrorCode: Schema.optional(Schema.NullOr(Schema.String)),
  usageLimitResetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummary),
  /** Guest messages waiting for the owner to send or dismiss. Absent from older servers. */
  pendingGuestMessageCount: Schema.optional(NonNegativeInt),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummary),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Excludes wakes and agent messages that advance latestUserMessageAt through the user role. */
  latestUserAuthoredMessageAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  hasActionableProposedPlan: Schema.Boolean,
  pendingBackgroundTasks: Schema.optional(Schema.Array(OrchestrationV2PendingBackgroundTask)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerInstanceHistory: Schema.optional(Schema.Array(ProviderInstanceId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  goal: Schema.optional(Schema.NullOr(OrchestrationV2ProviderGoal)),
  itemCount: NonNegativeInt,
  visibleItemCount: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(Schema.DateTimeUtc),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  limitRecovery: Schema.optional(Schema.NullOr(OrchestrationV2LimitRecovery)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  lastVisitedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  opens: Schema.optional(LenientThreadOpens),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtc,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2ThreadShell = typeof OrchestrationV2ThreadShell.Type;

const LIVE_SHELL_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * A subagent child that can still need the user or hold its parent. Shells that omit idle children
 * keep these, so every reader of live child rows (pending requests, working parents, background
 * work) still finds them.
 */
export function isLiveSubagentShell(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
  >,
): boolean {
  return (
    (thread.activityRunStatus ?? null) !== null ||
    LIVE_SHELL_STATUSES.has(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0
  );
}

export const OrchestrationV2ThreadShellSnapshot = Schema.Struct({
  schemaVersion: PositiveInt,
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationV2ThreadShell),
  archivedThreads: Schema.Array(OrchestrationV2ThreadShell),
});
export type OrchestrationV2ThreadShellSnapshot = typeof OrchestrationV2ThreadShellSnapshot.Type;

export const OrchestrationV2ShellSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadShellSnapshot.fields,
  projects: Schema.Array(OrchestrationProjectShell),
});
export type OrchestrationV2ShellSnapshot = typeof OrchestrationV2ShellSnapshot.Type;

export const OrchestrationV2ShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
    resolvedRepositoryIdentityRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("project.updated"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project.removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.updated"),
    sequence: NonNegativeInt,
    location: Schema.Literals(["active", "archive"]),
    thread: OrchestrationV2ThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.removed"),
    sequence: NonNegativeInt,
    location: Schema.Literals(["active", "archive"]),
    threadId: ThreadId,
  }),
]);
export type OrchestrationV2ShellStreamItem = typeof OrchestrationV2ShellStreamItem.Type;

export const OrchestrationV2StoredEvent = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  event: OrchestrationV2DomainEvent,
});
export type OrchestrationV2StoredEvent = typeof OrchestrationV2StoredEvent.Type;

export const OrchestrationV2AppThreadJson = OrchestrationV2AppThread.mapFields((fields) => ({
  ...fields,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  settledAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastSnoozeWakeAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastVisitedAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2AppThreadJson = typeof OrchestrationV2AppThreadJson.Type;

export const OrchestrationV2RunJson = OrchestrationV2Run.mapFields((fields) => ({
  ...fields,
  requestedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  workStartedAt: Schema.optional(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2RunJson = typeof OrchestrationV2RunJson.Type;

export const OrchestrationV2RunAttemptJson = OrchestrationV2RunAttempt.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2RunAttemptJson = typeof OrchestrationV2RunAttemptJson.Type;

export const OrchestrationV2ExecutionNodeJson = OrchestrationV2ExecutionNode.mapFields(
  (fields) => ({
    ...fields,
    startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);
export type OrchestrationV2ExecutionNodeJson = typeof OrchestrationV2ExecutionNodeJson.Type;

export const OrchestrationV2SubagentJson = OrchestrationV2Subagent.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
}));
export type OrchestrationV2SubagentJson = typeof OrchestrationV2SubagentJson.Type;

export const OrchestrationV2CheckpointScopeJson = OrchestrationV2CheckpointScope.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2CheckpointScopeJson = typeof OrchestrationV2CheckpointScopeJson.Type;

export const OrchestrationV2ProviderSessionJson = OrchestrationV2ProviderSession.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2ProviderSessionJson = typeof OrchestrationV2ProviderSessionJson.Type;

export const OrchestrationV2ProviderSessionDetachedJson =
  OrchestrationV2ProviderSessionDetached.mapFields((fields) => ({
    ...fields,
    detachedAt: Schema.DateTimeUtcFromString,
  }));
export type OrchestrationV2ProviderSessionDetachedJson =
  typeof OrchestrationV2ProviderSessionDetachedJson.Type;

export const OrchestrationV2ProviderThreadJson = OrchestrationV2ProviderThread.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2ProviderThreadJson = typeof OrchestrationV2ProviderThreadJson.Type;

export const OrchestrationV2ContextHandoffJson = OrchestrationV2ContextHandoff.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2ContextHandoffJson = typeof OrchestrationV2ContextHandoffJson.Type;

export const OrchestrationV2ContextTransferJson = OrchestrationV2ContextTransfer.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
    consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);
export type OrchestrationV2ContextTransferJson = typeof OrchestrationV2ContextTransferJson.Type;

export const OrchestrationV2ProviderTurnJson = OrchestrationV2ProviderTurn.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2ProviderTurnJson = typeof OrchestrationV2ProviderTurnJson.Type;

export const OrchestrationV2RuntimeRequestJson = OrchestrationV2RuntimeRequest.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    resolvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);
export type OrchestrationV2RuntimeRequestJson = typeof OrchestrationV2RuntimeRequestJson.Type;

export const OrchestrationV2ConversationMessageJson = OrchestrationV2ConversationMessage.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2ConversationMessageJson =
  typeof OrchestrationV2ConversationMessageJson.Type;

export const OrchestrationV2CheckpointJson = OrchestrationV2Checkpoint.mapFields((fields) => ({
  ...fields,
  capturedAt: Schema.DateTimeUtcFromString,
}));
export type OrchestrationV2CheckpointJson = typeof OrchestrationV2CheckpointJson.Type;

export const OrchestrationV2CheckpointRollbackRequestJson =
  OrchestrationV2CheckpointRollbackRequest.mapFields((fields) => ({
    ...fields,
    requestedAt: Schema.DateTimeUtcFromString,
  }));

const OrchestrationV2TurnItemJsonBaseFields = {
  ...OrchestrationV2TurnItemBaseFields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
} as const;

export const OrchestrationV2TurnItemJson = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("notification"),
    ...OrchestrationV2Notification.fields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    senderThreadId: Schema.optional(ThreadId),
    idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
    workflowScript: OrchestrationV2ConversationMessage.fields.workflowScript,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    context: Schema.optional(OrchestrationMessageContext),
    attachments: Schema.Array(ChatAttachment),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("reasoning"),
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("proposed_plan"),
    planId: PlanId,
    markdown: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("todo_list"),
    planId: PlanId,
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("user_input_request"),
    requestId: RuntimeRequestId,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    questionAnswer: Schema.optional(UserInputAttachmentAnswerPayload),
    responseMode: Schema.optional(Schema.Literal("message")),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("file_change"),
    fileName: TrimmedNonEmptyString,
    additions: Schema.optional(NonNegativeInt),
    deletions: Schema.optional(NonNegativeInt),
    diffStr: Schema.optional(Schema.String),
    oldStr: Schema.optional(Schema.String),
    newStr: Schema.optional(Schema.String),
    changes: Schema.optional(Schema.Array(OrchestrationV2FileChangeDetail)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.optional(Schema.String),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
    outputIndicatesFailure: Schema.optional(Schema.Boolean),
    exitCode: Schema.optional(Schema.Int),
    /** Set when the command is a monitor, so background work lists it as a monitor. */
    monitor: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("file_search"),
    pattern: Schema.optional(Schema.String),
    results: Schema.optional(Schema.Array(OrchestrationV2FileSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("web_search"),
    patterns: Schema.optional(Schema.Array(Schema.String)),
    results: Schema.optional(Schema.Array(OrchestrationV2WebSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("approval_request"),
    requestId: RuntimeRequestId,
    requestKind: ProviderRequestKind,
    prompt: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    fullAccessOverride: Schema.optional(ProviderApprovalFullAccessOverride),
    appName: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(ProviderApprovalOption)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("checkpoint"),
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
    files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("run_interrupt_request"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("run_interrupt_result"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("compaction"),
    driver: Schema.NullOr(ProviderDriverKind),
    summary: Schema.optional(Schema.String),
    beforeTokenCount: Schema.optional(NonNegativeInt),
    afterTokenCount: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("handoff"),
    contextHandoffId: ContextHandoffId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    fromProviderInstanceIds: Schema.Array(ProviderInstanceId),
    toProviderInstanceId: ProviderInstanceId,
    fromModelSelections: Schema.optional(Schema.Array(ModelSelection)),
    toModel: Schema.optional(Schema.String),
    strategy: Schema.Literals([
      "delta_since_target_last_seen",
      "fork_delta_summary",
      "full_thread_summary",
      "checkpoint_summary",
      "manual_context",
    ]),
    summary: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("fork"),
    source: Schema.Union([
      Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
      Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
      Schema.Struct({
        type: Schema.Literal("provider_thread"),
        providerThreadId: ProviderThreadId,
        providerTurnId: Schema.optional(ProviderTurnId),
      }),
    ]),
    targetThreadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("thread_created"),
    targetThreadId: ThreadId,
    targetRunId: Schema.NullOr(RunId),
    targetProviderInstanceId: ProviderInstanceId,
    targetModel: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    ...OrchestrationV2SecretRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("subagent"),
    subagentId: NodeId,
    origin: Schema.Literals(["provider_native", "app_owned"]),
    driver: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    childThreadId: Schema.NullOr(ThreadId),
    prompt: Schema.String,
    progress: Schema.optional(Schema.String),
    result: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    viewedImagePath: Schema.optional(TrimmedNonEmptyString),
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2TurnItemJson = typeof OrchestrationV2TurnItemJson.Type;

export const OrchestrationV2ProjectedTurnItemJson = OrchestrationV2ProjectedTurnItem.mapFields(
  (fields) => ({
    ...fields,
    item: OrchestrationV2TurnItemJson,
  }),
);
export type OrchestrationV2ProjectedTurnItemJson = typeof OrchestrationV2ProjectedTurnItemJson.Type;

export const OrchestrationV2ThreadProjectionJson = OrchestrationV2ThreadProjection.mapFields(
  (fields) => ({
    ...fields,
    thread: OrchestrationV2AppThreadJson,
    runs: Schema.Array(OrchestrationV2RunJson),
    attempts: Schema.Array(OrchestrationV2RunAttemptJson),
    nodes: Schema.Array(OrchestrationV2ExecutionNodeJson),
    subagents: Schema.Array(OrchestrationV2SubagentJson),
    providerSessions: Schema.Array(OrchestrationV2ProviderSessionJson),
    providerThreads: Schema.Array(OrchestrationV2ProviderThreadJson),
    providerTurns: Schema.Array(OrchestrationV2ProviderTurnJson),
    runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequestJson),
    messages: Schema.Array(OrchestrationV2ConversationMessageJson),
    plans: Schema.Array(OrchestrationV2PlanArtifact),
    turnItems: turnItemArray(OrchestrationV2TurnItemJson),
    checkpointScopes: Schema.Array(OrchestrationV2CheckpointScopeJson),
    checkpoints: Schema.Array(OrchestrationV2CheckpointJson),
    contextHandoffs: Schema.Array(OrchestrationV2ContextHandoffJson),
    contextTransfers: Schema.Array(OrchestrationV2ContextTransferJson),
    visibleTurnItems: projectedTurnItemArray(
      OrchestrationV2ProjectedTurnItemJson,
      OrchestrationV2ProjectedTurnItemJson.mapFields((fields) => ({
        ...fields,
        item: ForwardCompatibleUnion(OrchestrationV2TurnItemJson.members, "type"),
      })),
    ),
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2ThreadProjectionJson = typeof OrchestrationV2ThreadProjectionJson.Type;

export const OrchestrationV2PendingRuntimeRequestSummaryJson =
  OrchestrationV2PendingRuntimeRequestSummary.mapFields((fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
  }));
export type OrchestrationV2PendingRuntimeRequestSummaryJson =
  typeof OrchestrationV2PendingRuntimeRequestSummaryJson.Type;

export const OrchestrationV2LatestVisibleMessageSummaryJson =
  OrchestrationV2LatestVisibleMessageSummary.mapFields((fields) => ({
    ...fields,
    updatedAt: Schema.DateTimeUtcFromString,
  }));
export type OrchestrationV2LatestVisibleMessageSummaryJson =
  typeof OrchestrationV2LatestVisibleMessageSummaryJson.Type;

export const OrchestrationV2ThreadShellJson = OrchestrationV2ThreadShell.mapFields((fields) => ({
  ...fields,
  latestRunRequestedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  latestRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  latestRunCompletedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  activityRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummaryJson),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummaryJson),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  latestUserAuthoredMessageAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  settledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastVisitedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2ThreadShellJson = typeof OrchestrationV2ThreadShellJson.Type;

export const OrchestrationV2ShellSnapshotJson = OrchestrationV2ShellSnapshot.mapFields(
  (fields) => ({
    ...fields,
    threads: Schema.Array(OrchestrationV2ThreadShellJson),
    archivedThreads: Schema.Array(OrchestrationV2ThreadShellJson),
  }),
);
export type OrchestrationV2ShellSnapshotJson = typeof OrchestrationV2ShellSnapshotJson.Type;

const OrchestrationV2JsonEventBaseFields = {
  ...OrchestrationV2EventBase.fields,
  occurredAt: Schema.DateTimeUtcFromString,
} as const;

export const OrchestrationV2RawProviderEventJson = OrchestrationV2RawProviderEvent.mapFields(
  (fields) => ({
    ...fields,
    observedAt: Schema.DateTimeUtcFromString,
  }),
);
export type OrchestrationV2RawProviderEventJson = typeof OrchestrationV2RawProviderEventJson.Type;

export const OrchestrationV2DomainEventJson = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: OrchestrationV2AppThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literals([
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.visited",
      "thread.marked-unread",
      "thread.pull-request-synced",
      "thread.metadata-updated",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ]),
    payload: OrchestrationV2AppThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("thread.pull-request-link-updated"),
    payload: ThreadPullRequestLink,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.created"),
    payload: OrchestrationV2RunJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.updated"),
    payload: OrchestrationV2RunJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.background-work-cancelled"),
    payload: OrchestrationV2RunBackgroundWorkCancelled,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run-attempt.created"),
    payload: OrchestrationV2RunAttemptJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run-attempt.updated"),
    payload: OrchestrationV2RunAttemptJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("node.updated"),
    payload: OrchestrationV2ExecutionNodeJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("subagent.updated"),
    payload: OrchestrationV2SubagentJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literals(["provider-session.attached", "provider-session.updated"]),
    payload: OrchestrationV2ProviderSessionJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-session.detached"),
    payload: OrchestrationV2ProviderSessionDetachedJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-thread.updated"),
    payload: OrchestrationV2ProviderThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-turn.updated"),
    payload: OrchestrationV2ProviderTurnJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("runtime-request.updated"),
    payload: OrchestrationV2RuntimeRequestJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("message.updated"),
    payload: OrchestrationV2ConversationMessageJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("turn-item.updated"),
    payload: OrchestrationV2TurnItemJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("plan.updated"),
    payload: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint-scope.created"),
    payload: OrchestrationV2CheckpointScopeJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint.captured"),
    payload: OrchestrationV2CheckpointJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint.rollback-requested"),
    payload: OrchestrationV2CheckpointRollbackRequestJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-handoff.updated"),
    payload: OrchestrationV2ContextHandoffJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-transfer.created"),
    payload: OrchestrationV2ContextTransferJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-transfer.updated"),
    payload: OrchestrationV2ContextTransferJson,
  }),
]);
export type OrchestrationV2DomainEventJson = typeof OrchestrationV2DomainEventJson.Type;

export const OrchestrationV2StoredEventJson = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  event: OrchestrationV2DomainEventJson,
});
export type OrchestrationV2StoredEventJson = typeof OrchestrationV2StoredEventJson.Type;

export const OrchestrationV2Command = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.stop"),
    commandId: CommandId,
    threadId: ThreadId,
    reason: Schema.optional(Schema.String),
    /**
     * False when the caller stops the thread's delegated tasks itself, as the server's tree walks
     * do under their caller's dispatch limit. Otherwise Stop also stops every task under the thread.
     */
    stopDelegatedTasks: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.create"),
    ...OrchestrationV2CreationFields,
    commandId: CommandId,
    threadId: ThreadId,
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    importedNativeThread: Schema.optional(
      Schema.Struct({
        ref: Schema.Struct({
          driver: ProviderDriverKind,
          nativeId: TrimmedNonEmptyString,
          strength: Schema.Literal("strong"),
        }),
        metadata: Schema.optional(OrchestrationV2ProviderThreadNativeMetadata),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.archive"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.guest-share.close"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.guest-message.dismiss"),
    commandId: CommandId,
    threadId: ThreadId,
    guestMessageId: GuestMessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.unarchive"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.delete"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.settle"),
    commandId: CommandId,
    threadId: ThreadId,
    settledAt: Schema.optional(Schema.DateTimeUtc),
  }),
  /** Rejects changes since snapshotAt or any explicit settled override to preserve user actions. */
  Schema.Struct({
    type: Schema.Literal("thread.auto-settle"),
    commandId: CommandId,
    threadId: ThreadId,
    snapshotAt: Schema.DateTimeUtc,
    settledAt: Schema.optional(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.unsettle"),
    commandId: CommandId,
    threadId: ThreadId,
    reason: Schema.Literal("user"),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.snooze"),
    commandId: CommandId,
    threadId: ThreadId,
    snoozedUntil: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.unsnooze"),
    commandId: CommandId,
    threadId: ThreadId,
    reason: Schema.Literal("user"),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.auto-settle.set"),
    commandId: CommandId,
    threadId: ThreadId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pin"),
    commandId: CommandId,
    threadId: ThreadId,
    orderKey: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.unpin"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pin.reorder"),
    commandId: CommandId,
    threadId: ThreadId,
    orderKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.active.reorder"),
    commandId: CommandId,
    threadId: ThreadId,
    orderKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.visit"),
    commandId: CommandId,
    threadId: ThreadId,
    visitedAt: IsoDateTime,
    // The user opened the thread, as opposed to new activity on an open one.
    // Older servers ignore both fields and only move the read watermark.
    opened: Schema.optional(Schema.Boolean),
    searchQuery: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.mark-unread"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.metadata.update"),
    commandId: CommandId,
    threadId: ThreadId,
    title: Schema.optional(TrimmedNonEmptyString),
    regenerateTitle: Schema.optional(Schema.Boolean),
    branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    expectedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    /** Reject unless no message or run has landed on this thread. */
    expectedEmpty: Schema.optional(Schema.Boolean),
    limitRecovery: Schema.optional(Schema.NullOr(OrchestrationV2LimitRecoveryUpdate)),
    /** Link (object) or unlink (null) a pull request; absent leaves it unchanged. */
    linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request.link"),
    commandId: CommandId,
    threadId: ThreadId,
    ...ThreadPullRequestKey.fields,
    url: TrimmedNonEmptyString,
    source: ThreadPullRequestLinkSource,
    repositoryWebUrl: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request.unlink"),
    commandId: CommandId,
    threadId: ThreadId,
    ...ThreadPullRequestKey.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request-link.sync"),
    commandId: CommandId,
    threadId: ThreadId,
    ...ThreadPullRequestKey.fields,
    snapshot: ThreadPullRequestSnapshot,
    stack: Schema.NullOr(ThreadPullRequestStack),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request.watch"),
    commandId: CommandId,
    threadId: ThreadId,
    ...ThreadPullRequestKey.fields,
    watching: Schema.Boolean,
    link: Schema.optional(
      Schema.Struct({
        url: TrimmedNonEmptyString,
        source: ThreadPullRequestLinkSource,
        repositoryWebUrl: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request.sync"),
    commandId: CommandId,
    threadId: ThreadId,
    projectId: ProjectId,
    snapshotSequence: NonNegativeInt,
    expected: Schema.Struct({
      workspaceRoot: TrimmedNonEmptyString,
      branch: Schema.NullOr(TrimmedNonEmptyString),
      worktreePath: Schema.NullOr(TrimmedNonEmptyString),
      linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
      branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
    }),
    branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
    linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.title.regeneration.complete"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: CommandId,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.runtime-mode.set"),
    commandId: CommandId,
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.interaction-mode.set"),
    commandId: CommandId,
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.model-selection.set"),
    commandId: CommandId,
    threadId: ThreadId,
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.detach"),
    commandId: CommandId,
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("message.dispatch"),
    notification: Schema.optional(OrchestrationV2Notification),
    /** Sends this pending guest message; the server uses the guest's text, not `text`. */
    guestMessageId: Schema.optional(GuestMessageId),
    ...OrchestrationV2CreationFields,
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    senderThreadId: Schema.optional(ThreadId),
    idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    text: Schema.String,
    context: Schema.optional(OrchestrationMessageContext),
    attachments: Schema.Array(ChatAttachment),
    titleSeed: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(ModelSelection),
    sourcePlanRef: Schema.optional(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
    restartContinuationOfRunId: Schema.optional(RunId),
    usageLimitContinuationOfRunId: Schema.optional(RunId),
    manualContinuationOfRunId: Schema.optional(RunId),
    usageLimitRecoveryRequestId: Schema.optional(CommandId),
    deliveryIntent: Schema.optional(Schema.Literals(["auto", "steer", "restart"])),
    delegatedCompletion: Schema.optional(
      Schema.Struct({
        parentRunId: RunId,
        generation: PositiveInt,
        taskIds: Schema.Array(NodeId),
      }),
    ),
    dispatchMode: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("defer_start"),
        workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
      }),
      Schema.Struct({ type: Schema.Literal("steer_active"), targetRunId: RunId }),
      Schema.Struct({ type: Schema.Literal("restart_active"), targetRunId: RunId }),
      Schema.Struct({ type: Schema.Literal("queue_after_active") }),
      Schema.Struct({ type: Schema.Literal("start_immediately") }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("prepared-run.release"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("notification.delivery.accept"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("prepared-run.progress"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    phase: Schema.Literals(["worktree", "setup"]),
  }),
  Schema.Struct({
    type: Schema.Literal("prepared-run.fail"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    failure: OrchestrationV2ProviderFailure,
  }),
  Schema.Struct({
    type: Schema.Literal("prepared-run.retry"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.stop"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    subagentId: NodeId,
  }),
  Schema.Struct({
    type: Schema.Literal("run.interrupt"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    reason: Schema.optional(Schema.String),
    holdQueue: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("queued-message.promote-to-steer"),
    commandId: CommandId,
    threadId: ThreadId,
    queuedRunId: RunId,
    targetRunId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("queue.resume"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("queued-run.start"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("queued-run.reorder"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    beforeRunId: Schema.NullOr(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("queued-run.cancel"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("queued-run.edit"),
    context: Schema.optional(OrchestrationMessageContext),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    text: Schema.String,
    // Replaces all attachments; absent preserves them for older clients editing text.
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    feedback: Schema.optional(Schema.String),
    answers: Schema.optional(ProviderUserInputAnswers),
    attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.user-input.dismiss"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.rollback"),
    restoreFiles: Schema.optional(Schema.Boolean),
    commandId: CommandId,
    threadId: ThreadId,
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.fork"),
    ...OrchestrationV2CreationFields,
    commandId: CommandId,
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
    createdAt: Schema.optional(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.merge_back"),
    ...OrchestrationV2CreationFields,
    commandId: CommandId,
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    createdAt: Schema.optional(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated_task.request"),
    ...OrchestrationV2CreationFields,
    commandId: CommandId,
    parentThreadId: ThreadId,
    parentRunId: RunId,
    parentNodeId: NodeId,
    task: TrimmedNonEmptyString,
    title: Schema.optional(TrimmedNonEmptyString),
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
    // Defaults to settled_only; fire-and-forget wakes require always.
    completionWake: Schema.optional(Schema.Literals(["always", "settled_only"])),
    createdAt: Schema.optional(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated_task.wake-policy"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    taskId: NodeId,
    completionWake: Schema.Literals(["always", "settled_only"]),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated_task.completion-delivery.acknowledge"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    taskId: NodeId,
    observedByRunId: Schema.NullOr(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated_task.completion-delivery.dispose"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    taskId: NodeId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.created.record"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    parentRunId: RunId,
    parentNodeId: NodeId,
    targetThreadId: ThreadId,
    targetRunId: Schema.NullOr(RunId),
  }),

  Schema.Struct({
    type: Schema.Literal("provider.switch"),
    commandId: CommandId,
    threadId: ThreadId,
    modelSelection: ModelSelection,
  }),
]);
export type OrchestrationV2Command = typeof OrchestrationV2Command.Type;

// Excluded from dispatchCommand so only the server can send these.
const OrchestrationV2InternalCommand = Schema.Union([
  // Guest share commands the server issues after checking T3 Connect and the guest token.
  Schema.Struct({
    type: Schema.Literal("thread.guest-share.open"),
    commandId: CommandId,
    threadId: ThreadId,
    shareId: GuestShareId,
    host: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.guest-share.redeem"),
    commandId: CommandId,
    threadId: ThreadId,
    shareId: GuestShareId,
    guestName: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.guest-message.submit"),
    commandId: CommandId,
    threadId: ThreadId,
    shareId: GuestShareId,
    guestMessageId: GuestMessageId,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pull-request-watch.sync"),
    commandId: CommandId,
    threadId: ThreadId,
    ...ThreadPullRequestKey.fields,
    startedAt: IsoDateTime,
    watch: Schema.NullOr(ThreadPullRequestWatch),
    /** With `watch: null`, the state the ended watch keeps instead of its last saved one. */
    endedWatch: Schema.optional(ThreadPullRequestWatch),
    wake: Schema.optional(
      Schema.Struct({
        messageId: MessageId,
        text: Schema.String,
        notification: OrchestrationV2Notification,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.rollback.fail"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: CommandId,
    message: TrimmedNonEmptyString,
  }),
  /** Delivering the answer to request `requestId` failed on its last attempt. */
  Schema.Struct({
    type: Schema.Literal("runtime-request.delivery.fail"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.background-work.settle"),
    commandId: CommandId,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    subagent: Schema.optional(
      Schema.Struct({
        id: NodeId,
        stoppedAt: Schema.DateTimeUtc,
        outcome: Schema.Struct({
          status: Schema.Literals(["completed", "failed", "cancelled"]),
          completedAt: Schema.DateTimeUtc,
          result: Schema.NullOr(Schema.String),
        }),
      }),
    ),
  }),
  /**
   * Internal so no client can mark a request saved without the value being
   * stored.
   */
  Schema.Struct({
    type: Schema.Literal("secret_request.record"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    nodeId: NodeId,
    turnItemId: TurnItemId,
    label: TrimmedNonEmptyString,
    reason: Schema.String,
    placeholder: Schema.optional(Schema.String),
    secretStatus: OrchestrationV2SecretRequestStatus,
  }),
]);
export type OrchestrationV2InternalCommand = typeof OrchestrationV2InternalCommand.Type;

export type OrchestrationV2ServerCommand = OrchestrationV2Command | OrchestrationV2InternalCommand;

export const ORCHESTRATION_V2_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  searchThread: "orchestration.searchThread",
  searchThreadStream: "orchestration.searchThreadStream",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  getThreadFamily: "orchestration.getThreadFamily",
  getWorktreeThreadIds: "orchestration.getWorktreeThreadIds",
  getThreadProjection: "orchestration.getThreadProjection",
  getWorkflowScript: "orchestration.getWorkflowScript",
  stopWorkflow: "orchestration.stopWorkflow",
  getTurnItem: "orchestration.getTurnItem",
  launchThread: "orchestration.launchThread",
  subscribeArchivedShell: "orchestration.subscribeArchivedShell",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeCommandOutput: "orchestration.subscribeCommandOutput",
} as const;

export const OrchestrationV2SubscribeCommandOutputInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
});
export type OrchestrationV2SubscribeCommandOutputInput =
  typeof OrchestrationV2SubscribeCommandOutputInput.Type;

/** Unpersisted stream for expanded rows: replace resets the bounded tail, append extends it, and running:false ends it.
 * Feed both through @t3tools/shared/terminalOutput appendTerminalOutput to preserve cursor and style escapes. */
export const OrchestrationV2CommandOutputFrame = Schema.Struct({
  kind: Schema.Literals(["replace", "append"]),
  text: Schema.String,
  /** Earlier output was dropped to keep the tail bounded. */
  truncated: Schema.Boolean,
  running: Schema.Boolean,
});
export type OrchestrationV2CommandOutputFrame = typeof OrchestrationV2CommandOutputFrame.Type;

export class OrchestrationV2CommandOutputError extends Schema.TaggedError<OrchestrationV2CommandOutputError>()(
  "OrchestrationV2CommandOutputError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2ArchivedShellSnapshot = Schema.Struct({
  schemaVersion: PositiveInt,
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationV2ThreadShell),
});
export type OrchestrationV2ArchivedShellSnapshot = typeof OrchestrationV2ArchivedShellSnapshot.Type;

export const OrchestrationV2ArchivedShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ArchivedShellSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.updated"),
    sequence: NonNegativeInt,
    thread: OrchestrationV2ThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationV2ArchivedShellStreamItem =
  typeof OrchestrationV2ArchivedShellStreamItem.Type;

export const OrchestrationV2ThreadLaunchInput = Schema.Struct({
  commandId: CommandId,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  threadId: Schema.optional(ThreadId),
  reuseExistingThread: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  generateTitle: Schema.optional(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.optional(
    Schema.Struct({
      messageId: Schema.optional(MessageId),
      text: Schema.String,
      context: Schema.optional(OrchestrationMessageContext),
      attachments: Schema.Array(ChatAttachment),
    }),
  ),
});
export type OrchestrationV2ThreadLaunchInput = typeof OrchestrationV2ThreadLaunchInput.Type;

export const OrchestrationV2ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  resumed: Schema.Boolean,
});
export type OrchestrationV2ThreadLaunchResult = typeof OrchestrationV2ThreadLaunchResult.Type;

export const OrchestrationV2DispatchCommandResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type OrchestrationV2DispatchCommandResult = typeof OrchestrationV2DispatchCommandResult.Type;

export const OrchestrationV2GetThreadProjectionInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationV2GetThreadProjectionInput =
  typeof OrchestrationV2GetThreadProjectionInput.Type;

export const OrchestrationV2SubscribeShellInput = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * Snapshots leave out idle subagent children; read them with `getThreadFamily`. Send only to
   * servers that advertise `shellThreadFamilies`.
   */
  omitIdleSubagents: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationV2SubscribeShellInput = typeof OrchestrationV2SubscribeShellInput.Type;

export const OrchestrationV2GetThreadFamilyInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationV2GetThreadFamilyInput = typeof OrchestrationV2GetThreadFamilyInput.Type;

/**
 * The active subagent threads that share the requested thread's `lineage.rootThreadId`: its whole
 * subagent tree, in any run state. An unknown thread has an empty family; a deleted one still
 * names its root.
 */
export const OrchestrationV2ThreadFamily = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationV2ThreadShell),
});
export type OrchestrationV2ThreadFamily = typeof OrchestrationV2ThreadFamily.Type;

export const OrchestrationV2GetWorktreeThreadIdsInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});
export type OrchestrationV2GetWorktreeThreadIdsInput =
  typeof OrchestrationV2GetWorktreeThreadIdsInput.Type;

/** Active threads on a worktree path, including subagent children a shell may leave out. */
export const OrchestrationV2WorktreeThreadIds = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});
export type OrchestrationV2WorktreeThreadIds = typeof OrchestrationV2WorktreeThreadIds.Type;

export const OrchestrationV2SubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  acceptBoundedSnapshot: Schema.optionalKey(Schema.Boolean),
  acceptCompactTurnItems: Schema.optionalKey(Schema.Boolean),
  /** The client restores `*Omitted` bodies from records it already holds. */
  acceptDedupedBodies: Schema.optionalKey(Schema.Boolean),
  acceptCompactIds: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationV2SubscribeThreadInput = typeof OrchestrationV2SubscribeThreadInput.Type;

/**
 * Server-side only: set it on a response for a client that opted in, and the
 * `withRecordIdTable` codec sends that response with an ID table.
 */
const IdTableMarker = Schema.optionalKey(Schema.Literal(true));

export const OrchestrationV2ThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projection: OrchestrationV2ThreadProjection,
  /** With hasMoreHistory/cursor, this projection is a bounded window, not a complete timeline. */
  historyCursor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  hasMoreHistory: Schema.optionalKey(Schema.Boolean),
  latestLocalTurnOrdinal: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type OrchestrationV2ThreadDetailSnapshot = typeof OrchestrationV2ThreadDetailSnapshot.Type;

/** Keep historyCursor opaque; resume events with afterSequence = snapshotSequence. */
export const OrchestrationV2ThreadBoundedSnapshot = withRecordIdTable(
  Schema.Struct({
    snapshotSequence: NonNegativeInt,
    projection: OrchestrationV2ThreadProjection,
    historyCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMoreHistory: Schema.Boolean,
    latestLocalTurnOrdinal: Schema.NullOr(NonNegativeInt),
    /**
     * Set only for clients that opted in: `projection.turnItems` omits the items
     * of local visible rows, which lead the full list. Clients must restore them
     * with `boundedSnapshotProjection` before using the projection.
     */
    turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
    idTable: IdTableMarker,
  }),
  () => "projection",
);
export type OrchestrationV2ThreadBoundedSnapshot = typeof OrchestrationV2ThreadBoundedSnapshot.Type;

export const OrchestrationV2ThreadHistoryPage = withRecordIdTable(
  Schema.Struct({
    snapshotSequence: NonNegativeInt,
    items: projectedTurnItemArray(
      OrchestrationV2ProjectedTurnItem,
      OrchestrationV2ProjectedTurnItem.mapFields((fields) => ({
        ...fields,
        item: ForwardCompatibleUnion(OrchestrationV2TurnItem.members, "type"),
      })),
    ),
    nextCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMoreHistory: Schema.Boolean,
    idTable: IdTableMarker,
  }),
  () => null,
);
export type OrchestrationV2ThreadHistoryPage = typeof OrchestrationV2ThreadHistoryPage.Type;

const knownDomainEventTypes: ReadonlySet<string> = new Set(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);

export function isKnownOrchestrationV2EventType(type: string): boolean {
  return knownDomainEventTypes.has(type);
}

// Skip unknown event or turn-item types while advancing the resume cursor.
const OrchestrationV2UnknownThreadStreamEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  sequence: NonNegativeInt,
  event: Schema.Struct({
    type: Schema.String,
    payload: Schema.optional(Schema.Unknown),
  }).check(
    Schema.makeFilter(
      (event) =>
        !knownDomainEventTypes.has(event.type) ||
        (event.type === "turn-item.updated" && isUnknownTurnItem(event.payload)) ||
        "A known event type must decode in full.",
    ),
  ),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      kind: Schema.Literal("unknown-event"),
      sequence: NonNegativeInt,
      eventType: Schema.String,
    }),
    {
      decode: SchemaGetter.transform((item) => ({
        kind: "unknown-event" as const,
        sequence: item.sequence,
        eventType: item.event.type,
      })),
      encode: SchemaGetter.forbidden(() => "Servers never send unknown thread events."),
    },
  ),
);

export const OrchestrationV2ThreadStreamItem = withRecordIdTable(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("synchronized"),
    }),
    Schema.Struct({
      kind: Schema.Literal("snapshot"),
      snapshotSequence: NonNegativeInt,
      projection: OrchestrationV2ThreadProjection,
      historyCursor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
      hasMoreHistory: Schema.optionalKey(Schema.Boolean),
      latestLocalTurnOrdinal: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
      turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
      idTable: IdTableMarker,
    }),
    Schema.Struct({
      kind: Schema.Literal("event"),
      sequence: NonNegativeInt,
      event: OrchestrationV2DomainEvent,
    }),
    OrchestrationV2UnknownThreadStreamEvent,
  ]),
  (item) => (item.kind === "snapshot" ? "projection" : undefined),
);
export type OrchestrationV2ThreadStreamItem = typeof OrchestrationV2ThreadStreamItem.Type;

export class OrchestrationV2DispatchCommandError extends Schema.TaggedError<OrchestrationV2DispatchCommandError>()(
  "OrchestrationV2DispatchCommandError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetThreadProjectionError extends Schema.TaggedError<OrchestrationV2GetThreadProjectionError>()(
  "OrchestrationV2GetThreadProjectionError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetShellSnapshotError extends Schema.TaggedError<OrchestrationV2GetShellSnapshotError>()(
  "OrchestrationV2GetShellSnapshotError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2ThreadLaunchError extends Schema.TaggedError<OrchestrationV2ThreadLaunchError>()(
  "OrchestrationV2ThreadLaunchError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2StopWorkflowInput = Schema.Struct({
  threadId: ThreadId,
  subagentId: NodeId,
});
export type OrchestrationV2StopWorkflowInput = typeof OrchestrationV2StopWorkflowInput.Type;

export class OrchestrationV2StopWorkflowError extends Schema.TaggedError<OrchestrationV2StopWorkflowError>()(
  "OrchestrationV2StopWorkflowError",
  {
    threadId: ThreadId,
    subagentId: NodeId,
    reason: Schema.Literals(["not-running", "unsupported", "unavailable", "stop-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-running":
        return "This workflow is no longer running.";
      case "unsupported":
        return "This provider cannot stop a workflow.";
      case "unavailable":
        return "This workflow has no live provider task.";
      case "stop-failed":
        return "Failed to stop the workflow.";
    }
  }
}

export const OrchestrationV2RpcError = Schema.Union([
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2ThreadLaunchError,
  OrchestrationV2StopWorkflowError,
]);
export type OrchestrationV2RpcError = typeof OrchestrationV2RpcError.Type;

export const OrchestrationV2GetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationV2GetWorkflowScriptInput =
  typeof OrchestrationV2GetWorkflowScriptInput.Type;

export const OrchestrationV2GetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationV2GetWorkflowScriptResult =
  typeof OrchestrationV2GetWorkflowScriptResult.Type;

const WORKFLOW_FILE_ERROR_MESSAGES = {
  "invalid-path": "Workflow files must be absolute paths with the expected extension.",
  "root-unavailable": "Workflow file root unavailable.",
  "not-found": "Workflow file not found.",
  "outside-root": "Path is outside the workflow files root.",
  "wrong-extension": "Resolved file has the wrong extension.",
  "not-regular-file": "Workflow file is not a regular file.",
  "changed-during-read": "Workflow file changed between resolution and open.",
  "read-failed": "Workflow file read failed.",
} as const;

export class OrchestrationWorkflowFileError extends Schema.TaggedError<OrchestrationWorkflowFileError>()(
  "OrchestrationWorkflowFileError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "wrong-extension",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_FILE_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationV2GetTurnItemInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
  revision: Schema.optional(Schema.String),
});
export type OrchestrationV2GetTurnItemInput = typeof OrchestrationV2GetTurnItemInput.Type;

export const OrchestrationV2GetTurnItemResult = Schema.Struct({
  item: Schema.NullOr(OrchestrationV2TurnItem),
});
export type OrchestrationV2GetTurnItemResult = typeof OrchestrationV2GetTurnItemResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedError<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationV2SearchThreadInput = Schema.Struct({
  threadId: ThreadId,
  skills: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMaxLength(200)),
        displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      }),
    ).check(Schema.isMaxLength(1_000)),
  ),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  index: Schema.optionalKey(NonNegativeInt),
  offset: Schema.optionalKey(Schema.Int),
  start: Schema.optionalKey(
    Schema.Struct({ entryId: TrimmedNonEmptyString, occurrence: NonNegativeInt }),
  ),
});
export type OrchestrationV2SearchThreadInput = typeof OrchestrationV2SearchThreadInput.Type;

export const OrchestrationV2ThreadFindMatch = Schema.Struct({
  entryId: TrimmedNonEmptyString,
  runId: Schema.NullOr(RunId),
  occurrence: NonNegativeInt,
});
export const OrchestrationV2SearchThreadResult = Schema.Struct({
  complete: Schema.optionalKey(Schema.Boolean),
  snapshotSequence: NonNegativeInt,
  totalMatches: NonNegativeInt,
  activeIndex: NonNegativeInt,
  match: Schema.NullOr(OrchestrationV2ThreadFindMatch),
  navigation: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        entryId: TrimmedNonEmptyString,
        runId: Schema.NullOr(RunId),
        startIndex: NonNegativeInt,
        count: NonNegativeInt,
      }),
    ).check(Schema.isMaxLength(17)),
  ),
});
export type OrchestrationV2SearchThreadResult = typeof OrchestrationV2SearchThreadResult.Type;

export class OrchestrationV2SearchThreadError extends Schema.TaggedError<OrchestrationV2SearchThreadError>()(
  "OrchestrationV2SearchThreadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not search this thread. Please retry.";
  }
}

export const OrchestrationV2RpcSchemas = {
  searchThread: {
    input: OrchestrationV2SearchThreadInput,
    output: OrchestrationV2SearchThreadResult,
  },
  dispatchCommand: {
    input: OrchestrationV2Command,
    output: OrchestrationV2DispatchCommandResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationV2ArchivedShellSnapshot,
  },
  getThreadFamily: {
    input: OrchestrationV2GetThreadFamilyInput,
    output: OrchestrationV2ThreadFamily,
  },
  getWorktreeThreadIds: {
    input: OrchestrationV2GetWorktreeThreadIdsInput,
    output: OrchestrationV2WorktreeThreadIds,
  },
  getThreadProjection: {
    input: OrchestrationV2GetThreadProjectionInput,
    output: OrchestrationV2ThreadProjection,
  },
  stopWorkflow: {
    input: OrchestrationV2StopWorkflowInput,
    output: Schema.Void,
  },
  getWorkflowScript: {
    input: OrchestrationV2GetWorkflowScriptInput,
    output: OrchestrationV2GetWorkflowScriptResult,
  },
  getTurnItem: {
    input: OrchestrationV2GetTurnItemInput,
    output: OrchestrationV2GetTurnItemResult,
  },
  launchThread: {
    input: OrchestrationV2ThreadLaunchInput,
    output: OrchestrationV2ThreadLaunchResult,
  },
  subscribeArchivedShell: {
    input: Schema.Struct({}),
    output: OrchestrationV2ArchivedShellStreamItem,
  },
  subscribeShell: {
    input: OrchestrationV2SubscribeShellInput,
    output: OrchestrationV2ShellStreamItem,
  },
  subscribeThread: {
    input: OrchestrationV2SubscribeThreadInput,
    output: OrchestrationV2ThreadStreamItem,
  },
  subscribeCommandOutput: {
    input: OrchestrationV2SubscribeCommandOutputInput,
    output: OrchestrationV2CommandOutputFrame,
  },
} as const;

export const ProviderReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("expect_outbound"),
    label: Schema.optional(TrimmedNonEmptyString),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("emit_inbound"),
    label: Schema.optional(TrimmedNonEmptyString),
    frame: Schema.Unknown,
    afterMs: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_exit"),
    status: Schema.Literals(["success", "error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type ProviderReplayEntry = typeof ProviderReplayEntry.Type;

export const ProviderReplayTranscript = Schema.Struct({
  provider: TrimmedNonEmptyString,
  protocol: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  scenario: TrimmedNonEmptyString,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type ProviderReplayTranscript = typeof ProviderReplayTranscript.Type;

export const ProviderReplayTranscriptHeader = Schema.Struct({
  type: Schema.Literal("transcript_start"),
  provider: TrimmedNonEmptyString,
  protocol: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  scenario: TrimmedNonEmptyString,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ProviderReplayTranscriptHeader = typeof ProviderReplayTranscriptHeader.Type;

export const ProviderReplayNdjsonRecord = Schema.Union([
  ProviderReplayTranscriptHeader,
  ProviderReplayEntry,
]);
export type ProviderReplayNdjsonRecord = typeof ProviderReplayNdjsonRecord.Type;
