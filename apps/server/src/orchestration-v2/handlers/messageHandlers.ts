/**
 * Extracted orchestrator handlers: dispatchMessage, dispatchThreadMutation.
 *
 * Moved out of the makeOrchestrator closure; dependencies are passed in.
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { OrchestrationV2InternalCommand } from "@t3tools/contracts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { recordThreadOpen } from "@t3tools/shared/paletteSearch";
import type { CommandId } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";
import type { CheckpointServiceV2Shape } from "../CheckpointService.ts";
import type { CommandPolicyV2Shape } from "../CommandPolicy.ts";
import type { ContextHandoffServiceV2Shape } from "../ContextHandoffService.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";
import type { ProviderAdapterRegistryV2Shape } from "../ProviderAdapterRegistry.ts";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";
import type { ProviderSwitchServiceV2Shape } from "../ProviderSwitchService.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type { ProjectionRecordField } from "../ProjectionStore.ts";
import type { ProjectionRecordFilter } from "../ProjectionStore.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorCommandRejectedError } from "../orchestrationErrors.ts";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { OrchestratorDomainEventStreamError } from "../orchestrationErrors.ts";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { OrchestratorSubagentThreadReadOnlyError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAlreadyExistsError } from "../orchestrationErrors.ts";
import { RunId } from "@t3tools/contracts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestrationMessages.ts";
import { applyToProjection } from "../ProjectionStore.ts";
import { cancelledBeforeStart } from "../RestartBackgroundNote.ts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import { contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { continuationFailedBeforePrompt } from "../RestartBackgroundNote.ts";
import { delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { goalCommandStopsActiveRun } from "../CommandPolicy.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import { isRestartContinuationSource } from "../RestartBackgroundNote.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { latestProviderTurnForAttempt } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { legacyPullRequestLink } from "../orchestrationCommandQueries.ts";
import { legacyThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "../modelSwitch.ts";
import { normalizeThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import { parseGoalCommand } from "@t3tools/contracts";
import { providerThreadForRun } from "../orchestrationCommandQueries.ts";
import { readForkHistoryItems } from "../ContextHandoffService.ts";
import { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestKeysEqual } from "../../sourceControl/threadPullRequests.ts";
import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import { threadShellFromProjection } from "../ProjectionStore.ts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { visibleConversationItems } from "../ContextHandoffService.ts";
import { visibleDeltaRunOrdinals } from "../ContextHandoffService.ts";
import { visibleThreadPullRequests } from "../../sourceControl/threadPullRequests.ts";
import { wakeWorkStartedAt } from "../orchestrationCommandQueries.ts";
import { withPullRequestWatch } from "../orchestrationCommandQueries.ts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransfer } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransferResolution } from "@t3tools/contracts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type { OrchestrationV2ExecutionNode } from "@t3tools/contracts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isLiveRun } from "../Orchestrator.ts";
import { shouldPrepareLegacyImportHandoff } from "../Orchestrator.ts";
import type { OrchestrationV2RunAttempt } from "@t3tools/contracts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { appendContextHandoffId } from "../Orchestrator.ts";
import { isHandoffSourceRun } from "../Orchestrator.ts";
import { threadPullRequestLinksEqual } from "../Orchestrator.ts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

type AnyOrchestratorError =
  | OrchestratorDispatchError
  | OrchestratorThreadAlreadyExistsError
  | OrchestratorCommandRejectedError
  | OrchestratorProjectionError
  | OrchestratorDomainEventStreamError
  | OrchestratorProviderAdapterError
  | OrchestratorSubagentThreadReadOnlyError
  | OrchestratorThreadAboveModeLimitError;

import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

export interface MakeMessageHandlersDeps {
  readonly eventSink: EventSinkV2Shape;
  readonly idAllocator: EventIdAllocator;
  readonly ensureGoalCommandSupported: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly disposeAllDelegatedCompletionCohorts: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, AnyOrchestratorError, never>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError, never>;
  readonly goalDriverFor: (
    command: OrchestrationV2ServerCommand,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderDriverKind | undefined, OrchestratorDispatchError, never>;
  readonly notificationTasks: (
    threadId: ThreadId,
    message: Pick<OrchestrationV2ConversationMessage, "delegatedCompletion">,
    loaded: ReadonlyArray<OrchestrationV2Subagent>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly pendingThreadTitleGenerationEffect: (...args: any[]) => any;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (
    event: Omit<OrchestrationV2DomainEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
  readonly dispatchQueuedRunCancel: (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly checkpointService: CheckpointServiceV2Shape;
  readonly closePendingLinkRequests: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly commandPolicy: CommandPolicyV2Shape;
  readonly contextHandoffService: ContextHandoffServiceV2Shape;
  readonly dispatchRuntimeRequestRespond: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly dispatchSteerIntoRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly projects: Parameters<typeof isCheckpointRestoreIsolated>[2]["projects"];
  readonly providerAdapters: ProviderAdapterRegistryV2Shape;
  readonly providerSessionIdFor: (...args: any[]) => Effect.Effect<ProviderSessionId, AnyOrchestratorError | ProviderAdapterV2Error | IdAllocatorV2Error, never>;
  readonly providerSessions: ProviderSessionManagerV2Shape;
  readonly providerSwitchService: ProviderSwitchServiceV2Shape;
  readonly readHandoffItems: (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId | null>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly readInheritedItems: (thread: OrchestrationV2AppThread) => Effect.Effect<any, OrchestratorProjectionError, never>;
  readonly releaseGuestAttachments: (
    command: { readonly commandId: CommandId; readonly threadId: ThreadId },
    before: OrchestrationV2AppThread["guestShare"],
    after: OrchestrationV2AppThread["guestShare"],
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, AnyOrchestratorError, never>;
  readonly runtimePolicy: RuntimePolicyV2Shape;
  readonly sessionHasBackgroundWork: (...args: any[]) => Effect.Effect<boolean, AnyOrchestratorError, never>;
  readonly stopReachedRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly stopRunForQueuedCommand: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
}

export const makeMessageHandlers = (deps: MakeMessageHandlersDeps) => {
const dispatchThreadMutation = Effect.fn("orchestrationV2.dispatch.threadMutation")(function* (
  command: Extract<
    OrchestrationV2ServerCommand,
    {
      readonly type:
        | "thread.archive"
        | "thread.unarchive"
        | "thread.settle"
        | "thread.unsettle"
        | "thread.snooze"
        | "thread.unsnooze"
        | "thread.auto-settle.set"
        | "thread.pin"
        | "thread.unpin"
        | "thread.pin.reorder"
        | "thread.tag.set"
        | "thread.active.reorder"
        | "thread.mark-unread"
        | "thread.metadata.update"
        | "thread.pull-request.link"
        | "thread.pull-request.unlink"
        | "thread.pull-request-link.sync"
        | "thread.pull-request.watch"
        | "thread.pull-request-watch.sync"
        | "thread.pull-request.sync"
        | "thread.title.regeneration.complete"
        | "thread.runtime-mode.set"
        | "thread.interaction-mode.set"
        | "thread.model-selection.set"
        | "provider.switch";
    }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const thread = yield* deps.projectionStore.getThread(command.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorProjectionError({
          threadId: command.threadId,
          cause,
        }),
    ),
  );
  if (thread.deletedAt !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is deleted.`,
    });
  }
  if (
    command.type === "thread.pull-request.watch" &&
    command.watching &&
    isProviderNativeSubagentThread(thread)
  ) {
    return yield* new OrchestratorSubagentThreadReadOnlyError({
      commandId: command.commandId,
      threadId: command.threadId,
    });
  }
  if (
    command.type === "thread.pull-request.watch" &&
    command.watching &&
    (thread.settledOverride === "settled" ||
      thread.settledAt !== null ||
      thread.archivedAt !== null)
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is settled or archived and cannot watch pull requests.`,
    });
  }
  // Child tasks report to their parent, which owns PR monitoring; child watches would cause unrelated wakes.
  if (
    command.type === "thread.pull-request.watch" &&
    command.watching &&
    thread.lineage.relationshipToParent === "subagent"
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is a subagent; its parent thread watches pull requests.`,
    });
  }
  // Agent watches use the latest executed run to catch calls racing Stop; users can still watch.
  if (
    command.type === "thread.pull-request.watch" &&
    command.watching &&
    command.link?.source === "agent"
  ) {
    const { runs } = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(mapDispatchError(command));
    const latest = latestExecutedRun(runs);
    if (latest !== null && (yield* deps.stopReachedRun(command, command.threadId, latest.id))) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} was stopped.`,
      });
    }
  }
  if (
    command.type === "thread.metadata.update" &&
    command.expectedWorktreePath !== undefined &&
    command.expectedWorktreePath !== thread.worktreePath
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} worktree changed before the metadata update could be applied.`,
    });
  }
  if (
    command.type === "thread.metadata.update" &&
    command.expectedBranch !== undefined &&
    command.expectedBranch !== thread.branch
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} branch changed before the metadata update could be applied.`,
    });
  }
  if (command.type === "thread.metadata.update" && command.expectedEmpty === true) {
    const records = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(mapDispatchError(command));
    const messageCount = yield* deps.projectionStore
      .getMessageCount(command.threadId)
      .pipe(mapDispatchError(command));
    if (messageCount > 0 || records.runs.length > 0)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is no longer empty.`,
      });
  }
  if (command.type === "thread.archive" && thread.archivedAt !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is already archived.`,
    });
  }
  if (command.type === "thread.unarchive" && thread.archivedAt === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is not archived.`,
    });
  }
  if (
    (command.type === "thread.settle" ||
      command.type === "thread.unsettle" ||
      command.type === "thread.snooze" ||
      command.type === "thread.unsnooze" ||
      command.type === "thread.auto-settle.set" ||
      command.type === "thread.pin" ||
      command.type === "thread.unpin" ||
      command.type === "thread.pin.reorder" ||
      command.type === "thread.active.reorder" ||
      command.type === "thread.pull-request.sync") &&
    thread.archivedAt !== null
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is archived.`,
    });
  }
  // Reject reorder after unpin so a raced request cannot restore a cleared pin.
  if (command.type === "thread.pin.reorder" && thread.pinnedAt == null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is not pinned and cannot be reordered.`,
    });
  }
  if (
    command.type === "thread.active.reorder" &&
    (thread.pinnedAt != null || thread.settledOverride === "settled")
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} is not active and cannot be reordered.`,
    });
  }
  if (command.type === "thread.pull-request.sync") {
    const project = yield* deps.projects.get(command.projectId).pipe(mapDispatchError(command));
    const currentSequence = yield* deps.eventSink.latestSequence({ threadId: command.threadId }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProjectionError({
            threadId: command.threadId,
            cause,
          }),
      ),
    );
    if (
      Option.isNone(project) ||
      project.value.deletedAt !== null ||
      project.value.workspaceRoot !== command.expected.workspaceRoot ||
      currentSequence > command.snapshotSequence ||
      thread.projectId !== command.projectId ||
      thread.branch !== command.expected.branch ||
      thread.worktreePath !== command.expected.worktreePath ||
      !threadPullRequestLinksEqual(
        thread.linkedPullRequest ?? null,
        command.expected.linkedPullRequest,
      ) ||
      !threadPullRequestLinksEqual(
        thread.branchPullRequest ?? null,
        command.expected.branchPullRequest,
      )
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} changed before pull request discovery.`,
      });
    }
  }
  if (command.type === "thread.settle") {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["runs", "runtimeRequests", "messages"],
      { turnItemTypes: [], messageRoles: ["user"] },
    );
    const automaticMessageIds = new Set(
      projection.messages
        .filter(
          (message) =>
            message.notification !== undefined || message.delegatedCompletion !== undefined,
        )
        .map((message) => message.id),
    );
    const automaticQueuedRuns = projection.runs.filter(
      (run) => run.status === "queued" && automaticMessageIds.has(run.userMessageId),
    );
    const runningRunExists = projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    );
    const queuedMessageExists = projection.runs.some(
      (run) => run.status === "queued" && !automaticQueuedRuns.includes(run),
    );
    const pendingRequests = projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    );
    const blockingRequestExists = pendingRequests.some(
      (request) => request.kind !== "user_input" || request.responseCapability.type !== "message",
    );
    const blocker = blockingRequestExists
      ? "is waiting on an approval or question. Answer it before settling."
      : runningRunExists
        ? "is still running. Stop it before settling."
        : queuedMessageExists
          ? "has a queued message. Send it or remove it from the queue before settling."
          : null;
    if (blocker !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} ${blocker}`,
      });
    }

    for (const request of pendingRequests) {
      yield* deps.dispatchRuntimeRequestRespond(
        {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: request.id,
          decision: "cancel",
        },
        events,
        effects,
      );
    }
    for (const run of automaticQueuedRuns) {
      yield* deps.dispatchQueuedRunCancel(
        {
          type: "queued-run.cancel",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: run.id,
        },
        events,
      );
    }
  }

  const needsProviderState =
    command.type === "thread.runtime-mode.set" ||
    command.type === "thread.model-selection.set" ||
    command.type === "provider.switch" ||
    command.type === "thread.archive" ||
    command.type === "thread.settle" ||
    (command.type === "thread.metadata.update" &&
      command.worktreePath !== undefined &&
      command.worktreePath !== thread.worktreePath);
  const providerContext = needsProviderState
    ? yield* deps.projectionStore
        .getThreadProviderContext(
          command.threadId,
          command.type === "thread.model-selection.set" || command.type === "provider.switch"
            ? command.modelSelection.instanceId
            : undefined,
        )
        .pipe(mapDispatchError(command))
    : null;
  const providerSwitchPlan =
    command.type === "thread.model-selection.set" || command.type === "provider.switch"
      ? yield* Effect.gen(function* () {
          yield* deps.providerAdapters.get(command.modelSelection.instanceId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProviderAdapterError({
                  commandId: command.commandId,
                  providerInstanceId: command.modelSelection.instanceId,
                  cause,
                }),
            ),
          );
          return yield* deps.providerSwitchService
            .plan({
              projection: providerContext!,
              targetModelSelection: command.modelSelection,
            })
            .pipe(mapDispatchError(command));
        })
      : null;

  const now = yield* DateTime.now;
  if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["runs", "runtimeRequests", "turnItems"],
      { turnItemTypes: ["error"] },
    );
    const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
    const failure = latestRootProviderFailure(run, projection.turnItems);
    const resetMs = Date.parse(command.limitRecovery.resetAt);
    if (command.limitRecovery.snooze === true && resetMs <= DateTime.toEpochMillis(now)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The reset time has passed. Retry the thread manually.",
      });
    }
    if (
      !Number.isFinite(resetMs) ||
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      run?.id !== command.limitRecovery.runId ||
      failure?.class !== "usage_limit" ||
      failure.resetAt !== command.limitRecovery.resetAt ||
      resetMs <= DateTime.toEpochMillis(run.completedAt ?? run.requestedAt) ||
      projection.runtimeRequests.some((request) => request.status === "pending")
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The provider limit changed before recovery could be configured.",
      });
    }
  }
  let snoozedUntil: DateTime.Utc | null = null;
  if (command.type === "thread.snooze") {
    const projection = yield* deps.loadProjectionForCommand(command, ["runs", "runtimeRequests"], {
      turnItemTypes: [],
    });
    const parsedSnoozedUntil = DateTime.make(command.snoozedUntil);
    if (
      Option.isNone(parsedSnoozedUntil) ||
      DateTime.toEpochMillis(parsedSnoozedUntil.value) <= DateTime.toEpochMillis(now)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future.`,
      });
    }
    if (projection.runtimeRequests.some((request) => request.status === "pending")) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed.`,
      });
    }
    const queuedRuns = projection.runs.filter((run) => run.status === "queued");
    const queuedMessages =
      queuedRuns.length === 0
        ? []
        : (yield* deps.loadProjectionForCommand(command, ["messages"], {
            messageIds: queuedRuns.map((run) => run.userMessageId),
          })).messages;
    const automaticMessageIds = new Set(
      queuedMessages
        .filter(
          (message) =>
            message.notification !== undefined || message.delegatedCompletion !== undefined,
        )
        .map((message) => message.id),
    );
    if (queuedRuns.some((run) => !automaticMessageIds.has(run.userMessageId))) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has a queued run and cannot be snoozed.`,
      });
    }
    snoozedUntil = parsedSnoozedUntil.value;
  }
  let markUnreadVisitedAt: DateTime.Utc | null = null;
  if (command.type === "thread.mark-unread") {
    const shell = yield* deps.projectionStore
      .getThreadShell(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const latestRunCompletedAt = shell?.latestRunCompletedAt ?? null;
    if (latestRunCompletedAt === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has no completed run to mark unread.`,
      });
    }
    markUnreadVisitedAt = DateTime.subtract(latestRunCompletedAt, { milliseconds: 1 });
  }
  const updatedThread: OrchestrationV2AppThread = (() => {
    switch (command.type) {
      case "thread.archive":
        return {
          ...thread,
          archivedAt: now,
          titleRegeneration: null,
          guestShare: null,
          pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
          updatedAt: now,
        };
      case "thread.unarchive":
        return { ...thread, archivedAt: null, updatedAt: now };
      case "thread.settle": {
        const wasPinned = thread.pinnedAt != null;
        const alreadySettled =
          thread.settledOverride === "settled" && thread.settledAt !== null && !wasPinned;
        return {
          ...thread,
          settledOverride: "settled",
          settledAt: alreadySettled ? thread.settledAt : (command.settledAt ?? now),
          pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
          unsettledAt: null,
          pinnedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt:
            alreadySettled && thread.snoozedUntil == null && thread.snoozedAt == null
              ? thread.updatedAt
              : now,
        };
      }
      case "thread.unsettle": {
        const alreadyPinnedActive = thread.settledOverride === "active";
        return {
          ...thread,
          settledOverride: "active",
          settledAt: null,
          unsettledAt: alreadyPinnedActive ? (thread.unsettledAt ?? null) : now,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : now,
        };
      }
      case "thread.snooze": {
        // Re-snoozing acknowledges the latest wake even at the same time; commandId deduplicates retries.
        return {
          ...thread,
          snoozedUntil,
          limitRecovery: thread.limitRecovery ? { ...thread.limitRecovery, snooze: false } : null,
          snoozedAt: now,
          updatedAt: now,
        };
      }
      case "thread.unsnooze": {
        const alreadyAwake = thread.snoozedUntil == null;
        return {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          lastSnoozeWakeAt: alreadyAwake ? thread.lastSnoozeWakeAt : now,
          updatedAt: alreadyAwake ? thread.updatedAt : now,
        };
      }
      case "thread.auto-settle.set": {
        const unchanged = command.enabled === (thread.autoSettleDisabledAt == null);
        return {
          ...thread,
          autoSettleDisabledAt: command.enabled ? null : (thread.autoSettleDisabledAt ?? now),
          updatedAt: unchanged ? thread.updatedAt : now,
        };
      }
      case "thread.pin": {
        const alreadyPinned = thread.pinnedAt != null;
        const promotes = thread.settledOverride === "settled" || thread.snoozedUntil != null;
        return {
          ...thread,
          pinnedAt: alreadyPinned ? thread.pinnedAt : now,
          ...(alreadyPinned || command.orderKey === undefined
            ? {}
            : { pinOrderKey: command.orderKey }),
          settledOverride:
            thread.settledOverride === "settled" ? "active" : thread.settledOverride,
          settledAt: thread.settledOverride === "settled" ? null : thread.settledAt,
          ...(thread.settledOverride === "settled" ? { unsettledAt: now } : {}),
          snoozedUntil: null,
          snoozedAt: null,
          lastSnoozeWakeAt: thread.snoozedUntil == null ? thread.lastSnoozeWakeAt : now,
          updatedAt: alreadyPinned && !promotes ? thread.updatedAt : now,
        };
      }
      case "thread.unpin": {
        const alreadyUnpinned = thread.pinnedAt == null;
        return {
          ...thread,
          pinnedAt: null,
          pinOrderKey: null,
          updatedAt: alreadyUnpinned ? thread.updatedAt : now,
        };
      }
      case "thread.pin.reorder": {
        const keyUnchanged = thread.pinOrderKey === command.orderKey;
        return {
          ...thread,
          pinOrderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : now,
        };
      }
      case "thread.active.reorder": {
        return {
          ...thread,
          activeOrderKey: command.orderKey,
          updatedAt: thread.updatedAt,
        };
      }
      case "thread.tag.set": {
        const current = thread.tags ?? [];
        return {
          ...thread,
          tags: command.tagged
            ? current.includes(command.tag)
              ? current
              : [...current, command.tag]
            : current.filter((tag) => tag !== command.tag),
        };
      }
      case "thread.mark-unread": {
        // Retire the wake before rewinding the visit, preserving its settlement timer.
        const snoozeExpired =
          thread.snoozedUntil != null &&
          DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now);
        return {
          ...thread,
          lastVisitedAt: markUnreadVisitedAt,
          ...(snoozeExpired
            ? { snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: thread.snoozedUntil }
            : {}),
        };
      }
      case "thread.metadata.update": {
        const previousRecovery =
          thread.limitRecovery?.runId === command.limitRecovery?.runId &&
          thread.limitRecovery?.resetAt === command.limitRecovery?.resetAt
            ? thread.limitRecovery
            : null;
        const limitRecovery =
          command.limitRecovery === undefined
            ? thread.limitRecovery
            : command.limitRecovery === null
              ? null
              : {
                  ...command.limitRecovery,
                  autoResume:
                    command.limitRecovery.autoResume ?? previousRecovery?.autoResume ?? false,
                  snooze: command.limitRecovery.snooze ?? previousRecovery?.snooze ?? false,
                  requestId: command.commandId,
                };
        return {
          ...thread,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.limitRecovery === undefined ? {} : { limitRecovery }),
          ...(command.limitRecovery !== undefined &&
          limitRecovery?.snooze === true &&
          Date.parse(limitRecovery.resetAt) > DateTime.toEpochMillis(now)
            ? {
                snoozedUntil: DateTime.makeUnsafe(limitRecovery.resetAt),
                // Recovery updates acknowledge the same stopped run; their timestamps must not trigger fresh failure wakes.
                snoozedAt: now,
              }
            : command.limitRecovery !== undefined &&
                thread.limitRecovery?.snooze &&
                thread.snoozedUntil != null &&
                DateTime.toEpochMillis(thread.snoozedUntil) ===
                  Date.parse(thread.limitRecovery.resetAt)
              ? { snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: now }
              : {}),
          ...(command.branch === undefined ? {} : { branch: command.branch }),
          ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
          ...(command.linkedPullRequest === undefined
            ? {}
            : {
                linkedPullRequest: command.linkedPullRequest,
                pullRequests: [
                  ...threadPullRequestsOf(thread).filter(
                    (link) =>
                      !(
                        thread.linkedPullRequest &&
                        threadPullRequestKeysEqual(
                          link,
                          legacyThreadPullRequestKey(thread.linkedPullRequest),
                        )
                      ) &&
                      !(
                        command.linkedPullRequest &&
                        threadPullRequestKeysEqual(
                          link,
                          legacyThreadPullRequestKey(command.linkedPullRequest),
                        )
                      ),
                  ),
                  ...(command.linkedPullRequest
                    ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                    : []),
                ],
              }),
          ...(command.regenerateTitle === true
            ? { titleRegeneration: { requestId: command.commandId, startedAt: now } }
            : command.regenerateTitle === false || command.title !== undefined
              ? { titleRegeneration: null }
              : {}),
          updatedAt: now,
        };
      }
      case "thread.pull-request.link":
      case "thread.pull-request.unlink":
      case "thread.pull-request-link.sync": {
        const key = normalizeThreadPullRequestKey(command);
        const links = threadPullRequestsOf(thread);
        const existing = links.find((link) => threadPullRequestKeysEqual(link, key));
        let pullRequests = links;
        if (command.type === "thread.pull-request.link") {
          const undismisses =
            existing?.source === "stack-dismissed" &&
            command.source !== "stack" &&
            command.source !== "stack-dismissed";
          if (existing && !undismisses) return thread;
          const link = existing
            ? {
                ...existing,
                source: command.source,
                url: canonicalizeGitCafePullRequestUrl(command.url),
                ...(command.repositoryWebUrl !== undefined && {
                  repositoryWebUrl: command.repositoryWebUrl,
                }),
              }
            : {
                ...key,
                url: canonicalizeGitCafePullRequestUrl(command.url),
                ...(command.repositoryWebUrl !== undefined && {
                  repositoryWebUrl: command.repositoryWebUrl,
                }),
                source: command.source,
                linkedAt: DateTime.formatIso(now),
                snapshot: null,
                stack: null,
              };
          const branch = thread.branchPullRequest;
          const branchKey = branch ? legacyThreadPullRequestKey(branch) : null;
          pullRequests = [
            ...(command.source === "manual" &&
            branch &&
            branchKey &&
            visibleThreadPullRequests(links).length === 0 &&
            !threadPullRequestKeysEqual(branchKey, key) &&
            !links.some((entry) => threadPullRequestKeysEqual(entry, branchKey))
              ? [
                  {
                    ...branchKey,
                    url: canonicalizeGitCafePullRequestUrl(branch.url),
                    source: "manual" as const,
                    linkedAt: DateTime.formatIso(now),
                    snapshot: null,
                    stack: null,
                  },
                ]
              : []),
            ...links.filter((entry) => !threadPullRequestKeysEqual(entry, key)),
            link,
          ];
        } else if (command.type === "thread.pull-request.unlink") {
          if (!existing) return thread;
          const belongsToStack =
            existing.source === "stack" ||
            existing.stack !== null ||
            links.some(
              (link) =>
                link.host.toLowerCase() === key.host &&
                link.repository.toLowerCase() === key.repository &&
                link.stack?.layers.some((layer) => layer.number === key.number),
            );
          pullRequests = belongsToStack
            ? links.map((link) =>
                link === existing
                  ? {
                      ...withPullRequestWatch(link, undefined),
                      source: "stack-dismissed" as const,
                    }
                  : link,
              )
            : links.filter((link) => link !== existing);
        } else {
          if (!existing) return thread;
          pullRequests = links.map((link) =>
            link === existing
              ? { ...link, snapshot: command.snapshot, stack: command.stack }
              : link,
          );
        }
        return {
          ...thread,
          pullRequests,
          linkedPullRequest:
            thread.linkedPullRequest &&
            pullRequests.some(
              (link) =>
                link.source !== "stack-dismissed" &&
                threadPullRequestKeysEqual(
                  link,
                  legacyThreadPullRequestKey(thread.linkedPullRequest!),
                ),
            )
              ? thread.linkedPullRequest
              : null,
          updatedAt: command.type === "thread.pull-request-link.sync" ? thread.updatedAt : now,
        };
      }
      case "thread.pull-request.watch":
      case "thread.pull-request-watch.sync": {
        const key = normalizeThreadPullRequestKey(command);
        const startedAt = DateTime.formatIso(now);
        const linked = threadPullRequestsOf(thread);
        const visible = (link: ThreadPullRequestLink) =>
          link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key);
        const dismissed = linked.find((link) => threadPullRequestKeysEqual(link, key));
        const links =
          command.type === "thread.pull-request.watch" &&
          command.watching &&
          command.link !== undefined &&
          !linked.some(visible)
            ? [
                ...linked.filter((link) => !threadPullRequestKeysEqual(link, key)),
                {
                  ...key,
                  url: canonicalizeGitCafePullRequestUrl(command.link.url),
                  ...((command.link.repositoryWebUrl ?? dismissed?.repositoryWebUrl) !==
                    undefined && {
                    repositoryWebUrl:
                      command.link.repositoryWebUrl ?? dismissed?.repositoryWebUrl,
                  }),
                  source: command.link.source,
                  linkedAt: startedAt,
                  snapshot: null,
                  stack: null,
                  ...(dismissed?.endedWatch && { endedWatch: dismissed.endedWatch }),
                },
              ]
            : linked;
        const existing = links.find(visible);
        if (existing === undefined) return thread;
        const watch =
          command.type === "thread.pull-request-watch.sync"
            ? existing.watch?.startedAt === command.startedAt
              ? (command.watch ?? undefined)
              : existing.watch
            : !command.watching
              ? undefined
              : (existing.watch ?? {
                  startedAt,
                  headSha: null,
                  failedChecks: [],
                  passed: false,
                  passedChecks: [],
                  conflicting: false,
                  // Watching again must not repeat check or conflict news the last watch told.
                  ...(existing.endedWatch && {
                    headSha: existing.endedWatch.headSha,
                    failedChecks: existing.endedWatch.failedChecks,
                    passed: existing.endedWatch.passed,
                    passedChecks: existing.endedWatch.passedChecks,
                    conflicting: existing.endedWatch.conflicting,
                  }),
                  ...(existing.endedWatch?.owedChecks !== undefined && {
                    owedChecks: existing.endedWatch.owedChecks,
                  }),
                  ...(existing.endedWatch?.checksAwaitedSince !== undefined && {
                    checksAwaitedSince: existing.endedWatch.checksAwaitedSince,
                  }),
                  remarksThrough: startedAt,
                  remarkIds: [],
                  wakes: 0,
                });
        if (watch === existing.watch && links === linked) return thread;
        const final =
          command.type === "thread.pull-request-watch.sync" && watch === undefined
            ? command.endedWatch
            : undefined;
        return {
          ...thread,
          pullRequests: links.map((link) =>
            link === existing
              ? withPullRequestWatch(final ? { ...link, watch: final } : link, watch)
              : link,
          ),
          updatedAt: command.type === "thread.pull-request.watch" ? now : thread.updatedAt,
        };
      }
      case "thread.pull-request.sync":
        return {
          ...thread,
          branchPullRequest: command.branchPullRequest,
          ...(command.linkedPullRequest === undefined
            ? {}
            : {
                linkedPullRequest: command.linkedPullRequest,
                pullRequests: [
                  ...threadPullRequestsOf(thread).filter(
                    (link) =>
                      !(
                        thread.linkedPullRequest &&
                        threadPullRequestKeysEqual(
                          link,
                          legacyThreadPullRequestKey(thread.linkedPullRequest),
                        )
                      ) &&
                      !(
                        command.linkedPullRequest &&
                        threadPullRequestKeysEqual(
                          link,
                          legacyThreadPullRequestKey(command.linkedPullRequest),
                        )
                      ),
                  ),
                  ...(command.linkedPullRequest
                    ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                    : []),
                ],
              }),
          updatedAt: thread.updatedAt,
        };
      case "thread.title.regeneration.complete":
        return thread.titleRegeneration?.requestId === command.requestId
          ? {
              ...thread,
              ...(command.title === undefined ? {} : { title: command.title }),
              titleRegeneration: null,
              updatedAt: now,
            }
          : thread;
      case "thread.runtime-mode.set":
        return { ...thread, runtimeMode: command.runtimeMode, updatedAt: now };
      case "thread.interaction-mode.set":
        return { ...thread, interactionMode: command.interactionMode, updatedAt: now };
      case "thread.model-selection.set":
      case "provider.switch":
        return {
          ...thread,
          providerInstanceId: command.modelSelection.instanceId,
          modelSelection: command.modelSelection,
          updatedAt: now,
        };
    }
  })();
  if (
    command.type === "thread.pull-request-link.sync" ||
    command.type === "thread.pull-request-watch.sync"
  ) {
    if (updatedThread === thread) return;
    const link = threadPullRequestsOf(updatedThread).find((candidate) =>
      threadPullRequestKeysEqual(candidate, normalizeThreadPullRequestKey(command)),
    );
    if (link === undefined) return;
    yield* deps.emit(
      events,
      command,
    )({
      type: "thread.pull-request-link-updated",
      threadId: command.threadId,
      providerInstanceId: updatedThread.providerInstanceId,
      occurredAt: now,
      payload: link,
    });
    return;
  }
  const eventType = (() => {
    switch (command.type) {
      case "thread.archive":
        return "thread.archived" as const;
      case "thread.unarchive":
        return "thread.unarchived" as const;
      case "thread.settle":
        return "thread.settled" as const;
      case "thread.unsettle":
        return "thread.unsettled" as const;
      case "thread.snooze":
        return "thread.snoozed" as const;
      case "thread.unsnooze":
        return "thread.unsnoozed" as const;
      case "thread.auto-settle.set":
        return "thread.auto-settle-set" as const;
      case "thread.pin":
        return "thread.pinned" as const;
      case "thread.unpin":
        return "thread.unpinned" as const;
      case "thread.pin.reorder":
        return "thread.pin-reordered" as const;
      case "thread.active.reorder":
        return "thread.active-reordered" as const;
      case "thread.tag.set":
        return "thread.tags-updated" as const;
      case "thread.mark-unread":
        return "thread.marked-unread" as const;
      case "thread.metadata.update":
      case "thread.title.regeneration.complete":
        return "thread.metadata-updated" as const;
      case "thread.pull-request.link":
      case "thread.pull-request.unlink":
      case "thread.pull-request.watch":
      case "thread.pull-request.sync":
        return "thread.pull-request-synced" as const;
      case "thread.runtime-mode.set":
        return "thread.runtime-mode-updated" as const;
      case "thread.interaction-mode.set":
        return "thread.interaction-mode-updated" as const;
      case "thread.model-selection.set":
        return thread.providerInstanceId === command.modelSelection.instanceId
          ? ("thread.model-selection-updated" as const)
          : ("thread.provider-switched" as const);
      case "provider.switch":
        return "thread.provider-switched" as const;
    }
  })();
  yield* deps.emit(
    events,
    command,
  )({
    type: eventType,
    threadId: command.threadId,
    providerInstanceId: updatedThread.providerInstanceId,
    occurredAt: now,
    payload: updatedThread,
  });
  // Archiving ends the guest share, so its waiting files go too.
  yield* deps.releaseGuestAttachments(command, thread.guestShare, updatedThread.guestShare, effects);

  if (command.type === "thread.metadata.update" && command.regenerateTitle === true) {
    yield* Ref.update(effects, (existing) => [
      ...existing,
      deps.pendingThreadTitleGenerationEffect(command.commandId, command.threadId, {
        type: "regenerate",
      }),
    ]);
  }

  if (command.type === "thread.archive") {
    const projection = yield* deps.loadProjectionForCommand(
      command,
      ["runs", "attempts", "nodes", "subagents", "messages"],
      { turnItemTypes: [], messageRoles: ["user"] },
    );
    const emitEvent = deps.emit(events, command);
    const activeRunIds = new Set(
      projection.runs
        .filter((run) => run.status === "queued" || run.status === "preparing")
        .map((run) => run.id),
    );
    const preparingRuns = projection.runs.filter((run) => run.status === "preparing");
    const preparationItems =
      preparingRuns.length === 0
        ? []
        : (yield* deps.loadProjectionForCommand(command, ["turnItems"], {
            turnItemTypes: ["command_execution"],
            turnItemRunIds: preparingRuns.map((run) => run.id),
          })).turnItems;
    for (const run of projection.runs.filter((candidate) => activeRunIds.has(candidate.id))) {
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
      });
    }
    for (const run of preparingRuns) {
      const preparationItem = preparationItems.find(
        (item) =>
          item.runId === run.id &&
          item.type === "command_execution" &&
          item.input === WORKSPACE_PREPARATION_INPUT &&
          item.status === "running",
      );
      if (preparationItem === undefined) continue;
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: preparationItem.nodeId ?? undefined,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...preparationItem,
          status: "cancelled",
          title: "Workspace preparation cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    for (const attempt of projection.attempts.filter(
      (candidate) =>
        activeRunIds.has(candidate.runId) &&
        (candidate.status === "pending" || candidate.status === "running"),
    )) {
      const run = projection.runs.find((candidate) => candidate.id === attempt.runId)!;
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: attempt.runId,
        nodeId: attempt.rootNodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...attempt, status: "cancelled", completedAt: now },
      });
    }
    for (const node of projection.nodes.filter(
      (candidate) =>
        candidate.runId !== null &&
        activeRunIds.has(candidate.runId) &&
        ["pending", "running", "waiting"].includes(candidate.status),
    )) {
      const run = projection.runs.find((candidate) => candidate.id === node.runId)!;
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: node.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...node, status: "cancelled", completedAt: now },
      });
    }
    yield* deps.disposeAllDelegatedCompletionCohorts({
      command,
      events,
      projection: yield* deps.getProjectionWithPendingEvents(command.threadId, events),
      now,
      cancelQueuedDelivery: false,
    });
    yield* deps.closePendingLinkRequests({ command, events, threadId: command.threadId, now });
  }

  // Archive and settle stop idle background work; serialized commands prevent starts racing detach.
  // Settlement rejects active or blocked runs.
  const detachSessionIds = new Set(
    command.type === "thread.archive" || command.type === "thread.settle"
      ? (providerContext?.providerSessions ?? []).map((session) => session.id)
      : command.type === "thread.metadata.update" &&
          command.worktreePath !== undefined &&
          command.worktreePath !== thread.worktreePath
        ? (providerContext?.providerSessions ?? []).map((session) => session.id)
        : command.type === "thread.runtime-mode.set"
          ? (providerContext?.providerSessions ?? [])
              .filter(
                (session) => !session.capabilities.sessions.supportsRuntimeModeSwitchInSession,
              )
              .map((session) => session.id)
          : (providerSwitchPlan?.releaseProviderSessionIds ?? []),
  );
  if (detachSessionIds.size > 0) {
    const liveSessions = (providerContext?.providerSessions ?? []).filter(
      (session) =>
        detachSessionIds.has(session.id) &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
    yield* Effect.forEach(
      liveSessions,
      (session) =>
        Effect.gen(function* () {
          yield* deps.emit(
            events,
            command,
          )({
            type: "provider-session.detached",
            threadId: command.threadId,
            driver: session.driver,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: {
              providerSessionId: session.id,
              detachedAt: now,
              reason:
                command.type === "thread.archive"
                  ? "Thread archived."
                  : command.type === "thread.settle"
                    ? "Thread settled."
                    : command.type === "thread.metadata.update"
                      ? "Workspace changed."
                      : command.type === "thread.runtime-mode.set"
                        ? "Runtime mode changed."
                        : "Provider or model selection changed.",
            },
          });
          const pendingEffect = {
            id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: session.id,
              detail:
                command.type === "thread.archive"
                  ? "Thread archived."
                  : command.type === "thread.settle"
                    ? "Thread settled."
                    : command.type === "thread.metadata.update"
                      ? "Workspace changed."
                      : command.type === "thread.runtime-mode.set"
                        ? "Runtime mode changed."
                        : "Provider or model selection changed.",
              // Terminal detaches revoke MCP credentials; reattachments need other detach reasons to preserve them.
              ...(command.type === "thread.archive" ? { revokeMcpCredential: true } : {}),
            },
          } satisfies PendingOrchestrationEffectV2;
          yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
        }),
      { concurrency: 1, discard: true },
    );
  }

  if (command.type === "thread.archive") {
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:terminal.cleanup`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "terminal.cleanup" },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  }
});

const dispatchMessage = Effect.fn("Orchestrator.dispatchMessage")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  let projection = yield* deps.getProjectionWithPendingEvents(command.threadId, events);
  if (command.manualContinuationOfRunId !== undefined) {
    const source = projection.runs.find((run) => run.id === command.manualContinuationOfRunId);
    const limited = latestRootProviderFailure(source ?? null, projection.turnItems);
    if (
      command.dispatchMode.type !== "start_immediately" ||
      source === undefined ||
      (source.status !== "interrupted" &&
        !(source.status === "failed" && limited?.class === "usage_limit")) ||
      latestExecutedRun(projection.runs)?.id !== source.id ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.runtimeRequests.some((request) => request.status === "pending")
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "This thread can no longer be resumed from that run.",
      });
    }
  }
  if (command.usageLimitContinuationOfRunId !== undefined) {
    const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
    const failure = latestRootProviderFailure(run, projection.turnItems);
    const recovery = projection.thread.limitRecovery;
    const now = yield* DateTime.now;
    if (
      run?.id !== command.usageLimitContinuationOfRunId ||
      failure?.class !== "usage_limit" ||
      threadShellFromProjection(projection).lastErrorClass !== "usage_limit" ||
      !recovery?.autoResume ||
      recovery.requestId !== command.usageLimitRecoveryRequestId ||
      recovery.runId !== run.id ||
      recovery.resetAt !== failure.resetAt ||
      Date.parse(recovery.resetAt) > DateTime.toEpochMillis(now) ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.thread.settledOverride === "settled" ||
      projection.thread.providerInstanceId !== run.providerInstanceId ||
      projection.runtimeRequests.some((request) => request.status === "pending") ||
      (projection.thread.snoozedUntil != null &&
        DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now))
    ) {
      yield* deps.emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          ...(recovery?.autoResume &&
          recovery.requestId === command.usageLimitRecoveryRequestId &&
          recovery.runId === command.usageLimitContinuationOfRunId &&
          projection.thread.snoozedUntil != null &&
          DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now)
            ? { limitRecovery: { ...recovery, requestId: command.commandId } }
            : {}),
        },
      });
      return;
    }
  }

  if (command.restartContinuationOfRunId !== undefined) {
    const source = projection.runs.find((run) => run.id === command.restartContinuationOfRunId);
    if (
      !source ||
      !(
        isRestartContinuationSource(source, projection.providerTurns) ||
        continuationFailedBeforePrompt(source, projection.providerTurns)
      ) ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.thread.providerInstanceId !== source.providerInstanceId ||
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          runRanAfter(run, source),
      ) ||
      (yield* deps.stopReachedRun(command, command.threadId, source.id))
    ) {
      // Preserve the current row so stale automatic deliveries receive an
      // accepted receipt without changing work or repeatedly retrying.
      yield* deps.emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: yield* DateTime.now,
        payload: projection.thread,
      });
      return;
    }
  }

  if (projection.thread.lastVisitedAt === null && !isNativeMaintenanceCommand(command)) {
    const now = yield* DateTime.now;
    // Null keeps imported history read. The first fresh dispatch establishes
    // a read watermark so its completion can be unread on every client.
    // Offset it so a completion in the same millisecond is still unread.
    const event = yield* deps.emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: projection.thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...projection.thread,
        lastVisitedAt: DateTime.subtract(now, { milliseconds: 1 }),
      },
    });
    projection = applyToProjection(projection, event);
  }

  const continuedTaskId = projection.runs.find(
    (run) => run.id === command.restartContinuationOfRunId,
  )?.delegatedTaskId;

  if (projection.thread.settledOverride !== null) {
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      ...projection.thread,
      settledOverride: null,
      settledAt: null,
      unsettledAt:
        projection.thread.settledOverride === "active"
          ? (projection.thread.unsettledAt ?? null)
          : now,
      updatedAt: now,
    };
    const event = yield* deps.emit(
      events,
      command,
    )({
      type: "thread.unsettled",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: thread,
    });
    projection = applyToProjection(projection, event);
  }
  // Background wakes and delegated completions continue work the user already snoozed, so
  // only a message someone actually sent ends the snooze.
  const automaticWake =
    command.notification !== undefined || command.delegatedCompletion !== undefined;
  if (projection.thread.snoozedUntil != null && !automaticWake) {
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      ...projection.thread,
      snoozedUntil: null,
      snoozedAt: null,
      updatedAt: now,
    };
    const event = yield* deps.emit(
      events,
      command,
    )({
      type: "thread.unsnoozed",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: thread,
    });
    projection = applyToProjection(projection, event);
  }
  const userMessages = projection.messages.filter((message) => message.role === "user");
  const onlyMaintenanceHistory =
    userMessages.length > 0 && userMessages.every(isNativeMaintenanceCommand);
  if (
    !isNativeMaintenanceCommand(command) &&
    ((command.titleSeed !== undefined &&
      (yield* deps.projectionStore
        .getMessageCount(command.threadId)
        .pipe(mapDispatchError(command))) === 0) ||
      (command.createdBy === "user" && onlyMaintenanceHistory))
  ) {
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      ...projection.thread,
      title: command.titleSeed ?? projection.thread.title,
      titleRegeneration: { requestId: command.commandId, startedAt: now },
      updatedAt: now,
    };
    const event = yield* deps.emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: thread,
    });
    yield* Ref.update(effects, (existing) => [
      ...existing,
      deps.pendingThreadTitleGenerationEffect(command.commandId, command.threadId, {
        type: "initial",
        messageId: command.messageId,
      }),
    ]);
    projection = applyToProjection(projection, event);
  }
  const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
  let dispatchMode = resolveMessageDispatchIntent(
    projection,
    command.dispatchMode,
    command.deliveryIntent,
  );
  if (dispatchMode.type === "steer_active") {
    const targetRunId = dispatchMode.targetRunId;
    const target = projection.runs.find((run) => run.id === targetRunId);
    const turn = latestProviderTurnForAttempt(
      projection.providerTurns.filter((candidate) => candidate.nodeId === target?.rootNodeId),
      target?.activeAttemptId,
    );
    // The client may still show a running turn while its completion is being
    // projected. Preserve the submission as a new turn when steering is too late.
    if (
      target !== undefined &&
      (target.status === "completed" ||
        ((target.status === "running" || target.status === "waiting") &&
          turn !== undefined &&
          turn.status === "completed"))
    ) {
      dispatchMode = { type: "start_immediately" };
    }
  }
  // Stop leaves the run reading as running until its provider stops. A plain
  // send in that window queues behind the stopped queue instead of steering
  // text the agent never receives, and like any user send it releases the
  // hold; an explicit steer or restart still fails below.
  if (
    command.deliveryIntent === "auto" &&
    (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") &&
    (yield* deps.stopReachedRun(command, command.threadId, dispatchMode.targetRunId))
  ) {
    dispatchMode = { type: "queue_after_active" };
  }
  // Codex and Claude own /goal; elsewhere it is ordinary text that cannot steer.
  const parsedGoalCommand = parseGoalCommand(command);
  const goalCommand =
    parsedGoalCommand === null ||
    (yield* deps.goalDriverFor(command, modelSelection.instanceId)) === undefined
      ? null
      : parsedGoalCommand;
  let goalStopRunId: RunId | undefined;
  if (goalCommand !== null) {
    yield* deps.ensureGoalCommandSupported(command, command, modelSelection.instanceId);
    // A goal command never joins a running turn. One that starts or ends goal
    // work stops the run and goes first in the queue; the rest wait. A send
    // that asked to be queued (no delivery intent) only queues, and a run
    // that is only finishing or running background work is never stopped.
    const resolvedMode = dispatchMode;
    const target =
      resolvedMode.type === "steer_active" || resolvedMode.type === "restart_active"
        ? projection.runs.find((run) => run.id === resolvedMode.targetRunId)
        : resolvedMode.type === "queue_after_active" && command.deliveryIntent !== undefined
          ? projection.runs.findLast(isLiveRun)
          : undefined;
    if (target !== undefined) {
      const goal = projection.providerThreads.find(
        (candidate) => candidate.id === target.providerThreadId,
      )?.goal;
      const targetMessage = projection.messages.find(
        (message) => message.id === target.userMessageId,
      );
      if (
        isLiveRun(target) &&
        goalCommandStopsActiveRun(goalCommand, goal?.status ?? null) &&
        (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
        !(yield* deps.stopReachedRun(command, command.threadId, target.id))
      ) {
        goalStopRunId = target.id;
      }
      dispatchMode = { type: "queue_after_active" };
    }
  }
  if (
    command.notification !== undefined &&
    (command.createdBy !== "agent" ||
      (command.creationSource !== "server" && command.creationSource !== "provider") ||
      (dispatchMode.type !== "queue_after_active" &&
        !(
          command.restartContinuationOfRunId !== undefined &&
          dispatchMode.type === "start_immediately"
        )))
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Notifications must be server- or provider-created queued messages.",
    });
  }
  let delegatedCompletion: OrchestrationV2ConversationMessage["delegatedCompletion"] | undefined;
  if (command.delegatedCompletion !== undefined) {
    const requestedCompletion = command.delegatedCompletion;
    if (
      command.createdBy !== "agent" ||
      command.creationSource !== "server" ||
      dispatchMode.type !== "queue_after_active"
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Delegated completion delivery must be a server-created queued message.",
      });
    }
    const parentRun = projection.runs.find(
      (candidate) => candidate.id === requestedCompletion.parentRunId,
    );
    const delivery = parentRun?.delegatedCompletion?.delivery;
    if (
      parentRun?.delegatedCompletion?.disposition !== "open" ||
      delivery === null ||
      delivery === undefined ||
      delivery.generation !== requestedCompletion.generation ||
      delivery.messageId !== command.messageId ||
      (projection.messages.some((candidate) => candidate.id === command.messageId) &&
        !isUndeliveredMailboxSteer(projection, command.messageId))
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Delegated completion delivery is no longer dispatchable.",
      });
    }
    delegatedCompletion = {
      parentRunId: requestedCompletion.parentRunId,
      generation: delivery.generation,
      taskIds: delivery.taskIds,
    };
  }
  // Route durable mailbox deliveries and delegated task questions under the
  // thread lock, using the live session's capabilities. A question queued
  // behind a long parent turn is never seen. Never interrupt/restart a turn
  // for a notification.
  if (
    delegatedCompletion !== undefined
      ? delegatedCompletion.taskIds.every(
          (id) =>
            projection.subagents.find((task) => task.id === id)?.completionWake === "always",
        )
      : command.notification?.source.kind === "delegated_task"
  ) {
    const active = projection.runs.find((run) => run.status === "running");
    const providerThread = projection.providerThreads.find(
      (row) => row.id === active?.providerThreadId,
    );
    const activeTurn = projection.providerTurns.find(
      (turn) => turn.runAttemptId === active?.activeAttemptId && turn.status === "running",
    );
    const activeMessage = projection.messages.find(
      (message) => message.id === active?.userMessageId,
    );
    if (
      active !== undefined &&
      activeTurn !== undefined &&
      providerThread?.providerSessionId != null &&
      (activeMessage === undefined || !isNativeMaintenanceCommand(activeMessage))
    ) {
      const session = yield* deps.providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (
        Option.isSome(session) &&
        session.value.providerSession.capabilities.turns.supportsActiveSteering &&
        session.value.providerSession.capabilities.turns.activeSteeringInterruptsTools !== true &&
        !(yield* deps.stopReachedRun(command, command.threadId, active.id))
      ) {
        dispatchMode = { type: "steer_active", targetRunId: active.id };
      }
    }
  }
  const dispatchText =
    delegatedCompletion === undefined
      ? command.text
      : delegatedCompletionWakeDetail(delegatedCompletion.taskIds, projection.subagents);
  const sourcePlanProjection =
    command.sourcePlanRef === undefined
      ? null
      : yield* deps.getProjectionWithPendingEvents(command.sourcePlanRef.threadId, events);
  const sourcePlanArtifact =
    command.sourcePlanRef === undefined
      ? undefined
      : yield* deps.projectionStore
          .getPlan(command.sourcePlanRef.threadId, command.sourcePlanRef.planId)
          .pipe(mapDispatchError(command));
  const sourcePlan = sourcePlanArtifact?.kind === "proposed_plan" ? sourcePlanArtifact : null;
  if (command.sourcePlanRef !== undefined && sourcePlan === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Proposed plan ${command.sourcePlanRef.planId} does not exist on thread ${command.sourcePlanRef.threadId}.`,
    });
  }
  if (
    sourcePlanProjection !== null &&
    sourcePlanProjection.thread.projectId !== projection.thread.projectId
  ) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Proposed plan ${command.sourcePlanRef?.planId} belongs to a different project.`,
    });
  }
  if (sourcePlan !== null && sourcePlan.status !== "active") {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Proposed plan ${sourcePlan.id} is not active.`,
    });
  }
  const completeSourcePlan = (occurredAt: DateTime.Utc) =>
    sourcePlan === null
      ? Effect.void
      : deps.emit(
          events,
          command,
        )({
          type: "plan.updated",
          threadId: sourcePlan.threadId,
          ...(sourcePlan.runId === null ? {} : { runId: sourcePlan.runId }),
          nodeId: sourcePlan.nodeId,
          occurredAt,
          payload: { ...sourcePlan, status: "completed" },
        });

  if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
    yield* deps.dispatchSteerIntoRun({
      command,
      events,
      effects,
      projection,
      modelSelection:
        delegatedCompletion === undefined && command.notification === undefined
          ? modelSelection
          : (projection.runs.find((run) => run.id === dispatchMode.targetRunId)?.modelSelection ??
            modelSelection),
      delegatedCompletion,
      ...(command.notification === undefined ? {} : { notification: command.notification }),
      targetRunId: dispatchMode.targetRunId,
      messageId: command.messageId,
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      forceRestart: dispatchMode.type === "restart_active",
    });
    return;
  }

  const activeProviderThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  const activeRun = projection.runs.find(isActiveRun);
  // A message queued during worktree setup can arrive after that setup failed
  // without a worktree. It waits, held, like the messages queued before the
  // failure, instead of starting in the project checkout.
  const latestRun = latestExecutedRun(projection.runs);
  const worktreeMissingRun =
    activeRun === undefined &&
    dispatchMode.type === "queue_after_active" &&
    (latestRun?.status === "failed" || latestRun?.status === "interrupted") &&
    latestRun.workspacePreparation?.type === "worktree" &&
    projection.thread.worktreePath === null
      ? latestRun
      : undefined;
  const queueBehindRun = activeRun ?? worktreeMissingRun;
  const pendingMergeBackTransfers = pendingMergeBackTransfersForThread(projection);
  const startsOrQueuesRun =
    dispatchMode.type === "defer_start" ||
    dispatchMode.type === "start_immediately" ||
    dispatchMode.type === "queue_after_active";
  const shouldQueue = queueBehindRun !== undefined && startsOrQueuesRun;
  // Client messages resume held queues; server continuations and scheduled tasks do not.
  // Provider failure or usage limits re-hold the queue.
  const worktreeSetupUnresolved = worktreeSetupPending(projection);
  const sentByUserFromClient =
    command.createdBy === "user" &&
    (command.creationSource === "web" || command.creationSource === "mobile") &&
    command.scheduledTaskId === undefined;
  const heldRunsToRelease =
    sentByUserFromClient && startsOrQueuesRun && !worktreeSetupUnresolved
      ? projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true)
      : [];
  const releasedAt = yield* DateTime.now;
  for (const held of heldRunsToRelease) {
    yield* deps.emit(
      events,
      command,
    )({
      type: "run.updated",
      threadId: command.threadId,
      runId: held.id,
      providerInstanceId: held.providerInstanceId,
      occurredAt: releasedAt,
      payload: { ...held, queueHeld: false },
    });
  }
  if (shouldQueue) {
    if (pendingMergeBackTransfers.length > 0) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.`,
      });
    }
    const queueProviderThread =
      activeProviderThread ??
      projection.providerThreads.find(
        (candidate) => candidate.id === queueBehindRun.providerThreadId,
      );
    if (queueProviderThread === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Active run ${queueBehindRun.id} has no provider thread for queued dispatch.`,
      });
    }
    const now = yield* DateTime.now;
    const ordinal = nextRunOrdinal(projection);
    const runId = deps.idAllocator.derive.run({ threadId: command.threadId, ordinal });
    const targetProviderThread =
      modelSelection.instanceId === queueProviderThread.providerInstanceId
        ? queueProviderThread
        : rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0];
    const queuedAdapter = yield* deps.providerAdapters
      .get(modelSelection.instanceId)
      .pipe(mapDispatchError(command));
    const selectedProviderSession =
      targetProviderThread?.providerSessionId === null ||
      targetProviderThread?.providerSessionId === undefined
        ? undefined
        : projection.providerSessions.find(
            (candidate) => candidate.id === targetProviderThread.providerSessionId,
          );
    const queuedCapabilities =
      selectedProviderSession?.capabilities ??
      (yield* queuedAdapter.getCapabilities().pipe(mapDispatchError(command)));
    yield* mapDispatchError(command)(
      deps.commandPolicy.ensureQueuedMessages({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities: queuedCapabilities,
      }),
    );
    const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
      id: deps.idAllocator.derive.providerThread({
        driver: queuedAdapter.driver,
        nativeThreadId: `pending:${runId}`,
      }),
      driver: queuedAdapter.driver,
      providerInstanceId: modelSelection.instanceId,
      providerSessionId: null,
      appThreadId: command.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
    const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
    const checkpointScope =
      queueBehindRun.status === "preparing" || worktreeMissingRun !== undefined
        ? null
        : yield* deps.runtimePolicy.resolve({ thread: projection.thread, modelSelection }).pipe(
            Effect.flatMap((resolvedRuntimePolicy) =>
              deps.checkpointService.prepareRootRunScope({
                threadId: command.threadId,
                runId,
                rootNodeId,
                providerThreadId: queuedProviderThread.id,
                cwd:
                  resolvedRuntimePolicy.cwd ??
                  selectedProviderSession?.cwd ??
                  projection.thread.worktreePath ??
                  process.cwd(),
                createdAt: now,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
    const queueIsHeld = projection.runs.some(
      (candidate) => candidate.status === "queued" && candidate.queueHeld === true,
    );
    // Buffered wakes need a T3 run for output the CLI already started producing.
    // Stop still holds wakes that arrive before the active run settles.
    const wakeSkipsHold =
      !worktreeSetupUnresolved &&
      activeRun !== undefined &&
      queueIsHeld &&
      command.createdBy === "agent" &&
      command.creationSource === "provider" &&
      !(yield* deps.stopReachedRun(command, command.threadId, activeRun.id));
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: command.threadId,
      ordinal,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: queuedProviderThread.id,
      userMessageId: command.messageId,
      rootNodeId,
      activeAttemptId: attemptId,
      status: "queued",
      ...(worktreeMissingRun !== undefined ||
      (heldRunsToRelease.length === 0 && queueIsHeld && !wakeSkipsHold)
        ? { queueHeld: true }
        : {}),
      queuePosition:
        goalStopRunId !== undefined
          ? 1
          : Math.max(
              0,
              ...projection.runs
                .filter((candidate) => candidate.status === "queued")
                .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
            ) + 1,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
      ...(command.restartContinuationOfRunId === undefined
        ? {}
        : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
      ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
    };
    const attempt: OrchestrationV2RunAttempt = {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: queuedProviderThread.id,
      providerTurnId: null,
      reason: "initial",
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    const rootNode: OrchestrationV2ExecutionNode = {
      id: rootNodeId,
      threadId: command.threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId: queuedProviderThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: checkpointScope?.id ?? null,
      startedAt: null,
      completedAt: null,
    };
    const message: OrchestrationV2ConversationMessage = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      id: command.messageId,
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      role: "user",
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
      ...(command.notification === undefined ? {} : { notification: command.notification }),
    };
    const emitEvent = deps.emit(events, command);
    if (targetProviderThread === undefined) {
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: queuedProviderThread,
      });
    }
    yield* emitEvent({
      type: "run.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: run,
    });
    yield* completeSourcePlan(now);
    yield* emitEvent({
      type: "run-attempt.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: attempt,
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: rootNode,
    });
    if (checkpointScope !== null) {
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: checkpointScope,
      });
    }
    yield* emitEvent({
      type: "message.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: message,
    });
    const existingItem = projection.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === command.messageId,
    );
    if (existingItem?.type === "user_message") {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...existingItem,
          runId,
          nodeId: rootNodeId,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          inputIntent: "queued_turn",
          status: "pending",
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    if (goalStopRunId !== undefined) {
      return yield* deps.stopRunForQueuedCommand({
        command,
        events,
        effects,
        projection: yield* deps.getProjectionWithPendingEvents(command.threadId, events),
        queuedRunId: runId,
        targetRunId: goalStopRunId,
        reason: "Stopped to apply /goal",
        now,
      });
    }
    return;
  }
  const pendingForkTransfer = pendingForkTransferForThread(projection);
  const pendingMergeBackSourceThreadIds = new Set(
    pendingMergeBackTransfers.map((transfer) => transfer.sourceThreadId),
  );
  if (pendingMergeBackSourceThreadIds.size > 1) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} has pending merge-back transfers from multiple forks.`,
    });
  }
  const pendingMergeBackTransfer = latestContextTransfer(pendingMergeBackTransfers);
  const supersededMergeBackTransfers = pendingMergeBackTransfers.filter(
    (transfer) => transfer.id !== pendingMergeBackTransfer?.id,
  );
  const now = yield* DateTime.now;
  if (
    !modelSelectionsEqual(projection.thread.modelSelection, modelSelection) ||
    projection.thread.providerInstanceId !== modelSelection.instanceId
  ) {
    yield* deps.emit(
      events,
      command,
    )({
      type:
        projection.thread.providerInstanceId === modelSelection.instanceId
          ? "thread.model-selection-updated"
          : "thread.provider-switched",
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...projection.thread,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        updatedAt: now,
      },
    });
  }
  const ordinal = nextRunOrdinal(projection);
  const runId = deps.idAllocator.derive.run({ threadId: command.threadId, ordinal });
  const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
  const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
  const legacyImportItems =
    projection.thread.historyOrigin === "v1_import"
      ? yield* deps.readHandoffItems(command.threadId, [null])
      : [];
  const isProviderSwitch =
    activeProviderThread !== undefined &&
    activeProviderThread.providerInstanceId !== modelSelection.instanceId;
  // Account overlays share native history. Selection commands may already
  // have updated the app thread, so classify against the native thread's owner.
  const providerSwitchPlan = isProviderSwitch
    ? yield* deps.providerSwitchService
        .plan({
          projection: {
            ...projection,
            thread: {
              ...projection.thread,
              modelSelection: {
                ...projection.thread.modelSelection,
                instanceId: activeProviderThread.providerInstanceId,
              },
            },
          },
          targetModelSelection: modelSelection,
        })
        .pipe(mapDispatchError(command))
    : null;
  const canResumeAcrossInstances =
    isProviderSwitch &&
    activeProviderThread.nativeThreadRef !== null &&
    providerSwitchPlan?.transition.type === "restart_and_resume";
  const sessionsToDetach = projection.providerSessions.filter(
    (session) =>
      providerSwitchPlan?.releaseProviderSessionIds.includes(session.id) &&
      session.status !== "stopped" &&
      session.status !== "error",
  );
  for (const detaching of sessionsToDetach) {
    if (yield* deps.sessionHasBackgroundWork(detaching, projection.providerThreads)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          "The previous provider is still running background agents or commands, and switching would end them. Wait for them to finish, or press Stop, then send the message again.",
      });
    }
  }

  if (
    pendingForkTransfer === undefined &&
    pendingMergeBackTransfer === undefined &&
    !isProviderSwitch
  ) {
    const adapter = yield* deps.providerAdapters.get(modelSelection.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: command.commandId,
            providerInstanceId: modelSelection.instanceId,
            cause,
          }),
      ),
    );
    const providerSessionId =
      activeProviderThread?.providerSessionId ??
      (yield* mapDispatchError(command)(
        deps.providerSessionIdFor({
          adapter,
          providerInstanceId: modelSelection.instanceId,
          threadId: command.threadId,
        }),
      ));
    const providerThreadId =
      activeProviderThread?.id ??
      deps.idAllocator.derive.providerThread({
        driver: adapter.driver,
        nativeThreadId: `pending:${runId}`,
      });
    const legacyImportHandoff = shouldPrepareLegacyImportHandoff({
      historyOrigin: projection.thread.historyOrigin,
      hasCompletedRun: latestCompletedRun !== undefined,
      legacyImportItemCount: legacyImportItems.length,
    })
      ? yield* deps.contextHandoffService
          .prepareLegacyImport({
            threadId: command.threadId,
            targetRunId: runId,
            toProviderThreadId: providerThreadId,
            toProviderInstanceId: modelSelection.instanceId,
            items: legacyImportItems,
            createdAt: now,
          })
          .pipe(mapDispatchError(command))
      : null;
    const providerThread: OrchestrationV2ProviderThread =
      activeProviderThread === undefined
        ? {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: command.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: ordinal,
            lastRunOrdinal: ordinal,
            handoffIds: legacyImportHandoff === null ? [] : [legacyImportHandoff.id],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }
        : {
            ...(activeProviderThread as OrchestrationV2ProviderThread),
            providerSessionId,
            lastRunOrdinal: ordinal,
            handoffIds: appendContextHandoffId(
              activeProviderThread.handoffIds,
              legacyImportHandoff?.id ?? null,
            ),
            updatedAt: now,
          };
    const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
    const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
    const checkpointScope =
      dispatchMode.type === "defer_start"
        ? null
        : yield* deps.runtimePolicy
            .resolve({
              thread: projection.thread,
              modelSelection,
            })
            .pipe(
              mapDispatchError(command),
              Effect.flatMap((resolvedRuntimePolicy) =>
                deps.checkpointService.prepareRootRunScope({
                  threadId: command.threadId,
                  runId,
                  rootNodeId,
                  providerThreadId,
                  cwd:
                    resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                  createdAt: now,
                }),
              ),
              mapDispatchError(command),
            );
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: command.threadId,
      ordinal,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: command.messageId,
      rootNodeId,
      activeAttemptId: attemptId,
      status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
      queuePosition: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: legacyImportHandoff?.id ?? null,
      ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
      ...(command.restartContinuationOfRunId === undefined
        ? {}
        : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
      ...(dispatchMode.type === "defer_start" && dispatchMode.workspaceStrategy !== undefined
        ? { workspacePreparation: dispatchMode.workspaceStrategy }
        : {}),
      ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
      ...wakeWorkStartedAt(projection.runs, command),
          };
    const attempt: OrchestrationV2RunAttempt = {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    const rootNode: OrchestrationV2ExecutionNode = {
      id: rootNodeId,
      threadId: command.threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: checkpointScope?.id ?? null,
      startedAt: null,
      completedAt: null,
    };
    const message: OrchestrationV2ConversationMessage = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      id: command.messageId,
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      role: "user",
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
      ...(command.notification === undefined ? {} : { notification: command.notification }),
    };
    const turnItem: OrchestrationV2TurnItem = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      ...(command.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: command.scheduledTaskId }),
      ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
      id: deps.idAllocator.derive.userTurnItem({ messageId: command.messageId }),
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* deps.nextTurnItemOrdinal(projection),
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_message",
      messageId: command.messageId,
      inputIntent: "turn_start",
      text: dispatchText,
      ...(command.context ? { context: command.context } : {}),
      attachments: command.attachments,
      ...(run.contextHandoffId === null ? modelSwitchSince(projection, modelSelection) : {}),
    };
    const preparationTurnItem: OrchestrationV2TurnItem | null =
      dispatchMode.type === "defer_start"
        ? {
            id: deps.idAllocator.derive.turnItemFromProviderItem({
              driver: adapter.driver,
              nativeItemId: `workspace-preparation:${runId}`,
            }),
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: turnItem.ordinal + 1,
            status: "running",
            title: WORKSPACE_PREPARATION_INPUT,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "command_execution",
            input: WORKSPACE_PREPARATION_INPUT,
          }
        : null;
    const emitEvent = deps.emit(events, command);
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: command.threadId,
      driver: adapter.driver,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: providerThread,
    });
    if (legacyImportHandoff !== null) {
      yield* emitEvent({
        type: "context-handoff.updated",
        threadId: command.threadId,
        runId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: legacyImportHandoff,
      });
    }
    yield* emitEvent({
      type: "run.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: run,
    });
    yield* completeSourcePlan(now);
    yield* emitEvent({
      type: "run-attempt.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: attempt,
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: rootNode,
    });
    if (checkpointScope !== null) {
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: checkpointScope,
      });
    }
    yield* emitEvent({
      type: "message.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: message,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: notificationTurnItem(
        turnItem,
        message,
        yield* deps.notificationTasks(command.threadId, message, projection.subagents),
      ),
    });
    if (preparationTurnItem !== null) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: preparationTurnItem,
      });
    }
    const pendingEffect = {
      id: `effect:${command.commandId}:provider-turn.start:${runId}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: { type: "provider-turn.start", runId },
    } satisfies PendingOrchestrationEffectV2;
    if (dispatchMode.type !== "defer_start") {
      yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
    }
    return;
  }
  const sourceProjection =
    pendingForkTransfer === undefined
      ? null
      : yield* deps.projectionStore
          .getThreadRecords(pendingForkTransfer.sourceThreadId, [
            "runs",
            "attempts",
            "providerThreads",
            "providerTurns",
          ])
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProjectionError({
                  threadId: pendingForkTransfer.sourceThreadId,
                  cause,
                }),
            ),
          );
  const sourceRun =
    pendingForkTransfer?.sourcePoint.runId === undefined || sourceProjection === null
      ? null
      : (sourceProjection.runs.find(
          (candidate) => candidate.id === pendingForkTransfer.sourcePoint.runId,
        ) ?? null);
  const sourceProviderThread =
    sourceProjection === null || sourceRun === null
      ? undefined
      : providerThreadForRun(sourceProjection, sourceRun);
  const sourceProviderTurnId =
    sourceProjection === null || sourceRun === null || sourceRun.activeAttemptId === null
      ? undefined
      : (latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceRun.activeAttemptId)
          ?.id ??
        sourceProjection.attempts.find((candidate) => candidate.id === sourceRun.activeAttemptId)
          ?.providerTurnId ??
        undefined);
  const sideChatFork =
    pendingForkTransfer !== undefined && projection.thread.lineage.sideChat === true;
  // Opened during the parent's first turn: the digest is the whole context.
  const sideChatWithoutSource =
    sideChatFork && pendingForkTransfer.sourcePoint.runId === undefined;
  if (pendingForkTransfer !== undefined) {
    if (!sideChatWithoutSource && (sourceRun === null || sourceProviderThread === undefined)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Pending fork transfer ${pendingForkTransfer.id} has no resolvable source provider thread.`,
      });
    }
    if (pendingForkTransfer.sourceProviderInstanceId === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Pending fork transfer ${pendingForkTransfer.id} has no source provider.`,
      });
    }
  }

  const adapter = yield* deps.providerAdapters.get(modelSelection.instanceId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorProviderAdapterError({
          commandId: command.commandId,
          providerInstanceId: modelSelection.instanceId,
          cause,
        }),
    ),
  );
  const targetProviderThread =
    isProviderSwitch && !canResumeAcrossInstances
      ? rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0]
      : activeProviderThread;
  const providerSessionId =
    (canResumeAcrossInstances ? undefined : targetProviderThread?.providerSessionId) ??
    (yield* mapDispatchError(command)(
      deps.providerSessionIdFor({
        adapter,
        providerInstanceId: modelSelection.instanceId,
        threadId: command.threadId,
      }),
    ));
  const existingProviderSession = projection.providerSessions.find(
    (candidate) => candidate.id === providerSessionId,
  );
  const resolvedRuntimePolicy = yield* deps.runtimePolicy
    .resolve({ thread: projection.thread, modelSelection })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

  const capabilities = yield* adapter.getCapabilities().pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorProviderAdapterError({
          commandId: command.commandId,
          providerInstanceId: modelSelection.instanceId,
          cause,
        }),
    ),
  );
  const sourceRunsAfterFork =
    sourceProjection === null
      ? []
      : sourceProjection.runs.filter(
          (candidate) => sourceRun === null || candidate.ordinal > sourceRun.ordinal,
        );
  const forkExecution =
    pendingForkTransfer === undefined || sourceRun === null
      ? null
      : yield* mapDispatchError(command)(
          deps.commandPolicy.decideForkExecution({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            sameProvider:
              pendingForkTransfer.sourceProviderInstanceId === modelSelection.instanceId,
            hasStrongNativeSource: sourceProviderThread?.nativeThreadRef?.strength === "strong",
            sourceRunStatus: sourceRun.status,
            fromSpecificTurn: sourceRun !== null,
            sourceBusy: sourceRunsAfterFork.some(isActiveRun),
          }),
        );
  const canResolveForkNatively = forkExecution === "native_fork";
  const requiresPortableFork = forkExecution === "portable_context";

  if (canResolveForkNatively) {
    yield* mapDispatchError(command)(
      deps.commandPolicy.ensureNativeFork({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities,
        fromSpecificTurn: sourceRun !== null,
      }),
    );
  }

    const ensuredProviderThread: OrchestrationV2ProviderThread =
    targetProviderThread === undefined
      ? {
          id: deps.idAllocator.derive.providerThread({
            driver: adapter.driver,
            nativeThreadId: `pending:${runId}`,
          }),
          driver: adapter.driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId,
          appThreadId: command.threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: ordinal,
          lastRunOrdinal: ordinal,
          handoffIds: [],
          forkedFrom:
            canResolveForkNatively && sourceProviderThread !== undefined
              ? {
                  providerThreadId: sourceProviderThread.id,
                  ...(sourceProviderTurnId === undefined
                    ? {}
                    : { providerTurnId: sourceProviderTurnId }),
                }
              : null,
          createdAt: now,
          updatedAt: now,
        }
      : {
          ...(targetProviderThread as OrchestrationV2ProviderThread),
          providerInstanceId: modelSelection.instanceId,
          providerSessionId,
          updatedAt: now,
        };
  const portableForkItems =
    !requiresPortableFork || sourceProjection === null || sourceRun === null
      ? []
      : yield* readForkHistoryItems(deps.projectionStore, sourceProjection, sourceRun).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({ threadId: sourceProjection.thread.id, cause }),
          ),
        );
  const portableForkHandoff =
    !requiresPortableFork ||
    pendingForkTransfer === undefined ||
    sourceProjection === null ||
    sourceRun === null
      ? null
      : yield* deps.contextHandoffService
          .prepareProviderHandoff({
            threadId: command.threadId,
            targetRunId: runId,
            transferId: pendingForkTransfer.id,
            fromProviderThreadIds:
              sourceProviderThread === undefined ? [] : [sourceProviderThread.id],
            toProviderThreadId: ensuredProviderThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: modelSelection.instanceId,
            coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, portableForkItems),
            strategy: "full_thread_summary",
            items: portableForkItems,
            runs: sourceProjection.runs,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
  // Without a source run the digest covers the parent's whole history: inherited fork rows
  // first, so the cap truncates them first, then imported and run items.
  const sideChatParentRunIds = [
    // Queued messages have not reached the main thread yet.
    ...sourceRunsAfterFork.filter((run) => run.status !== "queued").map((run) => run.id),
    ...(sourceRun === null && sourceProjection?.thread.historyOrigin === "v1_import"
      ? [null]
      : []),
  ];
  const sideChatParentItems =
    !sideChatFork || sourceProjection === null
      ? []
      : [
          ...(sideChatWithoutSource ? yield* deps.readInheritedItems(sourceProjection.thread) : []),
          ...(sideChatParentRunIds.length === 0
            ? []
            : visibleConversationItems(
                sourceProjection,
                yield* deps.readHandoffItems(sourceProjection.thread.id, sideChatParentRunIds),
              )),
        ];
  // The framing note goes in even when the parent has no activity after the fork point.
  const sideChatContextHandoff =
    !sideChatFork || pendingForkTransfer === undefined || sourceProjection === null
      ? null
      : yield* deps.contextHandoffService
          .prepareSideChatContext({
            threadId: command.threadId,
            parentThreadId: sourceProjection.thread.id,
            targetRunId: runId,
            transferId: pendingForkTransfer.id,
            toProviderThreadId: ensuredProviderThread.id,
            fromProviderInstanceId:
              pendingForkTransfer.sourceProviderInstanceId ?? modelSelection.instanceId,
            toProviderInstanceId: modelSelection.instanceId,
            coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, sideChatParentItems),
            parentItems: sideChatParentItems,
            createdAt: now,
          })
          .pipe(mapDispatchError(command));
  const requiresFullProviderSwitchContext =
    isProviderSwitch && pendingMergeBackTransfer !== undefined;
  const targetLastCompletedRun =
    targetProviderThread === undefined
      ? undefined
      : lastDeliveredRunForProviderThread(projection, targetProviderThread.id);
  const providerSwitchCoveredRuns =
    !isProviderSwitch || canResumeAcrossInstances || latestHandoffRun === undefined
      ? []
      : projection.runs.filter(
          (run) =>
            isHandoffSourceRun(run) &&
            run.ordinal >
              (requiresFullProviderSwitchContext ? 0 : (targetLastCompletedRun?.ordinal ?? 0)) &&
            run.ordinal <= latestHandoffRun.ordinal,
        );
  const providerSwitchItems =
    providerSwitchCoveredRuns.length === 0
      ? []
      : [
          ...(latestCompletedRun !== undefined &&
          (targetProviderThread === undefined || requiresFullProviderSwitchContext)
            ? legacyImportItems
            : []),
          ...(yield* deps.readHandoffItems(
            command.threadId,
            providerSwitchCoveredRuns.map((run) => run.id),
          )),
        ];
  const providerSwitchTransferId =
    providerSwitchCoveredRuns.length === 0 || latestHandoffRun === undefined
      ? null
      : yield* mapDispatchError(command)(
          deps.idAllocator.allocate.contextTransfer({
            sourceThreadId: command.threadId,
            targetThreadId: command.threadId,
            type: "provider_handoff",
          }),
        );
  if (providerSwitchTransferId !== null) {
    yield* mapDispatchError(command)(
      deps.commandPolicy.ensureContextHandoff({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities,
        strategy:
          targetProviderThread === undefined || requiresFullProviderSwitchContext
            ? "full_thread_summary"
            : "delta_context",
      }),
    );
  }
  const providerSwitchHandoff =
    providerSwitchTransferId === null || latestHandoffRun === undefined
      ? null
      : yield* deps.contextHandoffService
          .prepareProviderHandoff({
            threadId: command.threadId,
            targetRunId: runId,
            transferId: providerSwitchTransferId,
            fromProviderThreadIds: Array.from(
              new Set(
                providerSwitchCoveredRuns.flatMap((run) =>
                  run.providerThreadId === null ? [] : [run.providerThreadId],
                ),
              ),
            ),
            toProviderThreadId: ensuredProviderThread.id,
            fromProviderInstanceId: latestHandoffRun.providerInstanceId,
            toProviderInstanceId: modelSelection.instanceId,
            coveredRunOrdinals: {
              from: providerSwitchCoveredRuns[0]!.ordinal,
              to: providerSwitchCoveredRuns.at(-1)!.ordinal,
            },
            strategy:
              targetProviderThread === undefined || requiresFullProviderSwitchContext
                ? "full_thread_summary"
                : "delta_since_target_last_seen",
            items: providerSwitchItems,
            runs: projection.runs,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
  const legacyImportRecoveryHandoff =
    isProviderSwitch &&
    !canResumeAcrossInstances &&
    latestCompletedRun === undefined &&
    legacyImportItems.length > 0
      ? yield* deps.contextHandoffService
          .prepareLegacyImport({
            threadId: command.threadId,
            targetRunId: runId,
            toProviderThreadId: ensuredProviderThread.id,
            toProviderInstanceId: modelSelection.instanceId,
            items: legacyImportItems,
            createdAt: now,
          })
          .pipe(mapDispatchError(command))
      : null;
  const providerThread: OrchestrationV2ProviderThread = {
    ...ensuredProviderThread,
    status: "active",
    firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
    lastRunOrdinal: ordinal,
    handoffIds: [
      ...ensuredProviderThread.handoffIds,
      ...[
        portableForkHandoff,
        sideChatContextHandoff,
        providerSwitchHandoff,
        legacyImportRecoveryHandoff,
      ].flatMap((handoff) => (handoff === null ? [] : [handoff.id])),
    ],
    updatedAt: now,
  };

  const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
  const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
  const emitEvent = deps.emit(events, command);
  const mergeBackSourceProjection =
    pendingMergeBackTransfer === undefined
      ? null
      : yield* deps.projectionStore
          .getThreadRecords(pendingMergeBackTransfer.sourceThreadId, [
            "runs",
            "attempts",
            "providerThreads",
            "providerTurns",
          ])
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProjectionError({
                  threadId: pendingMergeBackTransfer.sourceThreadId,
                  cause,
                }),
            ),
          );
  const mergeBackSourceRun =
    pendingMergeBackTransfer?.sourcePoint.runId === undefined ||
    mergeBackSourceProjection === null
      ? null
      : (mergeBackSourceProjection.runs.find(
          (candidate) => candidate.id === pendingMergeBackTransfer.sourcePoint.runId,
        ) ?? null);
  if (pendingMergeBackTransfer !== undefined && mergeBackSourceRun === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source run.`,
    });
  }
  const mergeBackSourceProviderThread =
    mergeBackSourceProjection === null || mergeBackSourceRun === null
      ? undefined
      : providerThreadForRun(mergeBackSourceProjection, mergeBackSourceRun);
  if (pendingMergeBackTransfer !== undefined && mergeBackSourceProviderThread === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source provider thread.`,
    });
  }
  if (pendingMergeBackTransfer !== undefined) {
    yield* mapDispatchError(command)(
      deps.commandPolicy.ensureContextHandoff({
        commandId: command.commandId,
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities,
        strategy: "fork_delta_context",
      }),
    );
  }
  const mergeBackDeltaItems =
    mergeBackSourceProjection === null || mergeBackSourceRun === null
      ? []
      : visibleConversationItems(
          mergeBackSourceProjection,
          yield* deps.readHandoffItems(
            mergeBackSourceProjection.thread.id,
            mergeBackSourceProjection.runs
              .filter((run) => run.ordinal <= mergeBackSourceRun.ordinal)
              .map((run) => run.id),
          ),
        );
  const mergeBackHandoff =
    pendingMergeBackTransfer === undefined ||
    mergeBackSourceProjection === null ||
    mergeBackSourceRun === null ||
    mergeBackSourceProviderThread === undefined
      ? null
      : yield* deps.contextHandoffService
          .prepareForkDelta({
            sourceThreadId: pendingMergeBackTransfer.sourceThreadId,
            targetThreadId: command.threadId,
            targetRunId: runId,
            transferId: pendingMergeBackTransfer.id,
            fromProviderThreadIds: [mergeBackSourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: mergeBackSourceRun.providerInstanceId,
            toProviderInstanceId: modelSelection.instanceId,
            coveredRunOrdinals: visibleDeltaRunOrdinals(
              mergeBackSourceProjection,
              mergeBackDeltaItems,
            ),
            deltaItems: mergeBackDeltaItems,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
  const checkpointScope = yield* deps.checkpointService
    .prepareRootRunScope({
      threadId: command.threadId,
      runId,
      rootNodeId,
      providerThreadId: providerThread.id,
      cwd:
        resolvedRuntimePolicy.cwd ??
        existingProviderSession?.cwd ??
        projection.thread.worktreePath ??
        process.cwd(),
      createdAt: now,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: command.threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: providerThread.id,
    userMessageId: command.messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    queuePosition: null,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId:
      portableForkHandoff?.id ??
      providerSwitchHandoff?.id ??
      mergeBackHandoff?.id ??
      legacyImportRecoveryHandoff?.id ??
      null,
    ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
    ...(command.restartContinuationOfRunId === undefined
      ? {}
      : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
    ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
    ...wakeWorkStartedAt(projection.runs, command),
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    reason: "initial",
    status: "pending",
    startedAt: null,
    completedAt: null,
  };
  const rootNode: OrchestrationV2ExecutionNode = {
    id: rootNodeId,
    threadId: command.threadId,
    runId,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "pending",
    countsForRun: true,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: checkpointScope.id,
    startedAt: null,
    completedAt: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.scheduledTaskId === undefined
      ? {}
      : { scheduledTaskId: command.scheduledTaskId }),
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
    id: command.messageId,
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: dispatchText,
    ...(command.context ? { context: command.context } : {}),
    attachments: command.attachments,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
    ...(command.notification === undefined ? {} : { notification: command.notification }),
  };
  const turnItem: OrchestrationV2TurnItem = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.scheduledTaskId === undefined
      ? {}
      : { scheduledTaskId: command.scheduledTaskId }),
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
    id: deps.idAllocator.derive.userTurnItem({ messageId: command.messageId }),
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinal * 100,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message",
    messageId: command.messageId,
    inputIntent: "turn_start",
    text: dispatchText,
    ...(command.context ? { context: command.context } : {}),
    attachments: command.attachments,
    ...(run.contextHandoffId === null
      ? modelSwitchSince(
          projection,
          modelSelection,
          // Side chats do not show the parent's runs.
          sideChatFork ? undefined : sourceRun?.modelSelection,
        )
      : {}),
  };
  const activeHandoff = portableForkHandoff ?? mergeBackHandoff ?? providerSwitchHandoff;
  const handoffSourceRuns =
    portableForkHandoff !== null
      ? sourceRun === null
        ? []
        : [sourceRun]
      : providerSwitchHandoff === null
        ? mergeBackSourceRun === null
          ? []
          : [mergeBackSourceRun]
        : providerSwitchCoveredRuns;
  const handoffFromModelSelections = Array.from(
    new Map(
      handoffSourceRuns.map((run) => [
        `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
        run.modelSelection,
      ]),
    ).values(),
  );
  const handoffTurnItem: OrchestrationV2TurnItem | null =
    activeHandoff === null
      ? null
      : {
          id: deps.idAllocator.derive.runSignalTurnItem({
            runId,
            signal: `context-handoff:${activeHandoff.id}`,
          }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100 - 1,
          status: "completed",
          title:
            portableForkHandoff !== null
              ? "Fork context"
              : providerSwitchHandoff !== null
                ? "Provider handoff"
                : "Merge-back context",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "handoff",
          contextHandoffId: activeHandoff.id,
          fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
          toProviderThreadId: activeHandoff.toProviderThreadId,
          fromProviderInstanceIds: Array.from(
            new Set(handoffSourceRuns.map((run) => run.providerInstanceId)),
          ),
          toProviderInstanceId: modelSelection.instanceId,
          fromModelSelections: handoffFromModelSelections,
          toModel: modelSelection.model,
          strategy: activeHandoff.strategy,
          summary: activeHandoff.summaryText,
        };
  const nativeForkResolution: OrchestrationV2ContextTransferResolution | null =
    !canResolveForkNatively || providerThread.nativeThreadRef === null
      ? null
      : {
          strategy: "native_fork",
          providerThreadRef: providerThread.nativeThreadRef,
        };
  const portableForkContext =
    portableForkHandoff ?? (sideChatWithoutSource ? sideChatContextHandoff : null);
  const portableForkResolution: OrchestrationV2ContextTransferResolution | null =
    pendingForkTransfer === undefined || portableForkContext === null
      ? null
      : {
          strategy: "portable_context",
          contextHandoffId: portableForkContext.id,
        };
  const mergeBackResolution: OrchestrationV2ContextTransferResolution | null =
    pendingMergeBackTransfer === undefined || mergeBackHandoff === null
      ? null
      : {
          strategy: "fork_delta_context",
          contextHandoffId: mergeBackHandoff.id,
        };

  if (pendingForkTransfer !== undefined && canResolveForkNatively) {
    yield* emitEvent({
      type: "context-transfer.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...pendingForkTransfer,
        targetProviderInstanceId: modelSelection.instanceId,
        targetRunId: runId,
        status: "pending",
        resolution: null,
        error: null,
        updatedAt: now,
      },
    });
  }
  if (pendingForkTransfer !== undefined && portableForkResolution !== null) {
    yield* emitEvent({
      type: "context-transfer.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...pendingForkTransfer,
        targetProviderInstanceId: modelSelection.instanceId,
        targetRunId: runId,
        status: "resolved_portable",
        resolution: portableForkResolution,
        error: null,
        updatedAt: now,
      },
    });
  }
  yield* emitEvent({
    type: "provider-thread.updated",
    threadId: command.threadId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: providerThread,
  });
  if (portableForkHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: portableForkHandoff,
    });
  }
  if (sideChatContextHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: sideChatContextHandoff,
    });
  }
  if (legacyImportRecoveryHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: legacyImportRecoveryHandoff,
    });
  }
  if (
    providerSwitchTransferId !== null &&
    providerSwitchHandoff !== null &&
    latestHandoffRun !== undefined
  ) {
    const transfer: OrchestrationV2ContextTransfer = {
      id: providerSwitchTransferId,
      type: "provider_handoff",
      sourceThreadId: command.threadId,
      targetThreadId: command.threadId,
      sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
      basePoint:
        requiresFullProviderSwitchContext || targetLastCompletedRun === undefined
          ? null
          : contextSourcePointForRun(projection, targetLastCompletedRun),
      sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: runId,
      status: "consumed",
      resolution: {
        strategy:
          providerSwitchHandoff.strategy === "full_thread_summary"
            ? "portable_context"
            : "delta_context",
        contextHandoffId: providerSwitchHandoff.id,
      },
      createdBy: command.createdBy,
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
    };
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: transfer,
    });
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: providerSwitchHandoff,
    });
  }
  if (mergeBackHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: mergeBackHandoff,
    });
  }
  for (const supersededTransfer of supersededMergeBackTransfers) {
    yield* emitEvent({
      type: "context-transfer.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...supersededTransfer,
        status: "superseded",
        error:
          pendingMergeBackTransfer === undefined
            ? "Superseded while consuming merge-back transfer."
            : `Superseded by merge-back transfer ${pendingMergeBackTransfer.id}.`,
        updatedAt: now,
      },
    });
  }
  if (pendingMergeBackTransfer !== undefined && mergeBackResolution !== null) {
    yield* emitEvent({
      type: "context-transfer.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...pendingMergeBackTransfer,
        targetProviderInstanceId: modelSelection.instanceId,
        targetRunId: runId,
        status: "consumed",
        resolution: mergeBackResolution,
        error: null,
        updatedAt: now,
        consumedAt: now,
      },
    });
  }
  yield* emitEvent({
    type: "run.created",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: run,
  });
  yield* completeSourcePlan(now);
  yield* emitEvent({
    type: "run-attempt.created",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: attempt,
  });
  yield* emitEvent({
    type: "node.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: rootNode,
  });
  yield* emitEvent({
    type: "checkpoint-scope.created",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: checkpointScope,
  });
  if (handoffTurnItem !== null) {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: handoffTurnItem,
    });
  }
  yield* emitEvent({
    type: "message.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: message,
  });
  yield* emitEvent({
    type: "turn-item.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: notificationTurnItem(
      turnItem,
      message,
      yield* deps.notificationTasks(command.threadId, message, projection.subagents),
    ),
  });
  const forkResolution = nativeForkResolution ?? portableForkResolution;
  if (pendingForkTransfer !== undefined && forkResolution !== null) {
    yield* emitEvent({
      type: "context-transfer.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...pendingForkTransfer,
        targetProviderInstanceId: modelSelection.instanceId,
        targetRunId: runId,
        status: "consumed",
        resolution: forkResolution,
        error: null,
        updatedAt: now,
        consumedAt: now,
      },
    });
  }

  const detachDetail = canResumeAcrossInstances
    ? "Provider account changed; continuing the native thread."
    : "Provider or model selection changed.";
  for (const session of sessionsToDetach) {
    yield* emitEvent({
      type: "provider-session.detached",
      threadId: command.threadId,
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      occurredAt: now,
      payload: {
        providerSessionId: session.id,
        detachedAt: now,
        reason: detachDetail,
      },
    });
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-session.detach",
          providerSessionId: session.id,
          detail: detachDetail,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  }
  const pendingEffect = {
    id: `effect:${command.commandId}:provider-turn.start:${runId}`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: { type: "provider-turn.start", runId },
  } satisfies PendingOrchestrationEffectV2;
  yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
});

  return { dispatchMessage, dispatchThreadMutation };
};
