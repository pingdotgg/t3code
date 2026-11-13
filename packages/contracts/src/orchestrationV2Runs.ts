// Runs, attempts, execution nodes, subagents and provider sessions.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  CheckpointId,
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  EnvironmentId,
  NodeId,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";
import { ThreadTokenUsageSnapshot } from "./providerRuntime.ts";

import {
  OrchestrationV2Actor,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderRef,
} from "./orchestrationV2Base.ts";

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

const OrchestrationV2DelegatedCompletionTaskDeliveryState = Schema.Literals([
  "pending",
  "claimed",
  "acknowledged",
  "delivered",
  "disposed",
]);

type OrchestrationV2DelegatedCompletionTaskDeliveryState =
  typeof OrchestrationV2DelegatedCompletionTaskDeliveryState.Type;

const OrchestrationV2DelegatedCompletionTaskDelivery = Schema.Struct({
  state: OrchestrationV2DelegatedCompletionTaskDeliveryState,
  observedByRunId: Schema.NullOr(RunId),
});

type OrchestrationV2DelegatedCompletionTaskDelivery =
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

/**
 * Work started now would run in the project checkout, not the worktree the thread asked for. A
 * failed or interrupted setup leaves the request standing until a worktree exists.
 */
export function orchestrationV2WorktreePending(
  worktreePath: string | null,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "workspacePreparation">>,
): boolean {
  return (
    worktreePath === null &&
    runs.some(
      (run) =>
        (run.status === "preparing" || run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    )
  );
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
  effort: Schema.optional(TrimmedNonEmptyString),
  speed: Schema.optional(TrimmedNonEmptyString),
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
export const DedupedBodyMarker = Schema.optionalKey(Schema.Literal(true));

/**
 * Where an app-owned task runs when it runs in a linked environment instead
 * of in a child thread here: that environment and the ordinary thread it runs
 * as there. Such a task has no `childThreadId`.
 */
export const OrchestrationV2RemoteTaskChild = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  label: Schema.String,
  /** The run there that carries the task; absent on tasks recorded before it was kept. */
  runId: Schema.optional(RunId),
  /**
   * Nothing is left to stop there: a stop reached it, was refused for good, or the thread
   * or link is gone. A run ending there by itself sets it too, unless the task here was
   * cancelled or stopped and still owes a stop, which its follower keeps sending across
   * restarts. `false`: a Stop here owes one to a task that already had its result.
   */
  stoppedThere: Schema.optional(Schema.Boolean),
  /**
   * Stops asked for here once the task had its result. The count names the
   * one owed, so each reaches the thread there once however often it is sent.
   */
  stopCount: Schema.optional(NonNegativeInt),
});

export type OrchestrationV2RemoteTaskChild = typeof OrchestrationV2RemoteTaskChild.Type;

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
  remoteChild: Schema.optional(OrchestrationV2RemoteTaskChild),
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

export function kindUnionWithFallback<
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
  claudeAttachmentBudget: Schema.optional(
    Schema.Struct({ bytesUsed: NonNegativeInt, pagesUsed: NonNegativeInt }),
  ),
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
