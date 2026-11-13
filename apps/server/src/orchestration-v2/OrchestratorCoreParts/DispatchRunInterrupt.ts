import { latestExecutedRun, latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread, type OrchestrationV2ThreadProjection, type OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { derivePendingBackgroundWork, pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { isBufferedProviderNotification } from "../NotificationMailbox.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { makeQueueHandlers } from "../handlers/queueHandlers.ts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestrationMessages.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import * as RunExecutionService from "../RunExecutionService.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError, OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { withPullRequestWatch } from "../orchestrationCommandQueries.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart;

export const installDispatchRunInterrupt = Effect.fnUntraced(function* (deps: Deps) {
  const { awaitsRestartContinuation, checkpointService, closePendingLinkRequests, commandPolicy, dispatchSteerIntoRun, disposeDelegatedCompletionCohort, emit, emitRemoteStopOwed, ensureGoalCommandSupported, getProjectionWithPendingEvents, goalDriverFor, idAllocator, loadProjectionForCommand, markStoppedRun, nextTurnItemOrdinal, planDelegatedCompletionDelivery, preparedRunState, projectionStore, providerSessions, runtimePolicy, settleBackgroundWork, settleInterruptedRun, stopReachedRun } = deps;

const holdStoppedThread = Effect.fn("Orchestrator.holdStoppedThread")(function* (input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.stop" }
  >;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents">;
  readonly cohortRunIds: ReadonlyArray<RunId>;
  readonly now: DateTime.Utc;
}) {
  const emitEvent = emit(input.events, input.command);
  const { runs, subagents } = input.projection;
  let { thread } = input.projection;
  let recovery = thread.limitRecovery;
  const latest = latestExecutedRun(runs);
  if (latest?.status === "failed") {
    const { turnItems } = yield* projectionStore
      .getThreadRecords(thread.id, ["turnItems"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [latest.id],
      })
      .pipe(mapDispatchError(input.command));
    const failure = latestRootProviderFailure(latest, turnItems);
    if (
      failure?.class === "usage_limit" &&
      failure.resetAt != null &&
      Number.isFinite(Date.parse(failure.resetAt)) &&
      (recovery?.runId !== latest.id || recovery.resetAt !== failure.resetAt)
    ) {
      recovery = {
        runId: latest.id,
        resetAt: failure.resetAt,
        autoResume: false,
        snooze: false,
      };
    }
  }
  if (recovery && (recovery !== thread.limitRecovery || recovery.autoResume)) {
    thread = {
      ...thread,
      limitRecovery: {
        ...recovery,
        autoResume: false,
        requestId: input.command.commandId,
      },
      updatedAt: input.now,
    };
    yield* emitEvent({
      type: "thread.metadata-updated",
      threadId: thread.id,
      occurredAt: input.now,
      payload: thread,
    });
  }
  const queuedRuns = runs.filter((run) => run.status === "queued");
  const queuedMessages =
    queuedRuns.length === 0
      ? []
      : (yield* projectionStore
          .getThreadRecords(thread.id, ["messages"], {
            messageIds: queuedRuns.map((run) => run.userMessageId),
          })
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: thread.id, cause }),
            ),
          )).messages;
  const bufferedMessageIds = new Set(
    queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
  );
  for (const run of runs) {
    // A resumed queue can have a lower ordinal than a pending continuation source.
    // Stop must reach those sources even when interrupting the resumed run succeeds.
    if (
      (run.status === "cancelled" ||
        (run.status === "failed" && run.restartContinuationOfRunId !== undefined)) &&
      (yield* awaitsRestartContinuation(run).pipe(mapDispatchError(input.command)))
    ) {
      yield* markStoppedRun({ ...input, thread, run });
    }
    if (run.status !== "queued") continue;
    if (bufferedMessageIds.has(run.userMessageId)) {
      yield* dispatchQueuedRunCancel(
        {
          type: "queued-run.cancel",
          commandId: input.command.commandId,
          threadId: thread.id,
          runId: run.id,
        },
        input.events,
      );
      continue;
    }
    if (run.queueHeld === true) continue;
    yield* emitEvent({
      type: "run.updated",
      threadId: thread.id,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: input.now,
      payload: { ...run, queueHeld: true },
    });
  }
  const pullRequests = thread.pullRequests ?? [];
  if (pullRequests.some((link) => link.watch !== undefined)) {
    yield* emitEvent({
      type: "thread.pull-request-synced",
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...thread,
        pullRequests: pullRequests.map((link) => withPullRequestWatch(link, undefined)),
      },
    });
  }
  const cohortRunIds = new Set(input.cohortRunIds);
  for (const run of runs) {
    if (run.delegatedCompletion?.delivery != null) cohortRunIds.add(run.id);
  }
  for (const task of subagents) {
    const delivery = task.completionDelivery?.state;
    if (
      task.origin === "app_owned" &&
      task.runId !== null &&
      delivery !== "acknowledged" &&
      delivery !== "delivered" &&
      delivery !== "disposed"
    ) {
      cohortRunIds.add(task.runId);
    }
  }
  // Each disposal reads the events the ones before it wrote.
  for (const parentRunId of cohortRunIds) {
    yield* disposeDelegatedCompletionCohort({
      command: input.command,
      events: input.events,
      projection: yield* getProjectionWithPendingEvents(thread.id, input.events),
      parentRunId,
      disposition: "stopped",
      now: input.now,
    });
  }
  yield* closePendingLinkRequests({ ...input, threadId: thread.id });
});

