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
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
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
import { isLiveCallerShell, threadNotFound } from "./threadAccess.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import { errorMessage, failure, invalidOptionSelections, isTerminalTaskStatus, knownOptions, providerConstraints, scheduledTaskSummary, stableCommandId, threadManagementFailure, type SuccessOf } from "./OrchestratorMcpService.ts";
import type { ResolvedTarget } from "./OrchestratorMcpService.ts";

export type Deps = {};

export const install0 = Effect.fn("orchestratorMcp.install0")(function* (d: Deps) {
  const random = yield* SecureRandom.SecureRandom;

  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;

  const projects = yield* ProjectService.ProjectService;

  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;

  const gitDriver = yield* GitVcsDriver.GitVcsDriver;

  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;

  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a T3 thread.",
            ),
          );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const loadThreadRecords = <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    threadManagement
      .getThreadRecords(threadId, fields, filter)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadTasks = (threadId: ThreadId, taskIds: ReadonlyArray<NodeId>) =>
    threadManagement.getThreadRecords(threadId, ["subagents"], { subagentIds: taskIds }).pipe(
      Effect.map(({ subagents }) => subagents),
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read thread ${threadId}: ${errorMessage(error)}`),
      ),
    );

  // Task waits read on every wake of a parent that may hold thousands of
  // tasks, so they read only the task they watch and what its status needs.

  const loadTaskParent = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(threadId, ["runs", "contextTransfers"])
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /** Background agents miss foreground-only health probes; re-probe once before refusing. */

  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined ? random.uuidV4() : Effect.succeed(clientRequestId);

  const refExists = (cwd: string, revision: string) =>
    gitDriver.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);

  const loadProjection = (threadId: ThreadId, includeUserMessages = true) =>
    loadThreadRecords(
      threadId,
      [
        "runs",
        "messages",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "contextTransfers",
        "turnItems",
      ],
      { turnItemTypes: [], messageRoles: includeUserMessages ? ["user"] : [] },
    );

  // A dispatcher thread holds thousands of tasks, each with its full prompt; read only the ones named.

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
    includeHistory = true,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    // Native wait owns its history reads; keep legacy import and project validation here.
    return yield* includeHistory
      ? loadProjectThread(shell.projectId, threadId)
      : threadManagement
          .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
          .pipe(Effect.mapError(threadManagementFailure));
  });

  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /** Receipt replays bypass current settings because they start no work. Dispatch must reuse the checked command ID. */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    const requestedInstanceId = input.target?.providerInstanceId;
    const requestedDriver = input.target?.driverKind;
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= input.parent.thread.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    const inheritedSelection = input.parent.thread.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      requestedModel !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      );
    }

    const descriptors = provider.models.find((candidate) => candidate.slug === model)?.capabilities
      ?.optionDescriptors;
    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
    let options = inheritsOptions
      ? knownOptions(inheritedSelection.options, descriptors)
      : undefined;
    if (requestedOptions !== undefined) {
      const selections = new Map(
        (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      for (const selection of requestedOptions) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const readRemoteTask = Effect.fn("OrchestratorMcpService.readRemoteTask")(function* (
    scope: McpThreadInvocationScope,
    task: OrchestrationV2Subagent,
    waitTimedOut: boolean,
    acknowledgeTerminal: boolean,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const status: OrchestratorMcpDelegateTaskResult["status"] =
      task.result === null
        ? "running"
        : task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled" ||
            task.status === "interrupted"
          ? task.status
          : "completed";
    const terminal = isTerminalTaskStatus(status);
    if (
      acknowledgeTerminal &&
      terminal &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const parentThreadId = scope.thread.threadId;
      const parentProjection = yield* threadManagement
        .getThreadRecords(parentThreadId, ["runs"])
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to read thread ${parentThreadId}: ${errorMessage(error)}`,
            ),
          ),
        );
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: yield* requestKey(undefined),
            operation: "task-status-acknowledge",
          }),
          parentThreadId: scope.thread.threadId,
          taskId: task.id,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${task.id}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return {
      taskId: task.id,
      childThreadId: null,
      ...(task.remoteChild === undefined
        ? {}
        : { remoteChild: task.remoteChild, link: formatThreadLink(task.remoteChild) }),
      childRunId: null,
      childNodeId: task.id,
      status,
      workState: terminal ? "result_available" : "working",
      hasPendingChildRuns: false,
      providerInstanceId: task.providerInstanceId,
      model: task.model,
      summary: task.result,
      resultContextTransferId: null,
      latestTerminalRunId: null,
      latestTerminalStatus: terminal
        ? (status as OrchestratorMcpDelegateTaskResult["latestTerminalStatus"])
        : null,
      latestTerminalSummary: terminal ? task.result : null,
      latestTerminalResultContextTransferId: null,
      // Its questions and approvals are answered in the environment it runs in.
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
  });

  const resolveScheduledTaskBaseRef = Effect.fn(
    "OrchestratorMcpService.resolveScheduledTaskBaseRef",
  )(function* (cwd: string) {
    const remoteName = yield* gitDriver
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    const conventional = ["main", "master"];
    if (remoteName !== null) {
      const remoteDefault = yield* gitDriver
        .resolveDefaultBranchName(cwd, remoteName)
        .pipe(Effect.orElseSucceed(() => null));
      // Fetch does not update a recorded HEAD, so it can outlive the branch it names.
      for (const branch of remoteDefault === null
        ? conventional
        : [remoteDefault, ...conventional]) {
        // Launch resolves a bare name through a local branch's upstream, or else assumes `origin`.
        if (yield* refExists(cwd, `refs/remotes/${remoteName}/${branch}`)) {
          return `${remoteName}/${branch}`;
        }
      }
    }
    // Local-only repositories, or a remote with neither a usable HEAD nor a conventional branch.
    for (const branch of conventional) {
      if (yield* refExists(cwd, `refs/heads/${branch}`)) return branch;
    }
    return "main";
  });

  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */

  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: clientModeCeiling(scope.client),
      } as const;
    }
    // No loadCaller consumer reads the caller's own prompts.
    const parent = yield* loadProjection(scope.thread.threadId, false);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadProjection(threadScope.thread.threadId);
    return { scope: threadScope, parent } as const;
  });

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };
  return {
    random,
    threadManagement,
    providerRegistry,
    providerAdapters,
    scheduledTasks,
    projects,
    threadLaunch,
    gitDriver,
    serverSettings,
    remoteDelegation,
    secretRequests,
    requireCapability,
    resolveProjectTarget,
    withinLimits,
    requireProject,
    loadThreadRecords,
    loadTasks,
    loadTaskParent,
    loadProjectThread,
    assertLiveCaller,
    loadProviders,
    loadOrchestrationCapableInstanceIds,
    assertTargetEnabledForProject,
    requestKey,
    refExists,
    scheduledTaskRunModes,
    projectDefaultModelSelection,
    loadProjection,
    loadTargetThread,
    assertLiveCallerForOtherThread,
    assertLiveCallerForOtherProject,
    resolveTarget,
    readRemoteTask,
    resolveScheduledTaskBaseRef,
    summarizeScheduledTask,
    loadScheduledTask,
    loadCaller,
    loadThreadCaller,
    resolveTargetRechecking,
  };
});
