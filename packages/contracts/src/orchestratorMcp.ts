import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { AuthMcpClientAccess } from "./auth.ts";
import {
  ContextTransferId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { ProviderInteractionMode, ProviderRequestKind, RuntimeMode } from "./providerPolicy.ts";
import { PullRequestState } from "./pullRequest.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
} from "./threadPullRequest.ts";
import { hasOnlyPairedSurrogates } from "./threadMetadataMcp.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import { PeerLinkOrigin, TailnetDeviceAccess, TailnetDeviceStatus } from "./tailnetDevices.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Reuse it to retry the same call. A new call gets a new key." });

// OpenCode 1.15 serializes nested MCP union objects as JSON strings; decode that form at the boundary.
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description: "JSON-text schedule. Prefer the object form.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger: {type:'interval',everyMs}, {type:'fixed_time',timeOfDay,weekdays?}, {type:'once',runAt}, or {type:'webhook'}.",
});

const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Provider instance id from `orchestrator_capabilities`.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Prefer `providerInstanceId`.",
    }),
  ),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description:
        "Options from `orchestrator_capabilities`, such as {effort:'max'}. Given values override inherited. [] or {} clears.",
    }),
  ),
  environmentId: Schema.optional(
    EnvironmentId.annotate({
      description:
        "Linked environment to run in. Provider and model default to yours; others come from `orchestrator_capabilities` with this `environmentId`.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "With `environmentId`: its project to run in. Default: the one with this project's repository.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpProfileId = TrimmedNonEmptyString.annotate({
  description:
    "Agent (profileId from t3_list_agents) that runs this work with its own instructions, skills, model, and modes. Explicit target, runtimeMode, or interactionMode values override the agent's.",
});

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt.annotate({
    description: "Self-contained task for one delegated child agent/subagent.",
  }),
  profileId: Schema.optional(OrchestratorMcpProfileId),
  target: Schema.optional(OrchestratorMcpTarget),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "'shared' (default): parent checkout. 'worktree': new prepared checkout from the parent commit, for a separate checkout or PR per child. Uncommitted edits stay out.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Default 'async'. 'wait' only if this turn needs the result. A question or approval ends the wait.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description: "Mode 'wait' only. Default 10 min. A timeout does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Omit unless the user asks for a supervised child. Narrow modes pause for human approval, not read-only. Above yours is rejected.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

// Set only on results for still-running tasks whose completion will wake the parent.
export const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT =
  "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
const OrchestratorMcpRunningTaskNext = Schema.Literal(ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

export const OrchestratorMcpWorkState = Schema.Literals([
  "working",
  "waiting_for_children",
  "result_available",
]);

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  taskId: NodeId,
  /** Null for a task that runs in a linked environment; see `remoteChild`. */
  childThreadId: Schema.NullOr(ThreadId),
  /** The linked environment and thread a remote task runs as. */
  remoteChild: Schema.optional(
    Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId, label: Schema.String }),
  ),
  link: Schema.optional(Schema.String),
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: OrchestratorMcpWorkState,
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  hasPendingQuestion: Schema.Boolean.annotate({
    description:
      "A question blocks the child and ends a wait. Answer via `t3_pending_request` on `childThreadId`, or the user does.",
  }),
  pendingApproval: Schema.NullOr(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind, runId: RunId }),
  ).annotate({
    description: "Oldest pending approval, or null. Ends a wait. Grants no approval rights.",
  }),
  waitTimedOut: Schema.Boolean.annotate({
    description: "True only on the timed-out wait call. The child keeps running.",
  }),
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  profileId: Schema.optional(OrchestratorMcpProfileId),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description: "Project to use. Default: your thread's project. Required outside a thread.",
  }),
);

/**
 * A linked environment to act in instead of this one. The tools that take it
 * forward the call there, where the link's access and the caller's own modes
 * both apply.
 */
export const OrchestratorMcpEnvironmentTarget = Schema.optional(
  EnvironmentId.annotate({
    description:
      "Linked environment to act in. Omit for this one. Ids are then that environment's.",
  }),
);

export const OrchestratorMcpThreadListInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: OrchestratorMcpProjectTarget,
  allProjects: Schema.optional(Schema.Boolean),
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

