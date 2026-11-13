// @effect-diagnostics anyUnknownInErrorContext:off
import {
  CommandId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  isOrchestrationV2WorkActive,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
  threadLinkFor,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import {
  interactionModeRank,
  resolveInteractionMode,
  resolveRuntimeMode,
  runtimeModeRank,
  taskPrompt,
} from "./delegatedTaskModes.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import { pageIncludesTerminalTaskResult, threadDetail, timelineItem } from "./mcpSupport1.ts";
import type { OrchestratorMcpServiceShape } from "./mcpServiceShape.ts";
import { install0 } from "./mcpServicePart0.ts";
import { install1 } from "./mcpServicePart1.ts";
import { DEFAULT_THREAD_ITEM_MAX_CHARS } from "./mcpSupport0.ts";
import { DEFAULT_THREAD_LIST_LIMIT } from "./mcpSupport0.ts";
import { DEFAULT_THREAD_READ_LIMIT } from "./mcpSupport0.ts";
import { DEFAULT_THREAD_RUN_LIMIT } from "./mcpSupport0.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { MAX_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { agentStopReason } from "./mcpSupport0.ts";
import { delegatedTaskRun } from "./mcpSupport0.ts";
import { directAppOwnedChildTasks } from "./mcpSupport0.ts";
import { directChildTaskIds } from "./mcpSupport0.ts";
import { errorMessage } from "./mcpSupport0.ts";
import { failure } from "./mcpSupport0.ts";
import { isThreadManagementError } from "./mcpSupport0.ts";
import { listItemFromShell } from "./mcpSupport0.ts";
import { stableCommandId } from "./mcpSupport0.ts";
import { stableMessageId } from "./mcpSupport0.ts";
import { stableOperationMessageId } from "./mcpSupport0.ts";
import { stableThreadId } from "./mcpSupport0.ts";
import { taskResultTransfer } from "./mcpSupport0.ts";
import { threadManagementFailure } from "./mcpSupport0.ts";
import { threadRun } from "./mcpSupport0.ts";
import { threadSettlement } from "./mcpSupport0.ts";
import { threadTitle } from "./mcpSupport0.ts";

type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;

type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1>;

export const mcpApiPart2 = (d: Deps) => ({
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* d.loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* d.loadProviders;
        const key = yield* d.requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* d.threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* d.threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* d.resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* d.assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* d.threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                  ...(parent.thread.linkOrigin === undefined
                    ? {}
                    : { linkOrigin: parent.thread.linkOrigin }),
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* d.threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* d.threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* d.loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* d.threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                link: formatThreadLink({ environmentId: scope.environmentId, threadId }),
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* d.loadCaller(scope);
      const projectId = input.allProjects
        ? null
        : yield* d.resolveProjectTarget(parent, input.projectId);
      const projectThreads = yield* d.threadManagement
        .listProjectThreads({
          projectId: projectId ?? undefined,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      // An empty list is no filter: clients that fill every optional field send `[]`.
      const statuses =
        input.statuses === undefined || input.statuses.length === 0
          ? null
          : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(scope, shell, nowMs)),
        nextCursor,
        total: filtered.length,
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const { parent, target, shell } = yield* d.loadReadableThread(scope, input.threadId);
      const view = input.view ?? "messages";
      const afterPosition = input.afterPosition ?? -1;
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      const timeline = yield* d.threadManagement
        .getTimelinePage(input.threadId, {
          afterPosition,
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = timeline.items;
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of page) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = yield* Effect.forEach(
        [...messageIdsByThread],
        ([threadId, messageIds]) =>
          d.threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map((records) => [threadId, records.messages] as const),
            Effect.mapError(threadManagementFailure),
          ),
        { concurrency: 1 },
      );
      const messagesByThreadId = new Map(sourceMessages);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined
          ? []
          : directAppOwnedChildTasks(
              {
                thread: parent.thread,
                subagents: yield* d.loadTasks(
                  parent.thread.id,
                  directChildTaskIds(target, returnedRunIds),
                ),
              },
              target,
              returnedRunIds,
            );
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        tasks.length > 0 &&
        (input.textOffset ?? 0) === 0
      ) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent, target, task);
          const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
          const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
          const resultRecords = yield* d.threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRunIds,
              turnItemRunIds: resultRunIds,
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesTerminalTaskResult({
              parent,
              page,
              task,
              target: { ...target, ...resultRecords },
              maxChars,
            })
          ) {
            yield* d.readTask(
              scope as McpThreadInvocationScope,
              task.id,
              false,
              true,
              "thread-read-acknowledge",
            );
          }
        }
      }
      return {
        thread: threadDetail(
          scope,
          target,
          timeline.totalItems,
          shell,
          yield* Clock.currentTimeMillis,
        ),
        recentRuns: target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun),
        items: page.map((row) =>
          timelineItem({
            row,
            maxChars,
            messagesByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
        ),
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: timeline.hasMore,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* d.loadScopedThread(scope, input.threadId);
      yield* d.assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

      const mode = input.mode ?? "auto";
      const key = yield* d.requestKey(input.clientRequestId);
      const messageId = stableOperationMessageId({
        scope,
        requestKey: key,
        operation: "thread-send",
      });
      const result = yield* d.threadManagement
        .sendToThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-send",
          }),
          threadId: input.threadId,
          ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
          messageId,
          text: input.message,
          attachments: [],
          mode,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
          ),
        );
      return {
        threadId: input.threadId,
        link: threadLinkFor(scope, input.threadId),
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendResult;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { parent, target } = yield* d.loadScopedThread(scope, input.threadId, false);
      const result = yield* d.threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
          ...(input.untilDelegatedWorkSettled === true ? { untilDelegatedWorkSettled: true } : {}),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const status = result.run === null ? "idle" : runOutcome(result.run);
      const taskId = result.run?.delegatedTaskId;
      const ownedTask =
        result.timedOut &&
        status !== "waiting" &&
        parent !== undefined &&
        taskId !== undefined &&
        (yield* d.loadTasks(parent.thread.id, [taskId])).some(
          (task) =>
            task.id === taskId &&
            task.origin === "app_owned" &&
            task.threadId === parent.thread.id &&
            task.childThreadId === input.threadId &&
            task.completionDelivery?.state !== "disposed",
        );
      // A child waiting on a question or approval needs an answer, not a wake.
      const childRequests = ownedTask
        ? (yield* d.threadManagement
            .getThreadRecords(input.threadId, ["runtimeRequests"])
            .pipe(Effect.mapError(threadManagementFailure))).runtimeRequests
        : [];
      const wakesCaller =
        ownedTask && !childRequests.some((request) => request.status === "pending");
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status,
        timedOut: result.timedOut,
        ...(wakesCaller ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : {}),
        ...(result.resultRun === undefined
          ? {}
          : {
              resultRun: { runId: result.resultRun.id, status: runOutcome(result.resultRun) },
            }),
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* d.loadScopedThread(scope, input.threadId);
      yield* d.assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* d.requestKey(input.clientRequestId);
      // A peer from before `stop` drops it when decoding, so it interrupts
      // the run instead, as this call did then.
      if (input.stop === true) {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "thread-stop" });
        // The cause goes to the log; the caller learns only that the stop failed.
        const stopFailed = (error: unknown) =>
          Effect.logWarning("orchestrator-mcp.thread-stop-failed", {
            threadId: input.threadId,
            error,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                failure("orchestration_error", `Unable to stop thread ${input.threadId}.`),
              ),
            ),
          );
        const stopped = yield* d.threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: input.threadId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.catch(stopFailed));
        // A retry with the same clientRequestId repeats only the stops that failed.
        yield* d.threadManagement
          .stopDelegatedTasks({ threadId: input.threadId, commandId, reason: input.reason })
          .pipe(Effect.catch(stopFailed));
        // The run this stop interrupted, from its own events, so a retry
        // reports the same run even if another has started since. Stop also
        // holds queued runs and marks runs it could not interrupt, with no
        // provider turn; neither is the run it interrupted.
        const interrupted = stopped.storedEvents.find(
          ({ event }) =>
            (event.type === "run.updated" && event.payload.status === "interrupted") ||
            (event.type === "turn-item.updated" &&
              event.payload.type === "run_interrupt_request" &&
              event.payload.providerTurnId !== null),
        )?.event.runId;
        return {
          threadId: input.threadId,
          runId: interrupted ?? null,
          status: interrupted === undefined ? "no_active_run" : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      const result = yield* d.threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          reason: agentStopReason(input.reason),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
}) satisfies Partial<OrchestratorMcpServiceShape>;
