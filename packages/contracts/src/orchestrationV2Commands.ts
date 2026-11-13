// Client and server orchestration commands.
import * as Schema from "effect/Schema";

import { OrchestrationMessageContext } from "./composerContext.ts";

import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  MessageId,
  EnvironmentId,
  NodeId,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { AuthMcpClientAccess } from "./auth.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ThreadTag } from "./threadTags.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  ThreadPullRequestWatch,
} from "./threadPullRequest.ts";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  UserInputAttachments,
  RuntimeMode,
} from "./providerPolicy.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

import {
  OrchestrationV2CreationFields,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2IdleCompaction,
  OrchestrationV2LimitRecoveryUpdate,
  OrchestrationV2LinkOrigin,
  OrchestrationV2ThreadForkSourcePoint,
} from "./orchestrationV2Base.ts";

import {
  OrchestrationV2ProviderThreadNativeMetadata,
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2Runs.ts";

import {
  OrchestrationV2Notification,
  OrchestrationV2ProviderFailure,
} from "./orchestrationV2Turns.ts";

import {
  OrchestrationV2LinkRequestStatus,
  OrchestrationV2SecretRequestDelivery,
  OrchestrationV2SecretRequestStatus,
} from "./orchestrationV2TurnItems.ts";

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
    /** Only the server sets this; a client's thread.create never carries one. */
    linkOrigin: Schema.optional(OrchestrationV2LinkOrigin),
    /** Only the server sets this, with `linkOrigin`, for a linked environment's delegated task. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
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
    /** Delete only a thread with no runs and no messages; otherwise succeed without a change. */
    onlyIfUnused: Schema.optional(Schema.Boolean),
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
    type: Schema.Literal("thread.tag.set"),
    commandId: CommandId,
    threadId: ThreadId,
    tag: ThreadTag,
    tagged: Schema.Boolean,
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
    sideChat: Schema.optional(Schema.Boolean),
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
  /** Moves a thread to a project rooted at the folder it already works in, so its cwd never changes. */
  Schema.Struct({
    type: Schema.Literal("thread.project.adopt-folder"),
    commandId: CommandId,
    threadId: ThreadId,
    projectId: ProjectId,
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
  /**
   * Records a delegated task that runs in a linked environment: the task, its
   * node and its turn item on the parent, as `delegated_task.request` does,
   * without a child thread here. `remoteChild` is the thread already launched
   * there. The ids derive from `commandId`, so a retry records nothing new.
   */
  Schema.Struct({
    type: Schema.Literal("delegated_task.remote.request"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    parentRunId: RunId,
    parentNodeId: NodeId,
    task: TrimmedNonEmptyString,
    title: Schema.optional(TrimmedNonEmptyString),
    driver: ProviderDriverKind,
    modelSelection: ModelSelection,
    remoteChild: OrchestrationV2RemoteTaskChild,
    completionWake: Schema.optional(Schema.Literals(["always", "settled_only"])),
  }),
  /**
   * Completes a delegated task that ran in a linked environment, with what its
   * thread there ended as. The parent wakes exactly as for a child here. A
   * task that already has a result keeps it; `stoppedThere` is still recorded,
   * and without it (a Stop or cancel here) the task owes a stop there instead.
   */
  Schema.Struct({
    type: Schema.Literal("delegated_task.remote.complete"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    taskId: NodeId,
    status: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
    result: Schema.String,
    /**
     * `ran-out`: the run there ended by itself; `stopped`: a stop from here reached it. Either
     * sets `remoteChild.stoppedThere` on a task this report completes. On a task already
     * cancelled or stopped here only `stopped` does, since a run that ended by itself leaves
     * the stop owed for whatever follows it.
     */
    stoppedThere: Schema.optional(Schema.Literals(["ran-out", "stopped"])),
    /** The stop generation this report acknowledges; absent for the original unnumbered stop. */
    stopCount: Schema.optional(NonNegativeInt),
  }),
  /**
   * Owes a stop to the thread there of a remote task that already has its result, as Stop on
   * a parent stops a finished child here. The task keeps its status, result and completion
   * delivery; its follower sends the stop and reports it with `delegated_task.remote.complete`.
   */
  Schema.Struct({
    type: Schema.Literal("delegated_task.remote.stop"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    taskId: NodeId,
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
  /** The provider did not confirm a Stop of this turn in time. */
  Schema.Struct({
    type: Schema.Literal("thread.interrupt.unresponsive"),
    commandId: CommandId,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.background-work.settle"),
    commandId: CommandId,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    /** Replaces the Stop's own reason on the result, as Force stop does. */
    reason: Schema.optional(Schema.String),
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
    delivery: Schema.optional(OrchestrationV2SecretRequestDelivery),
    secretStatus: OrchestrationV2SecretRequestStatus,
  }),
  /**
   * Records or updates a link an agent asked the user to make. Internal so no
   * client can mark a request linked without the link being made.
   */
  Schema.Struct({
    type: Schema.Literal("link_request.record"),
    commandId: CommandId,
    threadId: ThreadId,
    runId: RunId,
    nodeId: NodeId,
    turnItemId: TurnItemId,
    url: Schema.optional(TrimmedNonEmptyString),
    reason: Schema.String,
    environmentId: Schema.optional(EnvironmentId),
    label: Schema.optional(Schema.String),
    hint: Schema.optional(Schema.String),
    requestedAccess: Schema.optional(AuthMcpClientAccess),
    linkStatus: OrchestrationV2LinkRequestStatus,
    linkedEnvironmentId: Schema.optional(EnvironmentId),
    linkedLabel: Schema.optional(Schema.String),
    linkedAccess: Schema.optional(AuthMcpClientAccess),
    failure: Schema.optional(Schema.String),
    /** Tells the agent how the card ended, in the same commit that closes it. */
    wake: Schema.optional(
      Schema.Struct({
        messageId: MessageId,
        text: Schema.String,
        notification: OrchestrationV2Notification,
      }),
    ),
  }),
]);

export type OrchestrationV2InternalCommand = typeof OrchestrationV2InternalCommand.Type;

export type OrchestrationV2ServerCommand = OrchestrationV2Command | OrchestrationV2InternalCommand;