/** state is null until the host is read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  link: Schema.optional(Schema.String),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  /**
   * The chat this one belongs to. `relationshipToParent` says how: `"child"` is
   * a separate agent chat with its own context that a parent launched or nested
   * (it shows inside the parent's card), `"subagent"` is a helper inside the
   * parent's own run, and `"fork"` is a copy of another thread's conversation.
   */
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["child", "subagent", "fork"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  /** null with `allProjects`. */
  projectId: Schema.NullOr(ProjectId),
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

/**
 * Threads on another environment are reached through the T3 app connected to both, so only
 * what that app relays is available there: see apps/server/src/mcp/agents/remoteThreads.ts.
 */
const OrchestratorMcpThreadEnvironment = Schema.optional(
  EnvironmentId.annotate({
    description:
      "Environment the thread runs on, as returned by t3_thread_launch or t3_list_environments. Omit for this environment. Another environment is reached through your connected T3 app.",
  }),
);
// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  environmentId: OrchestratorMcpThreadEnvironment,
  threadId: ThreadId,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  tail: Schema.optional(
    Schema.Boolean.annotate({ description: "Latest `limit` items; hasMore means older ones." }),
  ),
  limit: Schema.optional(clampedPositiveInt(100)).annotate({
    description: "Max items, 1 to 100.",
  }),
  runLimit: Schema.optional(clampedPositiveInt(50)).annotate({
    description: "Max recent runs, 1 to 50.",
  }),
  maxCharsPerItem: Schema.optional(clampedPositiveInt(50_000)).annotate({
    description: "Max chars per item, 1 to 50000.",
  }),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  link: Schema.optional(Schema.String),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /**
   * The chat this one belongs to. `relationshipToParent` says how: `"child"` is
   * a separate agent chat with its own context that a parent launched or nested
   * (it shows inside the parent's card), `"subagent"` is a helper inside the
   * parent's own run, and `"fork"` is a copy of another thread's conversation.
   */
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["child", "subagent", "fork"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  senderThreadId: Schema.optional(ThreadId),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpLocalThreadReadResult = Schema.Struct({
  environmentId: EnvironmentId,
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpLocalThreadReadResult = typeof OrchestratorMcpLocalThreadReadResult.Type;

/** A thread on another environment: its messages, runs and state as the relaying app reports them. */
export const OrchestratorMcpRemoteThreadReadResult = Schema.Struct({
  environmentId: EnvironmentId,
  thread: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    title: Schema.String,
    status: OrchestratorMcpThreadStatus,
    latestRunId: Schema.NullOr(RunId),
    providerInstanceId: ProviderInstanceId,
    model: Schema.String,
    runtimeMode: Schema.NullOr(RuntimeMode),
    interactionMode: Schema.NullOr(ProviderInteractionMode),
    parentThreadId: Schema.NullOr(ThreadId),
    parentEnvironmentId: Schema.NullOr(EnvironmentId),
    /** The agent the thread runs as; null for a plain thread. */
    profile: Schema.NullOr(Schema.Struct({ profileId: Schema.String, profileName: Schema.String })),
    pendingRequestCount: NonNegativeInt,
    settled: Schema.Boolean,
    createdAt: Schema.NullOr(Schema.String),
    updatedAt: Schema.NullOr(Schema.String),
  }),
  recentRuns: Schema.Array(
    Schema.Struct({
      runId: RunId,
      status: OrchestrationV2RunStatus,
      providerInstanceId: ProviderInstanceId,
      requestedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  items: Schema.Array(
    Schema.Struct({
      position: NonNegativeInt,
      messageId: MessageId,
      runId: Schema.NullOr(RunId),
      type: Schema.Literals(["user_message", "assistant_message"]),
      text: Schema.String,
      textTruncated: Schema.Boolean,
      nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
      updatedAt: Schema.NullOr(Schema.String),
    }),
  ),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpRemoteThreadReadResult =
  typeof OrchestratorMcpRemoteThreadReadResult.Type;

export const OrchestratorMcpThreadReadResult = Schema.Union([
  OrchestratorMcpLocalThreadReadResult,
  OrchestratorMcpRemoteThreadReadResult,
]);
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  environmentId: OrchestratorMcpThreadEnvironment,
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpLocalThreadSendResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  messageId: MessageId,
  runId: RunId,
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpLocalThreadSendResult = typeof OrchestratorMcpLocalThreadSendResult.Type;

/** Another environment accepts the message and starts or queues its turn there. */
export const OrchestratorMcpRemoteThreadSendResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  delivery: Schema.Literal("accepted"),
});

export const OrchestratorMcpThreadSendResult = Schema.Union([
  OrchestratorMcpLocalThreadSendResult,
  OrchestratorMcpRemoteThreadSendResult,
]);
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  environmentId: OrchestratorMcpThreadEnvironment,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Finite),
  untilDelegatedWorkSettled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also wait for its delegated and background tasks and their completions to settle. `resultRun` then names the run with its final answer.",
    }),
  ),
  returnOnQuestion: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true: return on a question or approval.",
    }),
  ),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
  /** With untilDelegatedWorkSettled, once settled: the run whose reply is the thread's result. */
  resultRun: Schema.optional(Schema.Struct({ runId: RunId, status: OrchestrationV2RunStatus })),
  workState: Schema.optional(
    OrchestratorMcpWorkState.annotate({
      description:
        "With untilDelegatedWorkSettled, once the run ended. working: another run continues the thread; waiting_for_children: its tasks or awaited background work remain.",
    }),
  ),
  unreachable: Schema.optional(
    Schema.String.annotate({
      description:
        "The thread's environment did not answer; work there continues, so call again. status and runId are the last seen.",
    }),
  ),
  hasPendingQuestion: Schema.optional(Schema.Boolean),
  pendingRequestId: Schema.optional(RuntimeRequestId),
  pendingApproval: Schema.optional(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind }),
  ).annotate({ description: "Oldest pending approval. Grants no approval rights." }),
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  /**
   * Stop the thread as its Stop button does instead: interrupt its running
   * turn whichever run that is, hold its queued messages, end its pull request
   * watches and stop every task it delegated. `runId` is then not used.
   */
  stop: Schema.optional(Schema.Boolean),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  search: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Match model ids and labels. Replaces the short list.",
    }),
  ),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpModelOption = Schema.Struct({
  id: Schema.String,
  values: Schema.Array(ProviderOptionSelectionValue),
  default: Schema.optional(ProviderOptionSelectionValue),
});
export type OrchestratorMcpModelOption = typeof OrchestratorMcpModelOption.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Omitted when it only restates the id. */
      label: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
    }),
  ),
  /** Models left out of `models`: unlisted visible models, or matches past the cap with `search`. */
  omittedModels: Schema.optional(NonNegativeInt),
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpEnvironmentLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Whether it answered just now. An expired link must be linked again there. */
  status: Schema.Literals(["reachable", "unreachable", "expired"]),
  /** The most the linked environment lets this one's agents do there. */
  access: AuthMcpClientAccess,
  /** tailnet: linked automatically as one of the user's tailnet devices. paired: with a pairing code. */
  origin: PeerLinkOrigin,
  expiresAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpEnvironmentLink = typeof OrchestratorMcpEnvironmentLink.Type;

