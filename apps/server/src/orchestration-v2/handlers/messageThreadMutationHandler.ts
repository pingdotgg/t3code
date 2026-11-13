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
import type { MakeMessageHandlersDeps } from "./messageHandlerDeps.ts";
import type { ThreadMutationCommand } from "./threadMutationProjection.ts";
import { applyThreadMutation } from "./threadMutationProjection.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.
export const makeDispatchThreadMutation = (deps: MakeMessageHandlersDeps) =>
Effect.fn("orchestrationV2.dispatch.threadMutation")(function* (
  command: ThreadMutationCommand,
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
  const updatedThread = applyThreadMutation({
    thread,
    command,
    now,
    snoozedUntil,
    markUnreadVisitedAt,
  });
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
