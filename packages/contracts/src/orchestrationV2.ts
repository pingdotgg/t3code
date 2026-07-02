import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
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
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "./checkpointDiff.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

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

export const OrchestrationV2ContextTransfer = Schema.Struct({
  id: ContextTransferId,
  type: OrchestrationV2ContextTransferType,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ContextSourcePoint,
  basePoint: Schema.NullOr(OrchestrationV2ContextSourcePoint),
  sourceProviderInstanceId: Schema.NullOr(ProviderInstanceId),
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
});
export type OrchestrationV2ProviderCapabilities = typeof OrchestrationV2ProviderCapabilities.Type;

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
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
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
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2AppThread = typeof OrchestrationV2AppThread.Type;

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
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  checkpointId: Schema.NullOr(CheckpointId),
  contextHandoffId: Schema.NullOr(ContextHandoffId),
  sourcePlanRef: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      planId: PlanId,
    }),
  ),
});
export type OrchestrationV2Run = typeof OrchestrationV2Run.Type;

export const OrchestrationV2RunAttempt = Schema.Struct({
  id: RunAttemptId,
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
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  progress: Schema.optional(Schema.String),
  result: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2Subagent = typeof OrchestrationV2Subagent.Type;

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
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ProviderThread = typeof OrchestrationV2ProviderThread.Type;

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
});
export type OrchestrationV2ProviderTurn = typeof OrchestrationV2ProviderTurn.Type;

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
    Schema.Struct({ type: Schema.Literal("live"), providerSessionId: ProviderSessionId }),
    Schema.Struct({ type: Schema.Literal("not_resumable"), reason: Schema.String }),
  ]),
  createdAt: Schema.DateTimeUtc,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2RuntimeRequest = typeof OrchestrationV2RuntimeRequest.Type;

export const OrchestrationV2ConversationMessage = Schema.Struct({
  ...OrchestrationV2CreationFields,
  id: MessageId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  streaming: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ConversationMessage = typeof OrchestrationV2ConversationMessage.Type;

export const OrchestrationV2PlanStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "completed"]),
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
    }),
  ),
});
export type OrchestrationV2UserInputQuestion = typeof OrchestrationV2UserInputQuestion.Type;

const OrchestrationV2PlanArtifactBaseFields = {
  id: PlanId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  status: Schema.Literals(["draft", "active", "completed", "superseded"]),
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

export class OrchestrationV2CheckpointUnavailableError extends Schema.TaggedErrorClass<OrchestrationV2CheckpointUnavailableError>()(
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
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestrationV2TurnItemStatus = typeof OrchestrationV2TurnItemStatus.Type;

export const OrchestrationV2ProviderFailureClass = Schema.Literals([
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

/**
 * Transport-safe failure information suitable for persistence and display.
 * Producers must redact credentials before constructing this value. The
 * schema bounds every provider-controlled string as a second line of defense.
 */
export const OrchestrationV2ProviderFailure = Schema.Struct({
  class: OrchestrationV2ProviderFailureClass,
  message: OrchestrationV2ProviderFailureMessage,
  code: Schema.NullOr(OrchestrationV2ProviderFailureCode),
  retryable: Schema.NullOr(Schema.Boolean),
});
export type OrchestrationV2ProviderFailure = typeof OrchestrationV2ProviderFailure.Type;

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

export const OrchestrationV2TurnItem = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
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
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Int),
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
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("checkpoint"),
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
    files: Schema.Array(OrchestrationV2CheckpointFileSummary),
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
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
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
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
  }),
]);
export type OrchestrationV2TurnItem = typeof OrchestrationV2TurnItem.Type;

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
      "thread.metadata-updated",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
    ]),
    payload: OrchestrationV2AppThread,
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
  turnItems: Schema.Array(OrchestrationV2TurnItem),
  checkpointScopes: Schema.Array(OrchestrationV2CheckpointScope),
  checkpoints: Schema.Array(OrchestrationV2Checkpoint),
  contextHandoffs: Schema.Array(OrchestrationV2ContextHandoff),
  contextTransfers: Schema.Array(OrchestrationV2ContextTransfer),
  visibleTurnItems: Schema.Array(OrchestrationV2ProjectedTurnItem),
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2ThreadProjection = typeof OrchestrationV2ThreadProjection.Type;

export const OrchestrationV2ShellThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestrationV2ShellThreadStatus = typeof OrchestrationV2ShellThreadStatus.Type;

export const OrchestrationV2PendingRuntimeRequestSummary = Schema.Struct({
  id: RuntimeRequestId,
  kind: OrchestrationV2RuntimeRequest.fields.kind,
  createdAt: Schema.DateTimeUtc,
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
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: Schema.NullOr(OrchestrationV2AppThread.fields.forkedFrom),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  status: OrchestrationV2ShellThreadStatus,
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummary),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummary),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtc),
  hasActionableProposedPlan: Schema.Boolean,
  itemCount: NonNegativeInt,
  visibleItemCount: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrchestrationV2ThreadShell = typeof OrchestrationV2ThreadShell.Type;

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
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
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
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2AppThreadJson = typeof OrchestrationV2AppThreadJson.Type;