/** One of the user's own machines on their tailnet, linked or not. */
export const OrchestratorMcpTailnetDevice = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  status: TailnetDeviceStatus,
  /** What it may do on the user's machines; revoked: cut off everywhere. */
  access: TailnetDeviceAccess,
  /** This environment links to it, and how; null: not linked from here. */
  outgoing: Schema.NullOr(PeerLinkOrigin),
  /** It holds a live session here. */
  incoming: Schema.Boolean,
});
export type OrchestratorMcpTailnetDevice = typeof OrchestratorMcpTailnetDevice.Type;

export const OrchestratorMcpEnvironmentLinksResult = Schema.Struct({
  environmentId: EnvironmentId,
  links: Schema.Array(OrchestratorMcpEnvironmentLink),
  devices: Schema.Array(OrchestratorMcpTailnetDevice),
  /** What to do when the machine the user means is not among `links`. */
  notListed: Schema.String,
});
export type OrchestratorMcpEnvironmentLinksResult =
  typeof OrchestratorMcpEnvironmentLinksResult.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  inheritedOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  /** Agents that can run delegated or new-thread work; pass profileId to use one. */
  agents: Schema.Array(
    Schema.Struct({
      profileId: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      description: Schema.optional(Schema.String),
    }),
  ),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt,
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Default true: runs post in this thread. False: new thread per run. Not with profileId.",
    }),
  ),
  profileId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Agent (from t3_list_agents) that runs the task with its own instructions and modes. Its first run creates the agent's thread; later runs post there.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** `schedule_task` creates a task, or updates one when `scheduledTaskId` is given. */
