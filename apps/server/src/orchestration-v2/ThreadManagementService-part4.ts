import {
  type ChatAttachment,
  CommandId,
  isListedThreadLineage,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  type ProviderSessionId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FORCE_STOP_REASON, FORCE_STOP_RELEASE_WAIT, SETTLE_AFTER_RUN_WAIT_MS, ThreadManagementBackgroundWaitError, ThreadManagementProjectionLoadError, ThreadManagementRunNotFoundError, ThreadManagementService, ThreadManagementThreadNotInterruptibleError, isActiveRun, isForceStopThreadError, isTerminalRunStatus, latestActiveRun, latestRestartContinuation, latestRun } from "./ThreadManagementService.ts";
import type { ThreadManagementProviderInstanceDisabledError, ThreadManagementServiceShape, ThreadManagementTerminalRunStatus } from "./ThreadManagementService.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";

import type { makeThreadManagementState } from "./ThreadManagementService-part3.ts";

type State = Effect.Success<ReturnType<typeof makeThreadManagementState>>;

export const makeThreadManagementFlows = Effect.fn("makeThreadManagementFlows")(function* (state: State) {
  const {
    threadDispatch,
    orchestrator,
    sessions,
    layerScope,
    agentScope,
    legacyImporter,
    serverSettings,
    receipts,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    ensureLegacyTranscript,
    ensureProjectionTranscript,
    ensureCommandTranscripts,
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    assertDispatchTargetEnabled,
    dispatch,
    getProjectThreadRecords,
    listProjectThreads,
    sendToThread,
  } = state;
  const waitForThread: ThreadManagementServiceShape["waitForThread"] = Effect.fn(
    "ThreadManagementService.waitForThread",
  )(function* (input) {
    const loadError = (cause: unknown) =>
      new ThreadManagementProjectionLoadError({
        projectId: input.projectId,
        threadId: input.threadId,
        cause,
      });
    // Taken before the first read, so a run update between that read and
    // the subscription below still replays.
    const afterSequence = yield* orchestrator
      .getThreadEventSequence(input.threadId)
      .pipe(Effect.mapError(loadError));
    const target = yield* getProjectThreadRecords(input, ["runs"]);
    const selectedRun =
      input.runId === undefined
        ? latestRun(target)
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && selectedRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (selectedRun === undefined) {
      return { threadId: input.threadId, run: null, timedOut: false };
    }
    // A restart cuts a run and continues it as a new run. Follow that chain,
    // so a cut run is not the answer while its continuation is pending.
    // Runs per matching event and is already covered by the waitForThread span.
    const outcome = Effect.fnUntraced(function* (runs: ReadonlyArray<OrchestrationV2Run>) {
      const current = runs.find((candidate) => candidate.id === selectedRun.id);
      if (current === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      }
      const run = latestRestartContinuation(runs, current);
      const pending =
        isTerminalRunStatus(run.status) && (yield* orchestrator.restartContinuationPending(run));
      return { run, pending, settled: isTerminalRunStatus(run.status) && !pending };
    });
    const untilDelegatedWorkSettled = input.untilDelegatedWorkSettled === true;
    const delegatedWorkResult = Effect.gen(function* () {
      const records = yield* getProjectThreadRecords(
        input,
        ["runs", "messages", "subagents", "providerThreads"],
        { messageRoles: ["user"], monitorNotificationsOnly: true },
      );
      const progress = delegatedTaskProgress(records);
      // A thread rolled back past all its work, with nothing left running, has no answer to wait for.
      if (
        progress.resultRun === undefined &&
        records.runs.every((run) => isTerminalRunStatus(run.status))
      ) {
        return latestRun(records);
      }
      if (progress.state !== "result_available") return undefined;
      const pending = yield* orchestrator
        .delegatedTaskResultPending(input.threadId)
        .pipe(Effect.mapError(loadError));
      return pending ? undefined : progress.resultRun;
    });
    const evaluate = Effect.fn("orchestrationV2.threadManagement.evaluate")(function* (
      runs: ReadonlyArray<OrchestrationV2Run>,
    ) {
      const current = yield* outcome(runs);
      if (!current.settled || !untilDelegatedWorkSettled) {
        return { ...current, resultRun: undefined };
      }
      const resultRun = yield* delegatedWorkResult;
      return { ...current, settled: resultRun !== undefined, resultRun };
    });
    const settledResult = (current: Effect.Success<ReturnType<typeof evaluate>>) => ({
      threadId: input.threadId,
      run: current.run,
      timedOut: !current.settled,
      ...(current.resultRun === undefined ? {} : { resultRun: current.resultRun }),
    });
    const initial = yield* evaluate(target.runs);
    if (initial.settled) return settledResult(initial);

    // A declined continuation records no event, so its effect settling wakes
    // the wait too.
    const wait = Stream.merge(
      Stream.mergeAll(
        (
          [
            "run.updated",
            "thread.deleted",
            // What delegated work reads besides runs: tasks and their
            // deliveries, and a provider thread's background tasks.
            ...(untilDelegatedWorkSettled
              ? (["subagent.updated", "provider-thread.updated"] as const)
              : []),
          ] as const
        ).map((eventType) =>
          orchestrator.streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            untilDelegatedWorkSettled ||
            stored.event.type !== "run.updated" ||
            stored.event.payload.id === selectedRun.id ||
            stored.event.payload.restartContinuationOfRunId !== undefined,
        ),
      ),
      initial.pending
        ? Stream.fromEffect(orchestrator.awaitRestartContinuation(initial.run))
        : Stream.empty,
    ).pipe(
      Stream.mapEffect(() =>
        getProjectThreadRecords(input, ["runs"]).pipe(
          Effect.flatMap((current) => evaluate(current.runs)),
        ),
      ),
      Stream.filter((current) => current.settled),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
    );
    const waited = Option.flatten(yield* wait);
    if (Option.isSome(waited)) return settledResult(waited.value);
    // The run may have reached a terminal status while the timeout was
    // winning the race; the final projection read decides what actually
    // happened, so only a still-active run counts as timed out.
    return settledResult(yield* evaluate((yield* getProjectThreadRecords(input, ["runs"])).runs));
  });

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    yield* dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`server:settle-after-run:${input.runId}`),
      threadId: input.threadId,
    });
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = Effect.fn(
    "ThreadManagementService.interruptThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    const explicitRun =
      input.runId === undefined
        ? undefined
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && explicitRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
      return {
        type: "already_terminal",
        run: explicitRun as OrchestrationV2Run & {
          readonly status: ThreadManagementTerminalRunStatus;
        },
      } as const;
    }
    const interruptibleRun = latestActiveRun(target);
    if (interruptibleRun === undefined) {
      if (input.runId === undefined) {
        return { type: "no_active_run" } as const;
      }
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    const dispatch = yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: interruptibleRun.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
  });

  const forceStopThread: ThreadManagementServiceShape["forceStopThread"] = Effect.fn(
    "ThreadManagementService.forceStopThread",
  )(
    function* (input) {
      // Under the thread lock no new run can be created between the check and the kill. The
      // settlement below dispatches, which takes that lock itself, so it runs after release.
      const { records, target, killed } = yield* threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const records = yield* orchestrator.getThreadRecords(input.threadId, [
            "runs",
            "providerThreads",
            "providerTurns",
          ]);
          // The run Force stop acts on: the active one, else the latest that started. Queued
          // follow-ups never ran, so they neither count as targets nor supersede the request.
          const target =
            latestActiveRun(records) ??
            records.runs
              .filter((run) => run.status !== "queued")
              .reduce<OrchestrationV2Run | undefined>(
                (current, run) =>
                  current === undefined || run.ordinal > current.ordinal ? run : current,
                undefined,
              );
          if (input.runId !== undefined && input.runId !== target?.id) {
            return yield* new OrchestrationV2ForceStopThreadError({
              threadId: input.threadId,
              reason: "superseded",
            });
          }
          // Shared scopes are never tracked per thread, so this only kills the thread's own agent.
          const killed = yield* agentScope.kill(input.threadId);
          return { records, target, killed };
        }),
      );
      const sessionIds = new Set(
        records.providerThreads.flatMap((providerThread) =>
          providerThread.appThreadId === input.threadId && providerThread.providerSessionId !== null
            ? [providerThread.providerSessionId]
            : [],
        ),
      );
      // A run that already ended may still hold background work; settling it is a no-op otherwise.
      const run = target;
      if (run !== undefined) {
        const active = isActiveRun(run);
        const providerTurn = records.providerTurns.findLast(
          (turn) =>
            turn.runAttemptId === run.activeAttemptId && (!active || turn.status === "running"),
        );
        const commandId = CommandId.make(
          `server:force-stop:${run.id}:${yield* Clock.currentTimeMillis}`,
        );
        yield* providerTurn === undefined && !active
          ? Effect.void
          : providerTurn === undefined
            ? orchestrator.dispatch({
                type: "run.interrupt",
                commandId,
                threadId: input.threadId,
                runId: run.id,
                reason: FORCE_STOP_REASON,
              })
            : orchestrator.dispatch({
                type: "thread.background-work.settle",
                commandId,
                threadId: input.threadId,
                providerThreadId: providerTurn.providerThreadId,
                providerTurnId: providerTurn.id,
                reason: FORCE_STOP_REASON,
              });
      }
      const ownProviderThreadIds = records.providerThreads.flatMap((providerThread) =>
        providerThread.appThreadId === input.threadId ? [providerThread.id] : [],
      );
      const detach = (providerSessionId: ProviderSessionId) =>
        sessions
          .detach({ providerSessionId, threadId: input.threadId, detail: FORCE_STOP_REASON })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.force-stop-detach-failed", {
                threadId: input.threadId,
                cause,
              }),
            ),
            Effect.forkIn(layerScope),
          );
      let shared = false;
      const sharedWith = new Set<ThreadId>();
      const releases: Array<{
        readonly providerSessionId: ProviderSessionId;
        readonly fiber: Fiber.Fiber<boolean, ProviderSessionManager.ProviderSessionManagerV2Error>;
      }> = [];
      for (const providerSessionId of sessionIds) {
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        // Decided just before teardown, so the reply matches what happens to the process.
        const others = yield* sessions.otherWorkingThreads({
          providerSessionId,
          threadId: input.threadId,
        });
        for (const threadId of others) sharedWith.add(threadId);
        if (others.length > 0) {
          shared = true;
          yield* detach(providerSessionId);
          continue;
        }
        // The session manager re-checks atomically with turn starts and keeps a session a
        // sibling began using in the meantime.
        const fiber = yield* sessions
          .releaseUnlessBusy({
            providerSessionId,
            ownProviderThreadIds,
            reason: "manual_shutdown",
            detail: FORCE_STOP_REASON,
          })
          .pipe(Effect.forkIn(layerScope));
        releases.push({ providerSessionId, fiber });
      }
      // Teardown waits on the provider's own exit paths; past this bound it keeps going on its own.
      let releasing = false;
      for (const release of releases) {
        const released = yield* Fiber.join(release.fiber).pipe(
          Effect.timeoutOption(FORCE_STOP_RELEASE_WAIT),
        );
        if (Option.isNone(released)) {
          releasing = true;
        } else if (!released.value) {
          shared = true;
          yield* detach(release.providerSessionId);
        }
      }
      return {
        outcome: killed ? "killed" : shared ? "shared" : releasing ? "releasing" : "released",
        sharedWithThreadIds: [...sharedWith],
      } as const;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isForceStopThreadError(cause)
            ? cause
            : new OrchestrationV2ForceStopThreadError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = Effect.fn(
    "ThreadManagementService.stopWorkflow",
  )(
    function* (input) {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // Check mode limits under the lock so users cannot raise modes between validation and Stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    },
    (effect, input) => effect.pipe((effect) => threadDispatch.withLock(input.threadId, effect)),
  );

  const awaitBackgroundTasks: ThreadManagementServiceShape["awaitBackgroundTasks"] = Effect.fn(
    "ThreadManagementService.awaitBackgroundTasks",
  )(function* (input) {
    const unavailable = (cause?: unknown) =>
      new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unavailable",
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId,
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* unavailable();
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime)) {
      return yield* unavailable();
    }
    if (runtime.value.awaitBackgroundTasks === undefined) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unsupported",
      });
    }
    const { matched } = yield* runtime.value
      .awaitBackgroundTasks({ providerThread, taskIds: input.taskIds, awaited: input.awaited })
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new ThreadManagementBackgroundWaitError({
              threadId: input.threadId,
              reason: "failed",
              cause,
            }),
        ),
      );
    const matchedIds = new Set(matched);
    return { matched, unmatched: input.taskIds.filter((taskId) => !matchedIds.has(taskId)) };
  });

  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
    > = [];
    const stoppedChildThreadIds = new Set<ThreadId>();
    for (const task of subagents) {
      if (task.origin !== "app_owned") continue;
      if (task.childThreadId === null) {
        // A task in a linked environment ends here; its follower then stops it there.
        // One with its result keeps it, but its thread there may run follow-up work.
        if (task.remoteChild === undefined) continue;
        const commandId = CommandId.make(`${input.commandId}:stop:${task.id}`);
        yield* dispatch(
          task.result === null
            ? {
                type: "delegated_task.remote.complete",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
                status: "interrupted",
                result:
                  input.reason === undefined
                    ? "Stopped with its parent."
                    : `Stopped with its parent: ${input.reason}`,
              }
            : {
                type: "delegated_task.remote.stop",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
              },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a delegated task", {
              parentThreadId: input.threadId,
              taskId: task.id,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
        continue;
      }
      const threadId = task.childThreadId;
      // Follow-up tasks reuse a child thread; walk its subtree only once.
      if (stoppedChildThreadIds.has(threadId)) continue;
      stoppedChildThreadIds.add(threadId);
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
        threadId,
        stopDelegatedTasks: false,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }).pipe(
        Effect.andThen(stopDelegatedTasks({ ...input, threadId })),
        Effect.catch((error) =>
          Effect.logWarning("Unable to stop a delegated task", {
            parentThreadId: input.threadId,
            threadId,
            error,
          }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
        ),
      );
    }
    if (failures[0] !== undefined) return yield* failures[0];
  });

  return {
    ensureLegacyTranscript,
    searchThreadStream: (input: Parameters<ThreadManagementServiceShape["searchThreadStream"]>[0]) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: Effect.fn("ThreadManagementService.searchThread")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      );
    }),
    dispatch,
    getThreadHistoryPage: Effect.fn("ThreadManagementService.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(
            orchestrator.getThreadHistoryPage(
              threadId,
              cursor,
              throughEntryId,
              conversationOnly,
              workMode,
            ),
          ),
        );
      },
    ),
    getTimelinePage: Effect.fn("ThreadManagementService.getTimelinePage")(
      function (threadId, options) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
        );
      },
    ),
    getMessageCount: Effect.fn("ThreadManagementService.getMessageCount")(function (threadId) {
      return ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      );
    }),
    getTurnItem: Effect.fn("ThreadManagementService.getTurnItem")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      );
    }),
    getThreadRecords: Effect.fn("ThreadManagementService.getThreadRecords")(
      function (threadId, fields, filter) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
        );
      },
    ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listActiveSubagentThreadIds: orchestrator.listActiveSubagentThreadIds,
    countThreads: orchestrator.countThreads,
    listActiveShellIndex: orchestrator.listActiveShellIndex,
    listOlderSettledThreads: orchestrator.listOlderSettledThreads,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    listAppOwnedChildThreadIds: Effect.fn("ThreadManagementService.listAppOwnedChildThreadIds")(
      function (threadId) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.listAppOwnedChildThreadIds(threadId)),
        );
      },
    ),
    listProjectThreads,
    sendToThread,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    waitForThread,
    settleAfterRun,
    settleThread,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    forceStopThread,
    awaitBackgroundTasks,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  };
});
