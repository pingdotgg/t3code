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
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
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
import type { OrchestratorMcpServiceShape } from "./mcpServiceShape.ts";
import { install0 } from "./mcpServicePart0.ts";
import { install1 } from "./mcpServicePart1.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { MAX_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { agentStopReason } from "./mcpSupport0.ts";
import { errorMessage } from "./mcpSupport0.ts";
import { failure } from "./mcpSupport0.ts";
import { isTerminalTaskStatus } from "./mcpSupport0.ts";
import { stableCommandId } from "./mcpSupport0.ts";
import { threadManagementFailure } from "./mcpSupport0.ts";

type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;

type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1>;

export const mcpApiPart1 = (d: Deps) => ({
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      const environmentId =
        input.target === undefined
          ? undefined
          : PeerForwarding.remoteTarget(callerScope, input.target.environmentId);
      if (input.target !== undefined && environmentId !== undefined) {
        yield* d.requireCapability(callerScope);
        const scope = yield* requireThreadScope(callerScope, "delegate_task");
        // The task's child runs as an ordinary thread there; this thread keeps the task.
        const { taskId } = yield* d.remoteDelegation.delegate(scope, {
          ...input,
          target: { ...input.target, environmentId },
        });
        return yield* input.mode === "wait"
          ? d.awaitTask(scope, taskId, input.timeoutMs)
          : d.readTask(scope, taskId, false, true);
      }
      const { scope, parent } = yield* d.loadThreadCaller(callerScope, "delegate_task");
      if (
        input.target?.projectId !== undefined &&
        input.target.projectId !== parent.thread.projectId
      ) {
        return yield* failure(
          "invalid_request",
          "A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project.",
        );
      }
      const parentRun = parent.runs
        .filter(ThreadManagementService.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
      const providers = yield* d.loadProviders;
      const key = yield* d.requestKey(input.clientRequestId);
      const commandId = stableCommandId({
        scope,
        requestKey: key,
        operation: "delegate-task",
      });
      const isRetryOfAcceptedDelegation = yield* d.threadManagement.hasReceipt(commandId);
      const target = yield* d.resolveTargetRechecking({
        parent,
        target: input.target,
        providers,
        skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
      });
      const runtimeMode = yield* resolveRuntimeMode(
        parent.thread.runtimeMode,
        input.runtimeMode,
        target,
      );
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        input.interactionMode,
      );
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
      if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
        const project = yield* d.requireProject(parent.thread.projectId);
        const base = yield* d.gitDriver
          .resolveCommit({
            cwd: parent.thread.worktreePath ?? project.workspaceRoot,
            revision: "HEAD",
          })
          .pipe(
            Effect.mapError(() =>
              failure("invalid_request", "Unable to resolve the parent checkout commit."),
            ),
          );
        // Launch preparation creates the worktree from the project root, so a
        // parent checkout in another repository (such as a Git folder inside
        // Scratch) would hand it a commit it cannot find.
        if (parent.thread.worktreePath !== null) {
          yield* d.gitDriver
            .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
            .pipe(
              Effect.mapError(() =>
                failure(
                  "invalid_request",
                  `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                ),
              ),
            );
        }
        workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
      }
      // ThreadManagementService.dispatch is the chokepoint for this command
      // type's own enablement check, using the same command id and its
      // receipt-replay exemption, so no separate assert runs here.
      const result = yield* d.threadManagement
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: taskPrompt(input),
          ...(input.title === undefined ? {} : { title: input.title }),
          modelSelection: target.modelSelection,
          runtimeMode,
          interactionMode,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          // Async delegations wake the parent on every child terminal; wait
          // delegations deliver through the blocking tool call, so a wake is
          // only needed if the parent settled first (timeout, disconnect).
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to create delegated task: ${errorMessage(error)}`,
                ),
          ),
        );
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      const taskId = taskEvent.event.payload.id;
      const childThreadId = taskEvent.event.payload.childThreadId;
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (
        childThreadId !== null &&
        childRunEvent?.event.type === "run.created" &&
        childRunEvent.event.payload.workspacePreparation !== undefined
      ) {
        yield* d.threadLaunch.prepareRun({
          commandId,
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        });
      }

      if (input.mode !== "wait") {
        return yield* d.readTask(scope, taskId, false, true);
      }
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const waited = yield* d.waitForTask(scope, taskId, timeoutMs);
      if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
        return waited.value;
      }
      // An incomplete wait gives up delivery: upgrade so a later terminal
      // wakes the parent even mid-turn.
      yield* d.threadManagement
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "delegate-task-wake-policy",
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          completionWake: "always",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome:
                error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "previously_rejected"
                  : "dispatch_failed",
              error,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome: "defect",
              cause,
            }),
          ),
        );
      return yield* d.readTask(scope, taskId, Option.isNone(waited), true);
    }),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(function* (callerScope, taskId) {
      const scope = yield* requireThreadScope(callerScope, "task_status");
      return yield* d.readTask(scope, taskId, false, true);
    }),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_cancel");
      const current = yield* d.readTask(scope, input.taskId);
      const childThreadId = current.childThreadId;
      if (childThreadId === null) {
        // The task runs in a linked environment: its thread there is stopped through the link.
        const subagents = yield* d.loadTasks(scope.thread.threadId, [input.taskId]);
        const remoteTask = subagents.find(
          (task) =>
            task.id === input.taskId &&
            task.origin === "app_owned" &&
            task.remoteChild !== undefined,
        );
        if (remoteTask === undefined) {
          return yield* failure(
            "task_not_found",
            `Delegated task ${input.taskId} does not belong to thread ${scope.thread.threadId}.`,
          );
        }
        return yield* d.remoteDelegation.cancel(scope, remoteTask, input);
      }
      const key = yield* d.requestKey(input.clientRequestId);
      const parentProjection = yield* d.loadThreadRecords(scope.thread.threadId, []);
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* d.threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
        }
        const childThreadIds = yield* d.threadManagement
          .listAppOwnedChildThreadIds(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        for (const childThreadId of childThreadIds) {
          yield* assertStoppable(childThreadId);
        }
      });
      yield* assertStoppable(childThreadId);
      const parentTask = (yield* d.loadTasks(scope.thread.threadId, [input.taskId])).find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery =
        parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : d.threadManagement
              .dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-completion-delivery",
                }),
                parentThreadId: scope.thread.threadId,
                taskId: input.taskId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                  ),
                ),
              );
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
        const reason = agentStopReason(input.reason);
        yield* d.threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: childThreadId,
            stopDelegatedTasks: false,
            reason,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        yield* d.threadManagement
          .stopDelegatedTasks({ threadId: childThreadId, commandId, reason })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
              ),
            ),
          );
        const stopped = yield* d.threadManagement
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* d.threadManagement
            .dispatch({
              type: "queued-run.cancel",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `cancel-task-queued-run:${run.id}`,
              }),
              threadId: childThreadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
        }
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: parentProjection.thread.runtimeMode,
          interactionMode: parentProjection.thread.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      // A follow-up that lost its child run stays running on the parent, while its
      // status here comes from the child's last run. Stop on the parent cancels that task.
      const cancelOrphan = Effect.gen(function* () {
        if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
          return false;
        yield* d.threadManagement.dispatch({
          type: "subagent.stop",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "cancel-task-orphan",
          }),
          threadId: scope.thread.threadId,
          runId: parentTask.runId,
          subagentId: parentTask.id,
        });
        const { subagents } = yield* d.threadManagement.getThreadRecords(
          scope.thread.threadId,
          ["subagents"],
          { subagentIds: [input.taskId] },
        );
        return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
      }).pipe(Effect.mapError(threadManagementFailure));
      if (isTerminalTaskStatus(current.status)) {
        // The child can still run work for another turn, so it is stopped either way.
        yield* stopWithinLimit;
        const cancelled = yield* cancelOrphan;
        yield* disposeCompletionDelivery;
        return {
          taskId: input.taskId,
          status: cancelled ? "cancelled" : current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const child = yield* d.loadThreadRecords(childThreadId, ["runs"]);
      if (
        current.workState !== "waiting_for_children" &&
        ThreadManagementService.latestActiveRun(child) === undefined &&
        !child.runs.some(
          (run) =>
            run.status === "queued" &&
            (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
        )
      ) {
        if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" };
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${input.taskId} has no interruptible child run.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId: input.taskId,
            cause,
          }),
        ),
      );
      return {
        taskId: input.taskId,
        status: "cancel_requested",
      };
    }),
}) satisfies Partial<OrchestratorMcpServiceShape>;