export const OrchestratorMcpSaveScheduledTaskInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  prompt: Schema.optional(OrchestratorMcpPrompt),
  schedule: Schema.optional(OrchestratorMcpSchedule),
});
export type OrchestratorMcpSaveScheduledTaskInput =
  typeof OrchestratorMcpSaveScheduledTaskInput.Type;

export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  profileId: Schema.optional(Schema.String).annotate({
    description: "Agent that runs the task. Absent: runs post to boundThreadId or a new thread.",
  }),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: no T3 Connect tunnel. The user must enable T3 Connect remote access.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Default: your thread's project, or all outside a thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
  profileId: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "Card title, such as 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "What it is for and where to get it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.optional(Schema.Literals(["secretRef", "file"])).annotate({
    description:
      'secretRef (default) for a T3 tool. file for a shell CLI: read the path in your command, e.g. TOKEN="$(cat <file>)" wrangler whoami.',
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "Default 10 min." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Retry key for this ask. New key after a timeout or cancel.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    secretRef: SecretRef.annotate({
      description: "One-use. Pass to a tool that accepts a secretRef. You never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "file holds the value." }),
    file: Schema.String.annotate({
      description:
        "Owner-only file with the value. Read it inside commands and never print it. Deleted after 24 hours.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: user chose not to. cancelled: ended with the run. timed_out: no answer in time. Ask again with a new `clientRequestId` if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

export const OrchestratorMcpEnvironmentLinkInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId).annotate({
    description:
      "The machine, when known, e.g. from a mentioned machine. Otherwise the user picks it in the card.",
  }),
  url: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Only an address the user gave: https, Tailscale, LAN or loopback. Never guess one.",
  }),
  hint: Schema.optional(TrimmedNonEmptyString).annotate({
    description: 'The user\'s words for the machine, e.g. "vps". Preselects it in the card.',
  }),
  reason: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "One sentence for the card.",
  }),
  requestedAccess: Schema.optional(AuthMcpClientAccess).annotate({
    description: "Suggested access. The user picks; default approval-required.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpEnvironmentLinkInput = typeof OrchestratorMcpEnvironmentLinkInput.Type;

export const OrchestratorMcpEnvironmentLinkResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending").annotate({
      description:
        "The card is waiting for the user. Their answer arrives as a message in this thread.",
    }),
    turnItemId: TurnItemId,
  }),
  Schema.Struct({
    status: Schema.Literal("linked"),
    environmentId: EnvironmentId.annotate({
      description: "Pass it as environmentId to act there; t3_environment_links lists it.",
    }),
    label: Schema.String,
    access: AuthMcpClientAccess.annotate({ description: "The access the user chose." }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the card closed unanswered, when the thread was stopped or archived.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    message: Schema.String.annotate({
      description: "Why the other environment refused the link, as the user saw it.",
    }),
  }),
]);
export type OrchestratorMcpEnvironmentLinkResult = typeof OrchestratorMcpEnvironmentLinkResult.Type;

export const OrchestratorMcpEnvironmentUnlinkInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "The linked environment to forget, from t3_environment_links.",
  }),
});
export type OrchestratorMcpEnvironmentUnlinkInput =
  typeof OrchestratorMcpEnvironmentUnlinkInput.Type;

export const OrchestratorMcpEnvironmentUnlinkResult = Schema.Struct({
  environmentId: EnvironmentId,
  removed: Schema.Boolean,
});
export type OrchestratorMcpEnvironmentUnlinkResult =
  typeof OrchestratorMcpEnvironmentUnlinkResult.Type;

export const OrchestratorMcpEnvironmentDeviceAccessInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "One of the user's machines, from `devices` in t3_environment_links.",
  }),
  access: TailnetDeviceAccess,
});
export type OrchestratorMcpEnvironmentDeviceAccessInput =
  typeof OrchestratorMcpEnvironmentDeviceAccessInput.Type;

export const OrchestratorMcpEnvironmentDeviceAccessResult = Schema.Struct({
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess,
});
export type OrchestratorMcpEnvironmentDeviceAccessResult =
  typeof OrchestratorMcpEnvironmentDeviceAccessResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
    ]),
    message: Schema.String,
  },
) {}
