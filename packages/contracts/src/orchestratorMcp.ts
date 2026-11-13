import * as Schema from "effect/Schema";
import { AuthMcpClientAccess } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ScheduledTaskRunStatus, ScheduledTaskSchedule } from "./scheduledTask.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { OrchestratorMcpClientRequestId, OrchestratorMcpEnvironmentTarget, OrchestratorMcpProjectTarget, OrchestratorMcpPrompt, OrchestratorMcpRunningTaskNext, OrchestratorMcpSchedule, OrchestratorMcpThreadPullRequest, OrchestratorMcpThreadStatus, OrchestratorMcpTitle } from "./orchestratorMcpPart2.ts";
export {
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpInteractionMode,
  OrchestratorMcpRuntimeMode,
  OrchestratorMcpTarget,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskRole,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadPullRequest,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadStatus,
} from "./orchestratorMcpPart2.ts";

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
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
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

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  messageId: MessageId,
  runId: RunId,
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Finite),
  untilDelegatedWorkSettled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also wait for its delegated and background tasks and their completions to settle. `resultRun` then names the run with its final answer.",
    }),
  ),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
  /** With untilDelegatedWorkSettled, once settled: the run whose reply is the thread's result. */
  resultRun: Schema.optional(Schema.Struct({ runId: RunId, status: OrchestrationV2RunStatus })),
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

const OrchestratorMcpProviderCapability = Schema.Struct({
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
type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

const OrchestratorMcpEnvironmentLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Whether it answered just now. An expired link must be linked again there. */
  status: Schema.Literals(["reachable", "unreachable", "expired"]),
  /** The most the linked environment lets this one's agents do there. */
  access: AuthMcpClientAccess,
  expiresAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
type OrchestratorMcpEnvironmentLink = typeof OrchestratorMcpEnvironmentLink.Type;

export const OrchestratorMcpEnvironmentLinksResult = Schema.Struct({
  environmentId: EnvironmentId,
  links: Schema.Array(OrchestratorMcpEnvironmentLink),
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
      description: "Default true: runs post in this thread. False: new thread per run.",
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
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: no T3 Connect tunnel. The user must enable T3 Connect remote access.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])),
  blockedByPolicy: Schema.optional(Schema.String).annotate({
    description: "Present when an administrator's policy stops this task from running.",
  }),
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
