/**
 * Orchestrator message handlers: dispatchMessage, dispatchThreadMutation.
 *
 * The dispatch pipeline lives in the sibling messageXxx modules; every value it
 * needs is passed in explicitly.
 */
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { RunId } from "@t3tools/contracts";
import { applyToProjection } from "../ProjectionStore.ts";
import { cancelledBeforeStart } from "../RestartBackgroundNote.ts";
import { continuationFailedBeforePrompt } from "../RestartBackgroundNote.ts";
import { delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { goalCommandStopsActiveRun } from "../CommandPolicy.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { isRestartContinuationSource } from "../RestartBackgroundNote.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { latestProviderTurnForAttempt } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { parseGoalCommand } from "@t3tools/contracts";
import { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadShellFromProjection } from "../ProjectionStore.ts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { isLiveRun } from "../Orchestrator.ts";
import { isHandoffSourceRun } from "../Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { MakeMessageHandlersDeps } from "./messageHandlerDeps.ts";
import { makeDispatchThreadMutation } from "./messageThreadMutationHandler.ts";
import { queueMessageRun } from "./messageQueueRun.ts";
import type { MessageDispatchInput, MessageRunIdentity } from "./messageDispatchTypes.ts";
import { startFreshRun } from "./messageFreshRunStart.ts";
import { resolveRunHandoff } from "./messageRunHandoff.ts";
import { prepareProviderThread } from "./messageProviderThread.ts";
import { materializeRun } from "./messageMaterializeRun.ts";
import { latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, worktreeSetupPending } from "../Orchestrator.ts";


export type { MakeMessageHandlersDeps };

export const makeMessageHandlers = (deps: MakeMessageHandlersDeps) => {
const dispatchThreadMutation = makeDispatchThreadMutation(deps);

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
  const dispatchInput: MessageDispatchInput = {
    projection,
    modelSelection,
    dispatchMode,
    dispatchText,
    delegatedCompletion,
    continuedTaskId,
    completeSourcePlan,
    goalStopRunId,
    shouldQueue,
    queueBehindRun,
    worktreeMissingRun,
    activeRun,
    activeProviderThread,
    heldRunsToRelease,
    pendingMergeBackTransfers,
    worktreeSetupUnresolved,
  };
  if (shouldQueue && queueBehindRun !== undefined) {
    yield* queueMessageRun({
      deps,
      command,
      events,
      effects,
      input: { ...dispatchInput, queueBehindRun },
    });
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

  const runIdentity: MessageRunIdentity = {
    runId,
    ordinal,
    now,
    isProviderSwitch,
    latestCompletedRun,
    latestHandoffRun,
    legacyImportItems,
    pendingForkTransfer,
    pendingMergeBackTransfer,
    supersededMergeBackTransfers,
    providerSwitchPlan,
    canResumeAcrossInstances,
    sessionsToDetach,
  };
  if (
    pendingForkTransfer === undefined &&
    pendingMergeBackTransfer === undefined &&
    !isProviderSwitch
  ) {
    yield* startFreshRun({
      deps,
      command,
      events,
      effects,
      input: { ...dispatchInput, ...runIdentity },
    });
    return;
  }
  const runHandoff = yield* resolveRunHandoff({
    deps,
    command,
    events,
    effects,
    input: { ...dispatchInput, ...runIdentity },
  });
  const {
    canResolveForkNatively,
    capabilities,
    ensuredProviderThread,
    existingProviderSession,
    legacyImportRecoveryHandoff,
    portableForkHandoff,
    providerSessionId,
    providerSwitchCoveredRuns,
    providerSwitchHandoff,
    providerSwitchTransferId,
    requiresFullProviderSwitchContext,
    resolvedRuntimePolicy,
    sideChatContextHandoff,
    sideChatFork,
    sideChatWithoutSource,
    sourceRun,
    targetLastCompletedRun,
  } = runHandoff;
  const handoffState = { ...dispatchInput, ...runIdentity, ...runHandoff };
  const providerThreadState = yield* prepareProviderThread({
    deps,
    command,
    events,
    effects,
    input: handoffState,
  });
  const {
    attemptId,
    checkpointScope,
    emitEvent,
    mergeBackHandoff,
    mergeBackSourceRun,
    providerThread,
    rootNodeId,
  } = providerThreadState;
  yield* materializeRun({
    deps,
    command,
    events,
    effects,
    input: { ...dispatchInput, ...runIdentity, ...runHandoff, ...providerThreadState },
  });
});

  return { dispatchMessage, dispatchThreadMutation };
};
