// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingReturnYieldStar:off
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
import {
  subagentResultForRun,
  delegatedTaskProgress,
} from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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
import { isLiveCallerShell, threadNotFound } from "./threadAccess.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, TASK_WAKE_EVENTS, canExposeTaskRunResult, delegatedTaskRun, endsTaskWait, errorMessage, failure, hasPendingChildRuns, isTerminalTaskStatus, latestTerminalResultRun, pendingTaskApproval, stableCommandId, taskResultTransfer, taskStatusForRun, threadManagementFailure, type SuccessOf } from "./OrchestratorMcpService.ts";
import { install0 } from "./mcpServicePart0.ts";

export type Deps = SuccessOf<typeof install0>;

export const install1 = Effect.fn("orchestratorMcp.install1")(function* (d: Deps) {
  const { loadCaller, loadTargetThread, loadTaskParent, loadTasks, readRemoteTask, requestKey, requireCapability, requireProject, resolveScheduledTaskBaseRef, threadManagement } = d;
  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const task = (yield* loadTasks(scope.thread.threadId, [taskId])).find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined || (task.childThreadId === null && task.remoteChild === undefined)) {
      return yield* failure(
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    if (task.childThreadId === null) {
      return yield* readRemoteTask(scope, task, waitTimedOut, acknowledgeTerminal);
    }
    const parentProjection = yield* loadTaskParent(scope.thread.threadId);
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "runtimeRequests",
          "nodes",
        ],
        // Progress reads only active or undelivered tasks under the child.
        { messageRoles: ["user"], omitSettledLeafNodes: true, omitSettledSubagents: true },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "result_available"
          : "working"
        : progress.state;
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const status =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(taskResultRun ?? childRun)
          : taskStatusForRun(taskResultRun ?? childRun) === "queued"
            ? "queued"
            : "running";
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? subagentResultForRun(childProjection, taskResultRun).text
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : subagentResultForRun(childProjection, terminalRun).text
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const modelSelection = childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const result = {
      taskId: task.id,
      childThreadId: task.childThreadId,
      link: formatThreadLink({
        environmentId: scope.environmentId,
        threadId: task.childThreadId,
      }),
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      options: modelSelection.options ?? [],
      summary: derivedResult,
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        childControls.runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, task.id, childRun),
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
    const response: OrchestratorMcpDelegateTaskResult =
      endsTaskWait(result) || task.completionDelivery?.state === "disposed"
        ? result
        : { ...result, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT };
    if (
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      const acknowledgementRequestKey = yield* requestKey(undefined);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: acknowledgementRequestKey,
            operation: acknowledgementOperation,
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return response;
  });

  /** `mode=wait` on a task already recorded, as `delegateTask` does for its own. */

  const scheduledTaskWorkspaceStrategy = Effect.fn(
    "OrchestratorMcpService.scheduledTaskWorkspaceStrategy",
  )(function* (boundToThread: boolean, projectId: ProjectId) {
    if (boundToThread) return { type: "root" as const };
    const { workspaceRoot } = yield* requireProject(projectId);
    return {
      type: "worktree" as const,
      baseRef: yield* resolveScheduledTaskBaseRef(workspaceRoot),
      startFromOrigin: true,
    };
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
    includeHistory = true,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(threadId, includeHistory);
    return { ...caller, target } as const;
  });

  /** Cross-thread writes require a live caller run; stale session credentials cannot authorize them. */

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* loadCaller(scope);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const input = { projectId: shell.projectId, threadId };
    // Transfers are needed only to acknowledge a caller's child-task result.
    const records =
      parent === undefined
        ? threadManagement
            .getProjectThreadRecords(input, ["runs", "runtimeRequests"])
            .pipe(Effect.map((target) => ({ ...target, contextTransfers: [] })))
        : threadManagement.getProjectThreadRecords(input, [
            "runs",
            "runtimeRequests",
            "contextTransfers",
          ]);
    const target = yield* records.pipe(Effect.mapError(threadManagementFailure));
    return { parent, target, shell } as const;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // One global cursor before both reads captures later events from either thread.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      // A remote task has no child here; its completion lands on the parent.
      const childThreadId = initial.childThreadId;
      const wakeEvents =
        childThreadId === null
          ? TASK_WAKE_EVENTS.filter(({ thread }) => thread === "parent")
          : TASK_WAKE_EVENTS;
      return yield* Stream.mergeAll(
        wakeEvents.map(({ thread, eventType }) =>
          threadManagement
            .streamStoredEventsFrom({
              threadId:
                thread === "parent" || childThreadId === null
                  ? scope.thread.threadId
                  : childThreadId,
              afterSequence,
              eventType,
            })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  thread === "child" ||
                  event.type !== "subagent.updated" ||
                  event.payload.id === taskId,
              ),
            ),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    },
    (effect, _scope, _taskId, timeoutMs) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten)),
  );

  const awaitTask = Effect.fn("OrchestratorMcpService.awaitTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    requestedTimeoutMs: number | undefined,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, requestedTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    const waited = yield* waitForTask(scope, taskId, timeoutMs);
    if (Option.isSome(waited)) return waited.value;
    // As for a local task: once the blocking wait ends, a later result wakes the parent.
    yield* threadManagement
      .dispatch({
        type: "delegated_task.wake-policy",
        commandId: stableCommandId({
          scope,
          requestKey: taskId,
          operation: "delegate-task-wake-policy",
        }),
        parentThreadId: scope.thread.threadId,
        taskId,
        completionWake: "always",
      })
      .pipe(Effect.ignoreCause({ log: true }));
    return yield* readTask(scope, taskId, true, true);
  });

  /**
   * A task that runs in a linked environment, answered from its row here:
   * the follower records its result once its thread there ends.
   */
  return {
    readTask,
    scheduledTaskWorkspaceStrategy,
    loadScopedThread,
    loadReadableThread,
    waitForTask,
    awaitTask,
  };
});