const dispatchRunInterrupt = Effect.fn("Orchestrator.dispatchRunInterrupt")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const projection = yield* loadProjectionForCommand(
    command,
    [
      "runs",
      "nodes",
      "providerThreads",
      "providerTurns",
      "messages",
      "attempts",
      "turnItems",
      "subagents",
      "runtimeRequests",
    ],
    // Thread-wide, like the Waiting strip: a settled thread's background
    // work can belong to an earlier run than the one Stop targets.
    {
      turnItemTypes: [
        "command_execution",
        "dynamic_tool",
        "subagent",
        "assistant_message",
        "reasoning",
      ],
      turnItemStatuses: ["pending", "running", "waiting"],
    },
  );
  const run = projection.runs.find((candidate) => candidate.id === command.runId);
  const rootNode =
    run?.rootNodeId === null
      ? undefined
      : projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
  const providerThread =
    run?.providerThreadId === null
      ? undefined
      : projection.providerThreads.find((candidate) => candidate.id === run?.providerThreadId);
  const hasBackgroundWork =
    run?.id === projection.runs.findLast((candidate) => candidate.status !== "queued")?.id &&
    derivePendingBackgroundWork({
      latestRun: run,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
    }).length > 0;
  // A failed start has no provider turn. Background work still belongs
  // to the provider thread, so Stop reaches its latest accepted turn.
  const providerTurn =
    projection.providerTurns.findLast(
      (candidate) =>
        candidate.runAttemptId === run?.activeAttemptId &&
        (run?.status === "running" || candidate.status === "running" || hasBackgroundWork),
    ) ??
    (hasBackgroundWork
      ? projection.providerTurns.findLast(
          (candidate) => candidate.providerThreadId === run?.providerThreadId,
        )
      : undefined);
  if (run === undefined || rootNode === undefined || providerThread === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not interruptible.`,
    });
  }
  const now = yield* DateTime.now;
  const completionMessage = projection.messages.find(
    (candidate) => candidate.id === run.userMessageId,
  );
  const completionCohortRunId = completionMessage?.delegatedCompletion?.parentRunId ?? run.id;
  const stopRemainingWork = () =>
    command.holdQueue === true
      ? holdStoppedThread({
          command,
          events,
          projection,
          cohortRunIds: [completionCohortRunId],
          now,
        })
      : Effect.gen(function* () {
          for (const parentRunId of new Set([completionCohortRunId, run.id])) {
            yield* disposeDelegatedCompletionCohort({
              command,
              events,
              projection: yield* getProjectionWithPendingEvents(command.threadId, events),
              parentRunId,
              disposition: "stopped",
              now,
            });
          }
        });

  const emitEvent = emit(events, command);
  const interruptRequestItem: OrchestrationV2TurnItem = {
    id: idAllocator.derive.runSignalTurnItem({
      runId: run.id,
      signal: "interrupt-request",
    }),
    threadId: command.threadId,
    runId: run.id,
    nodeId: rootNode.id,
    providerThreadId: providerThread.id,
    providerTurnId: providerTurn?.id ?? null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: yield* nextTurnItemOrdinal(projection),
    status: "completed",
    title: "Interrupt requested",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "run_interrupt_request",
    message: command.reason ?? RunExecutionService.USER_STOP_REASON,
  };

  const otherProviderInterrupts: Array<PendingOrchestrationEffectV2> = [];
  if (hasBackgroundWork || command.holdQueue === true) {
    const runOrdinals = new Map(
      projection.runs.map((candidate) => [candidate.id, candidate.ordinal]),
    );
    const runOrdinalOf = (item: (typeof projection.turnItems)[number]) =>
      item.runId === null ? -1 : (runOrdinals.get(item.runId) ?? -1);
    // Interrupt each provider thread at its latest pending turn so settlement covers all its work.
    // Use the item's provider turn: native subagent items name the child thread but the parent turn,
    // and interrupting the parent turn reaches the subagent.
    const latestTurnByProviderThread = new Map<
      OrchestrationV2ProviderThread["id"],
      { readonly turn: (typeof projection.providerTurns)[number]; readonly runOrdinal: number }
    >();
    for (const item of pendingBackgroundTurnItems({
      turnItems: projection.turnItems,
      runs: projection.runs,
    })) {
      const turn = projection.providerTurns.find(
        (candidate) => candidate.id === item.providerTurnId,
      );
      if (turn === undefined || turn.providerThreadId === providerThread.id) continue;
      const runOrdinal = runOrdinalOf(item);
      const latest = latestTurnByProviderThread.get(turn.providerThreadId);
      if (latest === undefined || runOrdinal > latest.runOrdinal) {
        latestTurnByProviderThread.set(turn.providerThreadId, { turn, runOrdinal });
      }
    }
    for (const { turn } of latestTurnByProviderThread.values()) {
      const owner = projection.providerThreads.find(
        (candidate) => candidate.id === turn.providerThreadId,
      );
      if (owner === undefined || owner.providerSessionId === null) continue;
      const ownerSession = yield* providerSessions
        .get(owner.providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(ownerSession)) continue;
      otherProviderInterrupts.push({
        id: `effect:${command.commandId}:provider-turn.interrupt:${turn.id}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: owner.providerSessionId,
          providerThreadId: owner.id,
          providerTurnId: turn.id,
        },
      });
    }
  }

  if (
    providerTurn === undefined &&
    (run.status === "preparing" || run.status === "starting" || run.status === "running")
  ) {
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (attempt === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Run ${command.runId} has no active attempt to interrupt.`,
      });
    }
    const interruptResultItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.runSignalTurnItem({
        runId: run.id,
        signal: "interrupt-result",
      }),
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: interruptRequestItem.id,
      ordinal: interruptRequestItem.ordinal + 1,
      status: "interrupted",
      title: "Interrupted",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "run_interrupt_result",
      message: "Run interrupted before provider start",
    };
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: interruptRequestItem,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: interruptResultItem,
    });
    const preparationItem = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
        candidate.runId === run.id &&
        candidate.type === "command_execution" &&
        candidate.input === WORKSPACE_PREPARATION_INPUT &&
        candidate.status === "running",
    );
    if (preparationItem !== undefined) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...preparationItem,
          status: "interrupted",
          title: "Workspace preparation interrupted",
          output: command.reason ?? "Interrupted before provider start",
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "run-attempt.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...attempt, status: "interrupted", completedAt: now },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...rootNode, status: "interrupted", completedAt: now },
    });
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    // Stop cancels a pending restart, so it must end the turn that restart could not stop.
    const supersededTurn = projection.providerTurns.findLast(
      (candidate) =>
        candidate.status === "running" &&
        projection.attempts.some(
          (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
        ),
    );
    const supersededOwner =
      supersededTurn === undefined
        ? undefined
        : projection.providerThreads.find(
            (candidate) => candidate.id === supersededTurn.providerThreadId,
          );
    if (
      supersededTurn !== undefined &&
      supersededOwner !== undefined &&
      supersededOwner.providerSessionId !== null &&
      Option.isSome(
        yield* providerSessions
          .get(supersededOwner.providerSessionId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      )
    ) {
      const id = `effect:${command.commandId}:provider-turn.interrupt:${supersededTurn.id}`;
      if (!otherProviderInterrupts.some((effect) => effect.id === id)) {
        otherProviderInterrupts.push({
          id,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: supersededOwner.providerSessionId,
            providerThreadId: supersededOwner.id,
            providerTurnId: supersededTurn.id,
          },
        });
      }
    }
    yield* stopRemainingWork();
    yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
    return {
      effectTypes: ["provider-turn.start", "provider-turn.restart"],
      reason: `Run ${run.id} was interrupted before its provider turn started.`,
    } satisfies {
      readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }

  if (providerTurn === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not interruptible.`,
    });
  }
  const sessionOption =
    providerThread.providerSessionId === null
      ? Option.none()
      : yield* providerSessions.get(providerThread.providerSessionId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                providerInstanceId: run.providerInstanceId,
                cause,
              }),
          ),
        );
  if (Option.isNone(sessionOption)) {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: interruptRequestItem,
    });
    yield* stopRemainingWork();
    yield* settleInterruptedRun({ command, projection, providerTurn, events, effects, now });
    yield* settleBackgroundWork({
      command,
      events,
      projection,
      stoppedProviderThreadId: providerThread.id,
      throughRunOrdinal: run.ordinal,
      now,
    });
    yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
    return undefined;
  }
  if (providerThread.providerSessionId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Provider thread ${providerThread.id} has no active provider session.`,
    });
  }
  const providerSessionId = providerThread.providerSessionId;
  yield* mapDispatchError(command)(
    commandPolicy.ensureInterrupt({
      commandId: command.commandId,
      threadId: command.threadId,
      providerInstanceId: run.providerInstanceId,
      capabilities: sessionOption.value.providerSession.capabilities,
    }),
  );

  yield* emitEvent({
    type: "turn-item.updated",
    threadId: command.threadId,
    runId: run.id,
    nodeId: rootNode.id,
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: interruptRequestItem,
  });
  yield* stopRemainingWork();
  yield* Ref.update(effects, (existing) => [
    ...existing,
    {
      id: `effect:${command.commandId}:provider-turn.interrupt:${providerTurn.id}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "provider-turn.interrupt",
        providerSessionId,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn.id,
      },
    } satisfies PendingOrchestrationEffectV2,
    ...otherProviderInterrupts,
  ]);
  return undefined;
});

