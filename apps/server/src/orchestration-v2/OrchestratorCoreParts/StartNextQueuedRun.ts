import { latestExecutedRun, latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { CommandId, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread, type OrchestrationV2Run, type OrchestrationV2TurnItem, isRuntimeModeAbove, resolveProviderInstanceEnabled, type ProviderSessionId, RunId, ThreadId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "../modelSwitch.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isActiveRun } from "../CommandPolicy.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { wakeWorkStartedAt, usageLimitHoldsQueue, contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { appendContextHandoffId, followsCurrentConversation, isHandoffSourceRun, lastDeliveredRunForProviderThread, nextQueuedRun, nextRunOrdinal, queuedRunModelSelection, rootProviderThreadsForProvider } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart;

export const installStartNextQueuedRun = Effect.fnUntraced(function* (deps: Deps) {
  const { checkpointService, commandPolicy, contextHandoffService, failQueuedRunStart, idAllocator, notificationTasks, projectionStore, providerAdapters, providerSessionIdFor, providerSwitchService, readCommandProjection, readHandoffItems, runtimeModeCeiling, runtimePolicy, serverSettings, sessionHasBackgroundWork, writeSystemEvents } = deps;

const startNextQueuedRun = Effect.fn("Orchestrator.startNextQueuedRun")(
  function* (
    threadId: ThreadId,
    options?: {
      readonly failedRunId?: RunId;
      readonly endedRunId?: RunId;
      readonly queuedRunId?: RunId;
    },
  ) {
    if (!(yield* projectionStore.canStartQueuedRun(threadId))) return;
    const projection = yield* readCommandProjection(threadId);
    if (
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.runs.some(isActiveRun)
    ) {
      return;
    }

    const storedQueuedRun =
      options?.queuedRunId === undefined
        ? nextQueuedRun(projection)
        : projection.runs.find(
            (run) => run.id === options.queuedRunId && run.status === "queued",
          );
    if (storedQueuedRun === undefined) {
      return;
    }
    const queuedMessage = projection.messages.find(
      (candidate) => candidate.id === storedQueuedRun.userMessageId,
    );
    const modelSelection = queuedRunModelSelection(projection, storedQueuedRun);
    const queuedRun = {
      ...storedQueuedRun,
      modelSelection,
      providerInstanceId: modelSelection.instanceId,
    };
    // A limited provider would fail and consume every waiting message.
    if (usageLimitHoldsQueue(projection, queuedRun.providerInstanceId)) {
      return;
    }
    // Waits without a hold: lowering the thread's mode starts the queue again.
    if (isRuntimeModeAbove(projection.thread.runtimeMode, runtimeModeCeiling?.maxRuntimeMode)) {
      return;
    }
    // Failed worktree creation would run queued work in the project checkout; wait for the user.
    const failedRun = latestExecutedRun(projection.runs);
    const failureClass =
      failedRun?.id === options?.failedRunId
        ? latestRootProviderFailure(failedRun, projection.turnItems)?.class
        : undefined;
    const worktreeMissing =
      failedRun?.id === options?.endedRunId &&
      failedRun?.workspacePreparation?.type === "worktree" &&
      projection.thread.worktreePath === null;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const projectOverride =
      settings.projectSettingsOverrides[projection.thread.projectId]?.providerInstances?.[
        queuedRun.providerInstanceId
      ]?.enabled;
    const machineInstance = Object.hasOwn(
      settings.providerInstances,
      queuedRun.providerInstanceId,
    )
      ? settings.providerInstances[queuedRun.providerInstanceId]
      : undefined;
    const instanceDisabledForProject =
      projectOverride !== undefined
        ? !projectOverride
        : machineInstance !== undefined && !resolveProviderInstanceEnabled(machineInstance);
    if (
      worktreeMissing ||
      instanceDisabledForProject ||
      (failureClass !== undefined &&
        failureClass !== "validation_error" &&
        failedRun?.providerInstanceId === queuedRun.providerInstanceId)
    ) {
      const now = yield* DateTime.now;
      yield* writeSystemEvents(
        projection.runs
          .filter((run) => run.status === "queued")
          .map((run) => ({
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, queueHeld: true },
          })),
      );
      return;
    }
    // Move queued ordinals after runs that started while they waited to preserve transcript and checkpoint order.
    // Started runs have prompts; cancelled queued messages do not.
    const newerRunIds = projection.runs
      .filter((run) => run.status !== "queued" && run.ordinal > queuedRun.ordinal)
      .map((run) => run.id);
    const startedAhead =
      newerRunIds.length > 0 &&
      (yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message", "notification"],
        turnItemRunIds: newerRunIds,
      })).turnItems.length > 0;
    const ordinal = startedAhead ? nextRunOrdinal(projection) : queuedRun.ordinal;
    const commandId = CommandId.make(`command:system:start-queued:${queuedRun.id}`);
    const rootNodeId = queuedRun.rootNodeId;
    const attemptId = queuedRun.activeAttemptId;
    const providerThreadId = queuedRun.providerThreadId;
    if (rootNodeId === null || attemptId === null || providerThreadId === null) {
      return yield* new OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: `Queued run ${queuedRun.id} is missing execution identity.`,
      });
    }

    const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
    const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
    const legacyQueuedTurnItem = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
        candidate.type === "user_message" &&
        candidate.runId === queuedRun.id &&
        candidate.messageId === queuedRun.userMessageId,
    );
    const storedProviderThread = projection.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    const storedCheckpointScope = projection.checkpointScopes.find(
      (scope) => scope.id === rootNode?.checkpointScopeId,
    );
    if (
      rootNode === undefined ||
      attempt === undefined ||
      queuedMessage === undefined ||
      storedProviderThread === undefined ||
      (rootNode.checkpointScopeId !== null && storedCheckpointScope === undefined)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: `Queued run ${queuedRun.id} is missing projection state.`,
      });
    }

    const now = yield* DateTime.now;
    const targetAdapter = yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId,
            commandType: "message.dispatch",
            cause,
          }),
      ),
    );
    const activeProviderThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    const followsCurrent = followsCurrentConversation(queuedMessage);
    const targetProviderThread = followsCurrent
      ? activeProviderThread?.providerInstanceId === queuedRun.providerInstanceId
        ? activeProviderThread
        : rootProviderThreadsForProvider(projection, queuedRun.providerInstanceId)[0]
      : storedProviderThread;
    const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
      id: idAllocator.derive.providerThread({
        driver: targetAdapter.driver,
        nativeThreadId: `pending:${queuedRun.id}`,
      }),
      driver: targetAdapter.driver,
      providerInstanceId: queuedRun.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
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
    const selectionChanged = !modelSelectionsEqual(
      projection.thread.modelSelection,
      queuedRun.modelSelection,
    );
    // The picker may already have moved ahead of the native conversation.
    const switchFromActiveProvider =
      followsCurrent &&
      activeProviderThread !== undefined &&
      activeProviderThread.providerInstanceId !== queuedRun.providerInstanceId;
    const switchPlan =
      selectionChanged || switchFromActiveProvider
        ? yield* providerSwitchService
            .plan({
              projection: switchFromActiveProvider
                ? {
                    ...projection,
                    thread: {
                      ...projection.thread,
                      modelSelection: {
                        ...projection.thread.modelSelection,
                        instanceId: activeProviderThread.providerInstanceId,
                      },
                    },
                  }
                : projection,
              targetModelSelection: queuedRun.modelSelection,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId,
                    commandType: "message.dispatch",
                    cause,
                  }),
              ),
            )
        : null;
    const releasableSessions = projection.providerSessions.filter(
      (session) =>
        switchPlan?.releaseProviderSessionIds.includes(session.id) &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
    const busySessionIds = new Set<ProviderSessionId>();
    for (const session of releasableSessions) {
      if (yield* sessionHasBackgroundWork(session, projection.providerThreads)) {
        busySessionIds.add(session.id);
      }
    }
    // Nobody waits on a queued start to refuse it. A handoff runs in its own session, so a
    // busy one stays up; a restart resumes the busy session's native thread, so wait instead.
    if (busySessionIds.size > 0 && switchPlan?.transition.type === "restart_and_resume") {
      yield* Effect.logInfo(
        "Holding the queue: the replaced provider session still runs background work",
        { threadId, runId: queuedRun.id, providerSessionIds: Array.from(busySessionIds) },
      );
      yield* writeSystemEvents(
        projection.runs
          .filter((run) => run.status === "queued")
          .map((run) => ({
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, queueHeld: true },
          })),
      );
      return;
    }
    const sessionsToDetach = releasableSessions.filter(
      (session) => !busySessionIds.has(session.id),
    );
    const canResumeAcrossInstances =
      switchPlan?.instanceChanged === true &&
      switchPlan.transition.type === "restart_and_resume" &&
      activeProviderThread !== undefined &&
      activeProviderThread.nativeThreadRef !== null;
    const deliveryProviderThread = canResumeAcrossInstances
      ? {
          ...queuedProviderThread,
          nativeThreadRef: activeProviderThread.nativeThreadRef,
          nativeConversationHeadRef: activeProviderThread.nativeConversationHeadRef,
          nativeMetadata: activeProviderThread.nativeMetadata,
        }
      : queuedProviderThread;
    const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId,
            commandType: "message.dispatch",
            cause,
          }),
      ),
    );
    const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
    const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
    const targetLastCompletedRun = lastDeliveredRunForProviderThread(
      projection,
      queuedProviderThread.id,
    );
    const coveredRuns =
      canResumeAcrossInstances ||
      latestHandoffRun === undefined ||
      latestHandoffRun.providerInstanceId === queuedRun.providerInstanceId
        ? []
        : projection.runs.filter(
            (run) =>
              isHandoffSourceRun(run) &&
              run.ordinal > (targetLastCompletedRun?.ordinal ?? 0) &&
              run.ordinal <= latestHandoffRun.ordinal,
          );
    const needsFullContext = deliveryProviderThread.nativeThreadRef === null;
    const legacyImportItems =
      projection.thread.historyOrigin === "v1_import"
        ? yield* readHandoffItems(threadId, [null])
        : [];
    const handoffStrategy = needsFullContext
      ? ("full_thread_summary" as const)
      : ("delta_since_target_last_seen" as const);
    const transferId =
      coveredRuns.length === 0
        ? null
        : yield* idAllocator.allocate
            .contextTransfer({
              sourceThreadId: threadId,
              targetThreadId: threadId,
              type: "provider_handoff",
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId,
                    commandType: "message.dispatch",
                    cause,
                  }),
              ),
            );
    if (transferId !== null) {
      yield* commandPolicy.ensureContextHandoff({
        commandId,
        threadId,
        providerInstanceId: queuedRun.providerInstanceId,
        capabilities: targetCapabilities,
        strategy: needsFullContext ? "full_thread_summary" : "delta_context",
      });
    }
    const handoff =
      transferId === null || latestHandoffRun === undefined
        ? null
        : yield* contextHandoffService
            .prepareProviderHandoff({
              threadId,
              targetRunId: queuedRun.id,
              transferId,
              fromProviderThreadIds: Array.from(
                new Set(
                  coveredRuns.flatMap((run) =>
                    run.providerThreadId === null ? [] : [run.providerThreadId],
                  ),
                ),
              ),
              toProviderThreadId: queuedProviderThread.id,
              fromProviderInstanceId: latestHandoffRun.providerInstanceId,
              toProviderInstanceId: queuedRun.providerInstanceId,
              coveredRunOrdinals: {
                from: coveredRuns[0]!.ordinal,
                to: coveredRuns.at(-1)!.ordinal,
              },
              runs: projection.runs,
              strategy: handoffStrategy,
              items: [
                ...(needsFullContext && latestCompletedRun !== undefined
                  ? legacyImportItems
                  : []),
                ...(yield* readHandoffItems(
                  threadId,
                  coveredRuns.map((run) => run.id),
                )),
              ],
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId,
                    commandType: "message.dispatch",
                    cause,
                  }),
              ),
            );
    const legacyImportRecoveryHandoff =
      latestCompletedRun === undefined && needsFullContext && legacyImportItems.length > 0
        ? yield* contextHandoffService
            .prepareLegacyImport({
              threadId,
              targetRunId: queuedRun.id,
              toProviderThreadId: queuedProviderThread.id,
              toProviderInstanceId: queuedRun.providerInstanceId,
              items: legacyImportItems,
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId,
                    commandType: "message.dispatch",
                    cause,
                  }),
              ),
            )
        : null;
    const activeHandoff = handoff ?? legacyImportRecoveryHandoff;
    const checkpointScope =
      storedCheckpointScope ??
      (yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection: queuedRun.modelSelection })
        .pipe(
          Effect.flatMap((resolvedRuntimePolicy) =>
            checkpointService.prepareRootRunScope({
              threadId,
              runId: queuedRun.id,
              rootNodeId: rootNode.id,
              providerThreadId: queuedProviderThread.id,
              cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
              createdAt: now,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId,
                commandType: "message.dispatch",
                cause,
              }),
          ),
        ));
    const providerSessionId =
      (!canResumeAcrossInstances &&
      queuedProviderThread.providerSessionId !== null &&
      !switchPlan?.releaseProviderSessionIds.includes(queuedProviderThread.providerSessionId)
        ? queuedProviderThread.providerSessionId
        : null) ??
      (yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
        Effect.flatMap((adapter) =>
          providerSessionIdFor({
            adapter,
            providerInstanceId: queuedRun.providerInstanceId,
            threadId,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      ));
    const providerThread: OrchestrationV2ProviderThread = {
      ...deliveryProviderThread,
      providerSessionId,
      status: "not_loaded",
      firstRunOrdinal: queuedProviderThread.firstRunOrdinal ?? ordinal,
      lastRunOrdinal: ordinal,
      handoffIds: appendContextHandoffId(
        appendContextHandoffId(queuedProviderThread.handoffIds, handoff?.id ?? null),
        legacyImportRecoveryHandoff?.id ?? null,
      ),
      updatedAt: now,
    };
    const startingRun: OrchestrationV2Run = {
      ...queuedRun,
      providerThreadId: queuedProviderThread.id,
      ordinal,
      status: "starting",
      queuePosition: null,
      startedAt: null,
      contextHandoffId: activeHandoff?.id ?? null,
      ...wakeWorkStartedAt(projection.runs, {
        notification: queuedMessage.notification,
        delegatedCompletion: queuedMessage.delegatedCompletion,
        restartContinuationOfRunId: queuedRun.restartContinuationOfRunId,
      }),
    };
    const userTurnItem: OrchestrationV2TurnItem = {
      ...(legacyQueuedTurnItem ?? {
        id: idAllocator.derive.userTurnItem({ messageId: queuedMessage.id }),
        threadId,
        runId: queuedRun.id,
        nodeId: rootNodeId,
        providerThreadId: queuedProviderThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal * 100,
        status: "completed",
        title: null,
        type: "user_message",
        messageId: queuedMessage.id,
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
        ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
        createdBy: queuedMessage.createdBy,
        creationSource: queuedMessage.creationSource,
        ...(queuedMessage.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: queuedMessage.scheduledTaskId }),
        ...(queuedMessage.senderThreadId === undefined
          ? {}
          : { senderThreadId: queuedMessage.senderThreadId }),
        ...(queuedMessage.idleCompaction === undefined
          ? {}
          : { idleCompaction: queuedMessage.idleCompaction }),
      }),
      providerThreadId: queuedProviderThread.id,
      inputIntent: "queued_turn",
      status: "completed",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      ...(activeHandoff === null ? modelSwitchSince(projection, queuedRun.modelSelection) : {}),
    };
    const handoffTurnItem: OrchestrationV2TurnItem | null =
      activeHandoff === null
        ? null
        : {
            id: idAllocator.derive.runSignalTurnItem({
              runId: queuedRun.id,
              signal: `context-handoff:${activeHandoff.id}`,
            }),
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerThreadId: queuedProviderThread.id,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 - 1,
            status: "completed",
            title: handoff === null ? "Imported context" : "Provider handoff",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "handoff",
            contextHandoffId: activeHandoff.id,
            fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
            toProviderThreadId: activeHandoff.toProviderThreadId,
            fromProviderInstanceIds: Array.from(
              new Set(coveredRuns.map((run) => run.providerInstanceId)),
            ),
            toProviderInstanceId: queuedRun.providerInstanceId,
            fromModelSelections: Array.from(
              new Map(
                coveredRuns.map((run) => [
                  `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
                  run.modelSelection,
                ]),
              ).values(),
            ),
            toModel: queuedRun.modelSelection.model,
            strategy: activeHandoff.strategy,
            summary: activeHandoff.summaryText,
          };
    const executionIdentityEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> =
      storedCheckpointScope === undefined ||
      storedProviderThread.id !== queuedProviderThread.id ||
      attempt.providerInstanceId !== queuedRun.providerInstanceId
        ? [
            {
              type: "checkpoint-scope.created",
              threadId,
              runId: queuedRun.id,
              nodeId: rootNodeId,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: { ...checkpointScope, providerThreadId: queuedProviderThread.id },
            },
            {
              type: "node.updated",
              threadId,
              runId: queuedRun.id,
              nodeId: rootNodeId,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: {
                ...rootNode,
                providerThreadId: queuedProviderThread.id,
                checkpointScopeId: checkpointScope.id,
              },
            },
            {
              type: "run-attempt.updated",
              threadId,
              runId: queuedRun.id,
              nodeId: rootNodeId,
              providerInstanceId: queuedRun.providerInstanceId,
              occurredAt: now,
              payload: {
                ...attempt,
                providerInstanceId: queuedRun.providerInstanceId,
                providerThreadId: queuedProviderThread.id,
              },
            },
          ]
        : [];
    yield* writeSystemEvents(
      [
        ...(selectionChanged
          ? [
              {
                type:
                  queuedRun.providerInstanceId === projection.thread.providerInstanceId
                    ? ("thread.model-selection-updated" as const)
                    : ("thread.provider-switched" as const),
                threadId,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...projection.thread,
                  providerInstanceId: queuedRun.providerInstanceId,
                  modelSelection: queuedRun.modelSelection,
                  updatedAt: now,
                },
              },
            ]
          : []),
        ...(handoff === null || transferId === null || latestHandoffRun === undefined
          ? []
          : [
              {
                type: "context-transfer.created" as const,
                threadId,
                runId: queuedRun.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: transferId,
                  type: "provider_handoff" as const,
                  sourceThreadId: threadId,
                  targetThreadId: threadId,
                  sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
                  basePoint:
                    needsFullContext || targetLastCompletedRun === undefined
                      ? null
                      : contextSourcePointForRun(projection, targetLastCompletedRun),
                  sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
                  targetProviderInstanceId: queuedRun.providerInstanceId,
                  targetRunId: queuedRun.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: needsFullContext
                      ? ("portable_context" as const)
                      : ("delta_context" as const),
                    contextHandoffId: handoff.id,
                  },
                  createdBy: queuedMessage.createdBy,
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
              {
                type: "context-handoff.updated" as const,
                threadId,
                runId: queuedRun.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: handoff,
              },
            ]),
        ...(legacyImportRecoveryHandoff === null
          ? []
          : [
              {
                type: "context-handoff.updated" as const,
                threadId,
                runId: queuedRun.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: legacyImportRecoveryHandoff,
              },
            ]),
        ...(handoffTurnItem === null
          ? []
          : [
              {
                type: "turn-item.updated" as const,
                threadId,
                runId: queuedRun.id,
                nodeId: rootNodeId,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: handoffTurnItem,
              },
            ]),
        ...sessionsToDetach.map((session) => ({
          type: "provider-session.detached" as const,
          threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: {
            providerSessionId: session.id,
            detachedAt: now,
            reason: "Provider or model selection changed.",
          },
        })),
        ...executionIdentityEvents,
        {
          type: "provider-thread.updated",
          threadId,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        },
        {
          type: "turn-item.updated",
          threadId,
          runId: queuedRun.id,
          nodeId: rootNodeId,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: notificationTurnItem(
            userTurnItem,
            queuedMessage,
            yield* notificationTasks(threadId, queuedMessage, projection.subagents),
          ),
        },
        {
          type: "run.updated",
          threadId,
          runId: queuedRun.id,
          nodeId: rootNodeId,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: startingRun,
        },
      ],
      [
        ...sessionsToDetach.map((session) => ({
          id: `effect:${commandId}:provider-session.detach:${session.id}`,
          commandId,
          threadId,
          request: {
            type: "provider-session.detach" as const,
            providerSessionId: session.id,
            detail: "Provider or model selection changed.",
          },
        })),
        {
          id: `effect:${commandId}:provider-turn.start:${queuedRun.id}`,
          commandId,
          threadId,
          request: { type: "provider-turn.start", runId: queuedRun.id },
        },
      ],
    );
  },
  (effect, threadId, options?) =>
    effect.pipe(
      Effect.catch((cause) => failQueuedRunStart(threadId, cause, options?.queuedRunId)),
    ),
);

  return { startNextQueuedRun };
});

export type StartNextQueuedRunPart = ReturnType<typeof installStartNextQueuedRun> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installStartNextQueuedRun>;
