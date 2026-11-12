import type {
  GuestShareId,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
  threadPullRequestKeysEqual,
  legacyThreadPullRequestKey,
} from "../sourceControl/threadPullRequests.ts";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type ChatAttachment,
  CommandId,
  type GuestMessageId,
  isCompactionCommandMessage,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  MessageId,
  type NodeId,
  type ModelSelection,
  OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2ServerCommand,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ContextTransferResolution,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedCompletionCohort,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2ModelSwitch,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  latestProviderTurnForAttempt,
  parseGoalCommand,
  orchestrationV2RunWorkStartedAt,
  orchestrationV2WorktreePending,
  ProviderInstanceId,
  ProviderInteractionMode,
  isRuntimeModeAbove,
  resolveProviderInstanceEnabled,
  resolveProjectProviderInstanceEnabled,
  type ProviderSessionId,
  RunId,
  RuntimeMode,
  ThreadLinkedPullRequest,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
  managedRuntimeModeCeilingMessage,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "./modelSwitch.ts";
import { recordThreadOpen } from "@t3tools/shared/paletteSearch";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  pendingBackgroundTurnItems,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectStore from "./ProjectStore.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CommandPolicyV2,
  goalCommandStopsActiveRun,
  isActiveRun,
  isNativeMaintenanceCommand,
  resolveMessageDispatchIntent,
} from "./CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import {
  ContextHandoffServiceV2,
  readForkHistoryItems,
  readInheritedHandoffItems,
  visibleConversationItems,
  visibleDeltaRunOrdinals,
} from "./ContextHandoffService.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import {
  cancelledBeforeStart,
  continuationFailedBeforePrompt,
  continuationStartRetryDelayMs,
  isRestartContinuationSource,
  runOutcome,
} from "./RestartBackgroundNote.ts";
import {
  isBufferedProviderNotification,
  isUndeliveredMailboxSteer,
} from "./NotificationMailbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import {
  decideGuestMessageSend,
  guestShareAfterCancelledSend,
  releasedGuestAttachmentIds,
  withoutGuestAttribution,
  decideGuestShareCommand,
  type GuestShareCommand,
} from "./GuestShareDecider.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { withCommandMetrics } from "../observability/Metrics.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { makeCheckpointHandlers } from "./handlers/checkpointHandlers.ts";
import { makeLifecycleHandlers } from "./handlers/lifecycleHandlers.ts";
import { makeMessageHandlers } from "./handlers/messageHandlers.ts";
import { makeQueueHandlers } from "./handlers/queueHandlers.ts";
import {
  RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
  WORKSPACE_PREPARATION_INPUT,
} from "./orchestrationMessages.ts";
import { makeEventEmitter, mapDispatchError } from "./orchestrationEmitters.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  narrowToCeiling,
  type RuntimeModeCeiling,
  runtimeModeCeilingRefusal,
  threadsStartingWork,
} from "./DispatchModeLimit.ts";
import {
  applyToProjection,
  emptyProjection,
  threadShellFromProjection,
  ProjectionStoreV2,
  type ProjectionRecordField,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionCheckpointContext,
  type OlderSettledThreadsListing,
  type ActiveShellIndexEntry,
  type OlderSettledThreadsQuery,
  type ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { isRuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
  makeSubagentChildThread,
  subagentResultForRun,
  delegatedTaskProgress,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  forkableSourceRunStatusError,
  isForkableSourceRunStatus,
  ThreadForkServiceV2,
} from "./ThreadForkService.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";

const isMessageQuestionAnswer = Schema.is(
  Schema.Union([TrimmedNonEmptyString, Schema.NonEmptyArray(TrimmedNonEmptyString)]),
);

import {
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  isOrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
} from "./orchestrationErrors.ts";
export {
  wakeWorkStartedAt,
  commandThreadId,
  legacyPullRequestLink,
  delegatedCompletionWakeDetail,
  delegatedTaskTerminalStatus,
  usageLimitHoldsQueue,
  runForSourcePoint,
  contextSourcePointForRun,
  withPullRequestWatch,
  latestStableRun,
  providerThreadForRun,
  providerTurnForRun,
  DELEGATED_RESULT_INLINE_BYTES,
} from "./orchestrationCommandQueries.ts";

import {
  wakeWorkStartedAt,
  commandThreadId,
  legacyPullRequestLink,
  delegatedCompletionWakeDetail,
  delegatedTaskTerminalStatus,
  usageLimitHoldsQueue,
  runForSourcePoint,
  contextSourcePointForRun,
  withPullRequestWatch,
  latestStableRun,
  providerThreadForRun,
  providerTurnForRun,
  DELEGATED_RESULT_INLINE_BYTES,
} from "./orchestrationCommandQueries.ts";

export {
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  isOrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
} from "./orchestrationErrors.ts";
import { makeOrchestratorCore, OrchestratorV2 } from "./orchestratorCore.ts";
export { OrchestratorV2 };

const isOrchestratorDispatchError = Schema.is(OrchestratorDispatchError);

/** The ceiling refusal under however many dispatch errors wrapped it on the way out. */
function runtimePolicyCeilingCause(error: unknown) {
  let current = error;
  while (isOrchestratorDispatchError(current)) current = current.cause;
  return isRuntimePolicyAboveCeilingError(current) ? current : undefined;
}

export class OrchestratorRuntimeModeAboveCeilingError extends Schema.TaggedError<OrchestratorRuntimeModeAboveCeilingError>()(
  "OrchestratorRuntimeModeAboveCeilingError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    refused: Schema.Literals(["mode", "turn"]),
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    const limit = managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode);
    return this.refused === "turn" ? `${limit} Switch this thread's mode to continue.` : limit;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

class OrchestratorCommandIdConflictError extends Schema.TaggedError<OrchestratorCommandIdConflictError>()(
  "OrchestratorCommandIdConflictError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    receiptThreadId: ThreadId,
    commandThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was already handled for thread ${this.receiptThreadId} and cannot be replayed for ${this.commandThreadId}.`;
  }
}

export const OrchestratorV2Error = Schema.Union([
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandIdConflictError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorRuntimeModeAboveCeilingError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;

export interface OrchestratorV2DispatchResult {
  readonly sequence: number;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  /** The command id was already accepted; analytics skip it. */
  readonly replayed?: true;
}

export interface OrchestratorV2Shape {
  readonly resumeQueuedRuns: Effect.Effect<number, OrchestratorV2Error>;
  readonly recoverDelegatedTasks: Effect.Effect<void>;
  readonly recoverDelegatedTask: (threadId: ThreadId, sourceRunId: RunId) => Effect.Effect<void>;
  readonly delegatedTaskResultPending: (
    childThreadId: ThreadId,
    taskId?: NodeId,
  ) => Effect.Effect<boolean, OrchestratorProjectionError>;
  readonly restartContinuationPending: (run: OrchestrationV2Run) => Effect.Effect<boolean>;
  /** Declined continuations emit no thread event; this still wakes waiters. */
  readonly awaitRestartContinuation: (run: OrchestrationV2Run) => Effect.Effect<void>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly autoArmLimitRecovery: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly limitRecovery: OrchestrationV2LimitRecoveryUpdate;
  }) => Effect.Effect<void, OrchestratorV2Error>;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
    workMode?: "deferred" | "work",
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, OrchestratorV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, OrchestratorProjectionError>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, OrchestratorV2Error>;
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, OrchestratorV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorV2Error>;
  readonly listAppOwnedChildThreadIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, OrchestratorV2Error>;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: Parameters<ProjectionStoreV2["Service"]["getThreadSnapshotWindow"]>[1],
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getPullRequestSnapshot: (
    options: Parameters<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>>,
    OrchestratorV2Error
  >;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>;
  readonly listActiveSubagentThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    OrchestratorV2Error
  >;
  readonly countThreads: () => Effect.Effect<number, OrchestratorV2Error>;
  readonly listActiveShellIndex: () => Effect.Effect<
    ReadonlyArray<ActiveShellIndexEntry>,
    OrchestratorV2Error
  >;
  readonly listOlderSettledThreads: (
    query: OlderSettledThreadsQuery,
  ) => Effect.Effect<OlderSettledThreadsListing, OrchestratorV2Error>;
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>,
    OrchestratorV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, OrchestratorV2Error>;
  readonly findGuestShareThreadId: (
    shareId: GuestShareId,
  ) => Effect.Effect<ThreadId | null, OrchestratorV2Error>;
  readonly getThreadEventSequence: (
    threadId: ThreadId,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly streamStoredEvents: Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamStoredEventsFrom: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, OrchestratorV2Error>;
}


/** Run ordinals can skip values: a queued run moves past newer runs when it starts. */
export function nextRunOrdinal(projection: Pick<OrchestrationV2ThreadProjection, "runs">): number {
  return projection.runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1;
}

/** Stamp at wake start; queued prompts lack start times and delegated results jump the queue. */
export const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

/** Unfinished runs (including queued) or open requests block moving a thread to another project. */
export function threadHasUnfinishedWork(records: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
}): boolean {
  return (
    records.runs.some(
      (run) =>
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        run.status !== "interrupted" &&
        run.status !== "rolled_back",
    ) || records.runtimeRequests.some((request) => request.status === "pending")
  );
}

const decodeUserInputAnswers = Schema.decodeUnknownEffect(
  Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.String),
      Schema.Struct({ answers: Schema.Array(Schema.String) }),
    ]),
  ),
);

function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}

function delegatedTasksStopEffect(command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly reason?: string | undefined;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${command.commandId}:delegated-tasks.stop`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "delegated-tasks.stop",
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  };
}