export const OrchestrationV2RunJson = OrchestrationV2Run.mapFields((fields) => ({
  ...fields,
  requestedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
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
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
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
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Int),
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
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
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
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
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
    turnItems: Schema.Array(OrchestrationV2TurnItemJson),
    checkpointScopes: Schema.Array(OrchestrationV2CheckpointScopeJson),
    checkpoints: Schema.Array(OrchestrationV2CheckpointJson),
    contextHandoffs: Schema.Array(OrchestrationV2ContextHandoffJson),
    contextTransfers: Schema.Array(OrchestrationV2ContextTransferJson),
    visibleTurnItems: Schema.Array(OrchestrationV2ProjectedTurnItemJson),
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
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummaryJson),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummaryJson),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));
export type OrchestrationV2ThreadShellJson = typeof OrchestrationV2ThreadShellJson.Type;

export const OrchestrationV2ThreadShellSnapshotJson = OrchestrationV2ThreadShellSnapshot.mapFields(
  (fields) => ({
    ...fields,
    threads: Schema.Array(OrchestrationV2ThreadShellJson),
    archivedThreads: Schema.Array(OrchestrationV2ThreadShellJson),
  }),
);
export type OrchestrationV2ThreadShellSnapshotJson =
  typeof OrchestrationV2ThreadShellSnapshotJson.Type;

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
      "thread.metadata-updated",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
    ]),
    payload: OrchestrationV2AppThreadJson,
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
  }),
  Schema.Struct({
    type: Schema.Literal("thread.archive"),
    commandId: CommandId,
    threadId: ThreadId,
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
    type: Schema.Literal("thread.metadata.update"),
    commandId: CommandId,
    threadId: ThreadId,
    title: Schema.optional(TrimmedNonEmptyString),
    branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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
    ...OrchestrationV2CreationFields,
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    modelSelection: Schema.optional(ModelSelection),
    sourcePlanRef: Schema.optional(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
    dispatchMode: Schema.Union([
      Schema.Struct({ type: Schema.Literal("defer_start") }),
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
    type: Schema.Literal("run.interrupt"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("queued-message.promote-to-steer"),
    commandId: CommandId,
    threadId: ThreadId,
    queuedRunId: RunId,
    targetRunId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("queued-run.reorder"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    beforeRunId: Schema.NullOr(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    commandId: CommandId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.rollback"),
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
    createdAt: Schema.optional(Schema.DateTimeUtc),
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

export const ORCHESTRATION_V2_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  getThreadProjection: "orchestration.getThreadProjection",
  launchThread: "orchestration.launchThread",
  subscribeArchivedShell: "orchestration.subscribeArchivedShell",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

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

export const OrchestrationV2ThreadLaunchInput = Schema.Struct({
  commandId: CommandId,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  threadId: Schema.optional(ThreadId),
  reuseExistingThread: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.optional(
    Schema.Struct({
      messageId: Schema.optional(MessageId),
      text: Schema.String,
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

export const OrchestrationV2ThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshotSequence: NonNegativeInt,
    projection: OrchestrationV2ThreadProjection,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    sequence: NonNegativeInt,
    event: OrchestrationV2DomainEvent,
  }),
]);
export type OrchestrationV2ThreadStreamItem = typeof OrchestrationV2ThreadStreamItem.Type;

export class OrchestrationV2DispatchCommandError extends Schema.TaggedErrorClass<OrchestrationV2DispatchCommandError>()(
  "OrchestrationV2DispatchCommandError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetThreadProjectionError extends Schema.TaggedErrorClass<OrchestrationV2GetThreadProjectionError>()(
  "OrchestrationV2GetThreadProjectionError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetShellSnapshotError extends Schema.TaggedErrorClass<OrchestrationV2GetShellSnapshotError>()(
  "OrchestrationV2GetShellSnapshotError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2ThreadLaunchError extends Schema.TaggedErrorClass<OrchestrationV2ThreadLaunchError>()(
  "OrchestrationV2ThreadLaunchError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2RpcError = Schema.Union([
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2ThreadLaunchError,
]);
export type OrchestrationV2RpcError = typeof OrchestrationV2RpcError.Type;

export const OrchestrationV2RpcSchemas = {
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
  getThreadProjection: {
    input: OrchestrationV2GetThreadProjectionInput,
    output: OrchestrationV2ThreadProjection,
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
    input: Schema.Struct({}),
    output: OrchestrationV2ShellStreamItem,
  },
  subscribeThread: {
    input: OrchestrationV2GetThreadProjectionInput,
    output: OrchestrationV2ThreadStreamItem,
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
