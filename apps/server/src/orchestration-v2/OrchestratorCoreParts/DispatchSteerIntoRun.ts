import { type ChatAttachment, type ModelSelection, OrchestrationV2Command, type OrchestrationV2ContextHandoff, type OrchestrationV2ContextTransfer, type OrchestrationV2ConversationMessage, type OrchestrationV2DomainEvent, type OrchestrationV2ExecutionNode, type OrchestrationV2ProviderThread, type OrchestrationV2ModelSwitch, type OrchestrationV2Run, type OrchestrationV2RunAttempt, type OrchestrationV2ThreadProjection, type OrchestrationV2TurnItem, parseGoalCommand, ProviderInstanceId, type ProviderSessionId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "../modelSwitch.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorDispatchError, OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { rootProviderThreadsForProvider } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart;

export const installDispatchSteerIntoRun = Effect.fnUntraced(function* (deps: Deps) {
  const { checkpointService, commandPolicy, contextHandoffService, emit, idAllocator, nextTurnItemOrdinal, notificationTasks, providerAdapters, providerSessionIdFor, providerSessions, providerSwitchService, readHandoffItems, runtimePolicy, stopReachedRun } = deps;

const dispatchSteerIntoRun = Effect.fn("Orchestrator.dispatchSteerIntoRun")(function* (input: {
  readonly command: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
  >;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    | "runs"
    | "messages"
    | "providerSessions"
    | "providerThreads"
    | "providerTurns"
    | "subagents"
    | "attempts"
    | "nodes"
    | "thread"
    | "turnItems"
  >;
  readonly modelSelection: ModelSelection;
  readonly targetRunId: OrchestrationV2Run["id"];
  readonly messageId: OrchestrationV2ConversationMessage["id"];
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly scheduledTaskId?: OrchestrationV2ConversationMessage["scheduledTaskId"];
  readonly senderThreadId?: OrchestrationV2ConversationMessage["senderThreadId"];
  readonly idleCompaction?: OrchestrationV2ConversationMessage["idleCompaction"];
  readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
  readonly notification?: OrchestrationV2ConversationMessage["notification"];
  readonly forceRestart: boolean;
}) {
  const targetRun = input.projection.runs.find((candidate) => candidate.id === input.targetRunId);
  if (targetRun === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Target run ${input.targetRunId} was not found.`,
    });
  }
  if (isNativeMaintenanceCommand(input)) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause:
        input.text.trim().toLowerCase() === "/compact"
          ? "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish."
          : "Signing out must run as a separate turn. Queue it or wait for the active turn to finish.",
    });
  }
  if (parseGoalCommand(input) !== null) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause:
        "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.",
    });
  }
  const targetMessage = input.projection.messages.find(
    (message) => message.id === targetRun.userMessageId,
  );
  if (targetMessage !== undefined && isNativeMaintenanceCommand(targetMessage)) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause:
        targetMessage.text.trim().toLowerCase() === "/compact"
          ? "Wait for context compaction to finish before steering the thread."
          : "Wait for sign-out to finish before steering the thread.",
    });
  }
  const rootNodeId = targetRun.rootNodeId;
  if (rootNodeId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Target run ${targetRun.id} has no root node.`,
    });
  }
  if (targetRun.status !== "running") {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Target run ${targetRun.id} is ${targetRun.status} and cannot be steered.`,
    });
  }
  // The run reads as running until its provider stops, but a steer accepted
  // after Stop never reaches the agent.
  if (yield* stopReachedRun(input.command, input.command.threadId, targetRun.id)) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Target run ${targetRun.id} is stopping and cannot be steered.`,
    });
  }
  const providerThread = input.projection.providerThreads.find(
    (candidate) => candidate.id === targetRun.providerThreadId,
  );
  if (providerThread === undefined || providerThread.providerSessionId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Provider thread ${targetRun.providerThreadId} has no active provider session for steering.`,
    });
  }
  const providerSessionId = providerThread.providerSessionId;
  const providerTurn = input.projection.providerTurns.find(
    (candidate) =>
      candidate.runAttemptId === targetRun.activeAttemptId && candidate.status === "running",
  );
  if (providerTurn === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `No running provider turn found for active run ${targetRun.id}.`,
    });
  }
  const sessionOption = yield* providerSessions.get(providerSessionId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause,
        }),
    ),
  );
  if (Option.isNone(sessionOption)) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Provider session ${providerThread.providerSessionId} is not active.`,
    });
  }

  const session = sessionOption.value;
  const now = yield* DateTime.now;
  const emitEvent = emit(input.events, input.command);
  const selectionChanged = !modelSelectionsEqual(targetRun.modelSelection, input.modelSelection);
  const providerInstanceChanged =
    targetRun.providerInstanceId !== input.modelSelection.instanceId;
  const selectionTransition =
    selectionChanged && !providerInstanceChanged
      ? yield* providerAdapters.get(targetRun.providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            adapter.planSelectionTransition({
              current: targetRun.modelSelection,
              target: input.modelSelection,
              sessionCapabilities: session.providerSession.capabilities,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                providerInstanceId: targetRun.providerInstanceId,
                cause,
              }),
          ),
        )
      : null;
  if (selectionTransition?.type === "reject") {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: selectionTransition.reason,
    });
  }
  const appendSteeringMessage = Effect.fn("Orchestrator.appendSteeringMessage")(
    function* (messageInput: {
      readonly runId: OrchestrationV2Run["id"];
      readonly nodeId: OrchestrationV2ExecutionNode["id"];
      readonly providerTurnId: typeof providerTurn.id | null;
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelSwitch?: OrchestrationV2ModelSwitch | undefined;
    }) {
      const message: OrchestrationV2ConversationMessage = {
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        ...(input.delegatedCompletion === undefined
          ? {}
          : { delegatedCompletion: input.delegatedCompletion }),
        ...(input.notification === undefined ? {} : { notification: input.notification }),
        ...(input.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.idleCompaction === undefined ? {} : { idleCompaction: input.idleCompaction }),
        id: input.messageId,
        threadId: input.command.threadId,
        runId: messageInput.runId,
        nodeId: messageInput.nodeId,
        role: "user",
        text: input.text,
        attachments: input.attachments,
        ...(input.context ? { context: input.context } : {}),
        streaming: false,
        createdAt: now,
        updatedAt: now,
      };
      const turnItem: OrchestrationV2TurnItem = {
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        ...(input.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.idleCompaction === undefined ? {} : { idleCompaction: input.idleCompaction }),
        id: idAllocator.derive.userTurnItem({ messageId: input.messageId }),
        threadId: input.command.threadId,
        runId: messageInput.runId,
        nodeId: messageInput.nodeId,
        providerThreadId: messageInput.providerThreadId,
        providerTurnId: messageInput.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(input.projection),
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: input.messageId,
        inputIntent:
          input.command.type === "queued-message.promote-to-steer"
            ? "promoted_queued_to_steer"
            : "steer",
        text: input.text,
        attachments: input.attachments,
        ...(input.context ? { context: input.context } : {}),
        ...(messageInput.modelSwitch === undefined
          ? {}
          : { modelSwitch: messageInput.modelSwitch }),
      };
      yield* emitEvent({
        type: "message.updated",
        threadId: input.command.threadId,
        runId: messageInput.runId,
        nodeId: messageInput.nodeId,
        providerInstanceId: messageInput.providerInstanceId,
        occurredAt: now,
        payload: message,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: input.command.threadId,
        runId: messageInput.runId,
        nodeId: messageInput.nodeId,
        providerInstanceId: messageInput.providerInstanceId,
        occurredAt: now,
        payload: notificationTurnItem(
          turnItem,
          message,
          yield* notificationTasks(input.command.threadId, message, input.projection.subagents),
        ),
      });
    },
  );

  // A selection the provider applies on its next turn joins the running
  // turn as a steer and waits for the next turn. Restarting the turn for it
  // would end the turn's native subagents, which a steer must never do.
  const selectionMustApplyNow =
    selectionChanged &&
    (providerInstanceChanged || selectionTransition?.type !== "apply_on_next_turn");
  const attachmentsNeedRestart =
    input.attachments.length > 0 &&
    session.providerSession.capabilities.turns.activeSteeringAcceptsAttachments === false;
  const steeringPolicy = yield* mapDispatchError(input.command)(
    commandPolicy.decideSteeringExecution({
      commandId: input.command.commandId,
      threadId: input.command.threadId,
      providerInstanceId: targetRun.providerInstanceId,
      capabilities: session.providerSession.capabilities,
      forceRestart: input.forceRestart || selectionMustApplyNow || attachmentsNeedRestart,
    }),
  );

  if (steeringPolicy === "active_steering") {
    const instanceChanged =
      input.projection.thread.providerInstanceId !== input.modelSelection.instanceId;
    if (
      input.delegatedCompletion === undefined &&
      input.notification === undefined &&
      (instanceChanged ||
        !modelSelectionsEqual(input.projection.thread.modelSelection, input.modelSelection))
    ) {
      yield* emitEvent({
        type: instanceChanged ? "thread.provider-switched" : "thread.model-selection-updated",
        threadId: input.command.threadId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: {
          ...input.projection.thread,
          providerInstanceId: input.modelSelection.instanceId,
          modelSelection: input.modelSelection,
          updatedAt: now,
        },
      });
    }
    yield* appendSteeringMessage({
      runId: targetRun.id,
      nodeId: rootNodeId,
      providerTurnId: providerTurn.id,
      providerThreadId: providerThread.id,
      providerInstanceId: targetRun.providerInstanceId,
    });
    yield* Ref.update(input.effects, (existing) => [
      ...existing,
      {
        id: `effect:${input.command.commandId}:provider-turn.steer:${providerTurn.id}`,
        commandId: input.command.commandId,
        threadId: input.command.threadId,
        request: {
          type: "provider-turn.steer",
          providerSessionId,
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
          messageId: input.messageId,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
    return;
  }

  const currentAttempt = input.projection.attempts.find(
    (candidate) => candidate.id === targetRun.activeAttemptId,
  );
  const currentRootNode = input.projection.nodes.find((candidate) => candidate.id === rootNodeId);
  const attemptOrdinal =
    Math.max(
      0,
      ...input.projection.attempts
        .filter((candidate) => candidate.runId === targetRun.id)
        .map((candidate) => candidate.attemptOrdinal),
    ) + 1;
  const nextAttemptId = idAllocator.derive.runAttempt({
    runId: targetRun.id,
    attemptOrdinal,
  });
  const nextRootNodeId = idAllocator.derive.rootNodeAttempt({
    runId: targetRun.id,
    attemptOrdinal,
  });
  let restartProviderThread = providerThread;
  let restartSessionTransition:
    | {
        readonly type: "replace";
        readonly replacementProviderSessionId: ProviderSessionId;
      }
    | { readonly type: "detach" }
    | null = null;
  let restartHandoff: OrchestrationV2ContextHandoff | null = null;
  let restartTransfer: OrchestrationV2ContextTransfer | null = null;
  const canResumeAcrossInstances =
    providerInstanceChanged &&
    providerThread.nativeThreadRef !== null &&
    (yield* providerSwitchService
      .plan({
        projection: {
          ...input.projection,
          thread: { ...input.projection.thread, modelSelection: targetRun.modelSelection },
        },
        targetModelSelection: input.modelSelection,
      })
      .pipe(mapDispatchError(input.command))).transition.type === "restart_and_resume";
  const requiresProviderThreadHandoff =
    (providerInstanceChanged && !canResumeAcrossInstances) ||
    selectionTransition?.type === "create_with_handoff";
  const requiresProviderSessionRestart =
    canResumeAcrossInstances || selectionTransition?.type === "restart_session";
  if (requiresProviderThreadHandoff) {
    const targetAdapter = yield* providerAdapters.get(input.modelSelection.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: input.command.commandId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          }),
      ),
    );
    const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProviderAdapterError({
            commandId: input.command.commandId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          }),
      ),
    );
    yield* mapDispatchError(input.command)(
      commandPolicy.ensureContextHandoff({
        commandId: input.command.commandId,
        threadId: input.command.threadId,
        providerInstanceId: input.modelSelection.instanceId,
        capabilities: targetCapabilities,
        strategy: "full_thread_summary",
      }),
    );
    const existingTargetProviderThread = rootProviderThreadsForProvider(
      input.projection,
      input.modelSelection.instanceId,
    ).find((candidate) => candidate.id !== providerThread.id);
    const targetProviderSessionId =
      existingTargetProviderThread?.providerSessionId ??
      (yield* mapDispatchError(input.command)(
        providerSessionIdFor({
          adapter: targetAdapter,
          providerInstanceId: input.modelSelection.instanceId,
          threadId: input.command.threadId,
        }),
      ));
    const targetProviderThreadBase: OrchestrationV2ProviderThread =
      existingTargetProviderThread === undefined
        ? {
            id: idAllocator.derive.providerThread({
              driver: targetAdapter.driver,
              nativeThreadId: `pending:${targetRun.id}:attempt:${attemptOrdinal}`,
            }),
            driver: targetAdapter.driver,
            providerInstanceId: input.modelSelection.instanceId,
            providerSessionId: targetProviderSessionId,
            appThreadId: input.command.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: targetRun.ordinal,
            lastRunOrdinal: targetRun.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }
        : {
            ...existingTargetProviderThread,
            providerSessionId: targetProviderSessionId,
            lastRunOrdinal: targetRun.ordinal,
            updatedAt: now,
          };
    const transferId = yield* mapDispatchError(input.command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: input.command.threadId,
        targetThreadId: input.command.threadId,
        type: "provider_handoff",
      }),
    );
    restartHandoff = yield* contextHandoffService
      .prepareProviderHandoff({
        threadId: input.command.threadId,
        targetRunId: targetRun.id,
        transferId,
        fromProviderThreadIds: [providerThread.id],
        toProviderThreadId: targetProviderThreadBase.id,
        fromProviderInstanceId: targetRun.providerInstanceId,
        toProviderInstanceId: input.modelSelection.instanceId,
        coveredRunOrdinals: { from: 1, to: targetRun.ordinal },
        strategy: "full_thread_summary",
        items: yield* readHandoffItems(input.command.threadId),
        runs: input.projection.runs,
        createdAt: now,
      })
      .pipe(mapDispatchError(input.command));
    restartProviderThread = {
      ...targetProviderThreadBase,
      handoffIds: Array.from(
        new Set([...targetProviderThreadBase.handoffIds, restartHandoff.id]),
      ),
    };
    restartTransfer = {
      id: transferId,
      type: "provider_handoff",
      sourceThreadId: input.command.threadId,
      targetThreadId: input.command.threadId,
      sourcePoint: contextSourcePointForRun(input.projection, targetRun),
      basePoint: null,
      sourceProviderInstanceId: targetRun.providerInstanceId,
      targetProviderInstanceId: input.modelSelection.instanceId,
      targetRunId: targetRun.id,
      status: "consumed",
      resolution: {
        strategy: "portable_context",
        contextHandoffId: restartHandoff.id,
      },
      createdBy: input.createdBy,
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
    };
    restartSessionTransition = { type: "detach" };
  } else if (requiresProviderSessionRestart) {
    const nextProviderSessionId = yield* mapDispatchError(input.command)(
      idAllocator.allocate.providerSession({
        providerInstanceId: input.modelSelection.instanceId,
        threadId: input.command.threadId,
      }),
    );
    restartProviderThread = {
      ...providerThread,
      providerInstanceId: input.modelSelection.instanceId,
      providerSessionId: nextProviderSessionId,
      status: "not_loaded",
      updatedAt: now,
    };
    restartSessionTransition = {
      type: "replace",
      replacementProviderSessionId: nextProviderSessionId,
    };
  }
  const resolvedRuntimePolicy = yield* runtimePolicy
    .resolve({ thread: input.projection.thread, modelSelection: input.modelSelection })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause,
          }),
      ),
    );
  const checkpointScope = yield* checkpointService
    .prepareRootRunScope({
      threadId: input.command.threadId,
      runId: targetRun.id,
      rootNodeId: nextRootNodeId,
      providerThreadId: restartProviderThread.id,
      cwd:
        resolvedRuntimePolicy.cwd ??
        input.projection.thread.worktreePath ??
        session.providerSession.cwd,
      createdAt: now,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: input.command.commandId,
            commandType: input.command.type,
            cause,
          }),
      ),
    );
  const restartedRun: OrchestrationV2Run = {
    ...targetRun,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    providerThreadId: restartProviderThread.id,
    rootNodeId: nextRootNodeId,
    activeAttemptId: nextAttemptId,
    userMessageId: input.messageId,
    status: "starting",
    contextHandoffId: restartHandoff?.id ?? targetRun.contextHandoffId,
  };
  const nextAttempt: OrchestrationV2RunAttempt = {
    id: nextAttemptId,
    runId: targetRun.id,
    attemptOrdinal,
    rootNodeId: nextRootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    providerThreadId: restartProviderThread.id,
    providerTurnId: null,
    reason: "steering_restart",
    status: "pending",
    startedAt: null,
    completedAt: null,
  };
  const nextRootNode: OrchestrationV2ExecutionNode = {
    id: nextRootNodeId,
    threadId: input.command.threadId,
    runId: targetRun.id,
    parentNodeId: null,
    rootNodeId: nextRootNodeId,
    kind: "root_turn",
    status: "pending",
    countsForRun: true,
    providerThreadId: restartProviderThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: checkpointScope.id,
    startedAt: null,
    completedAt: null,
  };
  if (currentAttempt !== undefined) {
    yield* emitEvent({
      type: "run-attempt.updated",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: rootNodeId,
      providerInstanceId: targetRun.providerInstanceId,
      occurredAt: now,
      payload: { ...currentAttempt, status: "superseded", completedAt: now },
    });
  }
  if (currentRootNode !== undefined) {
    yield* emitEvent({
      type: "node.updated",
      threadId: input.command.threadId,
      runId: targetRun.id,
      nodeId: rootNodeId,
      providerInstanceId: targetRun.providerInstanceId,
      occurredAt: now,
      payload: { ...currentRootNode, status: "interrupted", completedAt: now },
    });
  }
  if (selectionChanged) {
    yield* emitEvent({
      type: providerInstanceChanged
        ? "thread.provider-switched"
        : "thread.model-selection-updated",
      threadId: input.command.threadId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...input.projection.thread,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        updatedAt: now,
      },
    });
  }
  if (requiresProviderThreadHandoff || requiresProviderSessionRestart) {
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: input.command.threadId,
      driver: restartProviderThread.driver,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: restartProviderThread,
    });
  }
  if (restartHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: input.command.threadId,
      runId: targetRun.id,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: restartHandoff,
    });
  }
  if (restartTransfer !== null) {
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: input.command.threadId,
      runId: targetRun.id,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: now,
      payload: restartTransfer,
    });
  }
  yield* emitEvent({
    type: "run.updated",
    threadId: input.command.threadId,
    runId: targetRun.id,
    nodeId: nextRootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    occurredAt: now,
    payload: restartedRun,
  });
  yield* emitEvent({
    type: "run-attempt.created",
    threadId: input.command.threadId,
    runId: targetRun.id,
    nodeId: nextRootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    occurredAt: now,
    payload: nextAttempt,
  });
  yield* emitEvent({
    type: "node.updated",
    threadId: input.command.threadId,
    runId: targetRun.id,
    nodeId: nextRootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    occurredAt: now,
    payload: nextRootNode,
  });
  yield* emitEvent({
    type: "checkpoint-scope.created",
    threadId: input.command.threadId,
    runId: targetRun.id,
    nodeId: nextRootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    occurredAt: now,
    payload: checkpointScope,
  });
  yield* appendSteeringMessage({
    runId: targetRun.id,
    nodeId: nextRootNodeId,
    providerTurnId: null,
    providerThreadId: restartProviderThread.id,
    providerInstanceId: input.modelSelection.instanceId,
    // Measured on the pre-restart projection, so the rewritten run is not its own baseline.
    ...(restartHandoff === null ? modelSwitchSince(input.projection, input.modelSelection) : {}),
  });
  const interruptedAttemptId = targetRun.activeAttemptId;
  if (interruptedAttemptId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Active run ${targetRun.id} has no attempt to interrupt.`,
    });
  }
  yield* Ref.update(input.effects, (existing) => [
    ...existing,
    {
      id: `effect:${input.command.commandId}:provider-turn.restart:${providerTurn.id}`,
      commandId: input.command.commandId,
      threadId: input.command.threadId,
      request: {
        type: "provider-turn.restart",
        providerSessionId,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn.id,
        interruptedAttemptId,
        runId: targetRun.id,
        ...(restartSessionTransition === null
          ? {}
          : { sessionTransition: restartSessionTransition }),
      },
    } satisfies PendingOrchestrationEffectV2,
  ]);
});

  return { dispatchSteerIntoRun };
});

export type DispatchSteerIntoRunPart = ReturnType<typeof installDispatchSteerIntoRun> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchSteerIntoRun>;