export function withoutPreparationResult(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
}

/** Stop ended this task, so its result is not delivered to the parent agent. */
function cancelledAppOwnedTask(
  task: OrchestrationV2Subagent,
  now: DateTime.Utc,
): OrchestrationV2Subagent {
  return {
    ...task,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
    completionDelivery: { state: "disposed", observedByRunId: null },
  };
}

// Provider wakes can start follow-up work; monitor updates only report progress.
// Dispatch takes the parent's lock for follow-ups because intake writes the parent.
function mayStartSubagentFollowup(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  if (command.scheduledTaskId !== undefined || command.restartContinuationOfRunId !== undefined)
    return false;
  if (command.notification !== undefined) return command.notification.source.kind !== "monitor";
  return command.createdBy === "user" || command.creationSource === "mcp";
}

/** Waiting runs only drain post-terminal output; their agent turn is over and still needs a wake. */
export function isLiveRun(run: OrchestrationV2Run): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

export function hasLiveRun(projection: Pick<OrchestrationV2ThreadProjection, "runs">): boolean {
  return projection.runs.some(isLiveRun);
}

export function isTerminalDelegatedTaskStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function worktreeSetupPending(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): boolean {
  return (
    projection.thread.worktreePath === null &&
    projection.runs.some(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    )
  );
}

function nextQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): OrchestrationV2Run | undefined {
  return queuedRunsInDeliveryOrder(projection).find((run) => run.queueHeld !== true);
}

function followsCurrentConversation(
  message: OrchestrationV2ConversationMessage | undefined,
): boolean {
  return (
    message?.delegatedCompletion !== undefined ||
    (message?.notification?.source.kind === "monitor" && !isBufferedProviderNotification(message))
  );
}

function queuedRunModelSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
): ModelSelection {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return followsCurrentConversation(message)
    ? projection.thread.modelSelection
    : run.modelSelection;
}

export function pendingForkTransferForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): OrchestrationV2ContextTransfer | undefined {
  return projection.contextTransfers.find(
    (transfer) =>
      transfer.type === "fork" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

export function pendingMergeBackTransfersForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): ReadonlyArray<OrchestrationV2ContextTransfer> {
  return projection.contextTransfers.filter(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

export function latestContextTransfer(
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ContextTransfer | undefined {
  return transfers.reduce<OrchestrationV2ContextTransfer | undefined>((latest, transfer) => {
    if (latest === undefined) {
      return transfer;
    }
    return DateTime.toEpochMillis(transfer.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
      ? transfer
      : latest;
  }, undefined);
}

export function shouldPrepareLegacyImportHandoff(input: {
  readonly hasCompletedRun: boolean;
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly legacyImportItemCount: number;
}): boolean {
  return (
    input.historyOrigin === "v1_import" && !input.hasCompletedRun && input.legacyImportItemCount > 0
  );
}

export function appendContextHandoffId(
  handoffIds: OrchestrationV2ProviderThread["handoffIds"],
  handoffId: OrchestrationV2ContextHandoff["id"] | null,
): OrchestrationV2ProviderThread["handoffIds"] {
  return handoffId === null ? handoffIds : Array.from(new Set([...handoffIds, handoffId]));
}

export function rootProviderThreadsForProvider(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "thread">,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null,
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted";
}

export function lastDeliveredRunForProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      isHandoffSourceRun(run) &&
      run.providerThreadId === providerThreadId &&
      (run.status === "completed" ||
        projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)),
  );
}


const makeOrchestrator = Effect.fn("orchestrationV2.Orchestrator.layer")(function* () {
  return yield* makeOrchestratorCore();
});


export const layer: Layer.Layer<
  OrchestratorV2,
  never,
  | CheckpointServiceV2
  | FileSystem.FileSystem
  | Path.Path
  | CommandPolicyV2
  | CommandReceiptStoreV2
  | ContextHandoffServiceV2
  | EffectOutbox.EffectOutboxV2
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectStore.ProjectStoreV2
  | ProviderAdapterRegistryV2
  | ProviderSessionManagerV2
  | ProviderSwitchServiceV2
  | ProjectionStoreV2
  | RuntimePolicyV2
  | ServerSettings.ServerSettingsService
  | ThreadForkServiceV2
> = Layer.effect(OrchestratorV2, makeOrchestrator()).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