const stopRunForQueuedCommand = Effect.fn("Orchestrator.stopRunForQueuedCommand")(
  function* (input: {
    readonly command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
    readonly queuedRunId: RunId;
    readonly targetRunId: RunId | undefined;
    readonly reason: string;
    readonly now: DateTime.Utc;
  }) {
    const { command, events, effects, projection, now, targetRunId } = input;
    const others = queuedRunsInDeliveryOrder(projection).filter(
      (run) => run.id !== input.queuedRunId && !isAutomaticCompletionRun(projection, run),
    );
    for (const [index, run] of others.entries()) {
      const queuePosition = index + 2;
      if (run.queuePosition === queuePosition) continue;
      yield* emit(
        events,
        command,
      )({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queuePosition },
      });
    }
    if (targetRunId === undefined) return undefined;
    const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    const interrupted = yield* Effect.exit(
      dispatchRunInterrupt(
        {
          type: "run.interrupt",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: targetRunId,
          reason: input.reason,
        },
        interruptEvents,
        interruptEffects,
      ),
    );
    // A failed interrupt may have written part of its events, so they are kept apart.
    // The queued command then waits for the turn to end.
    if (Exit.isFailure(interrupted)) {
      yield* Effect.logWarning("queued command could not stop the running turn", {
        threadId: command.threadId,
        runId: targetRunId,
        cause: interrupted.cause,
      });
      return undefined;
    }
    const written = yield* Ref.get(interruptEvents);
    const enqueued = yield* Ref.get(interruptEffects);
    yield* Ref.update(events, (existing) => [...existing, ...written]);
    yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
    // Like Stop: a run stopped before its provider started also abandons that start.
    return interrupted.value;
  },
);

const { dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy } = makeQueueHandlers({
  projectionStore,
  loadProjectionForCommand,
  idAllocator,
  nextTurnItemOrdinal,
  checkpointService,
  runtimePolicy,
  preparedRunState,
  goalDriverFor,
  ensureGoalCommandSupported,
  disposeDelegatedCompletionCohort,
  emitRemoteStopOwed,
  planDelegatedCompletionDelivery,
  stopReachedRun,
  stopRunForQueuedCommand,
  dispatchSteerIntoRun,
  emit,
});

  return { holdStoppedThread, dispatchRunInterrupt, stopRunForQueuedCommand, dispatchQueuedRunEdit, dispatchQueuedRunCancel, dispatchPreparedRunProgress, dispatchPreparedRunRetry, dispatchPreparedRunRelease, dispatchPreparedRunFail, dispatchQueuedMessagePromoteToSteer, dispatchRuntimeRequestDeliveryFail, dispatchSecretRequestRecord, dispatchRemoteDelegatedTaskStop, dispatchDelegatedTaskWakePolicy };
});

export type DispatchRunInterruptPart = ReturnType<typeof installDispatchRunInterrupt> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchRunInterrupt>;
