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
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { OrchestratorMcpServiceShape } from "./mcpServiceShape.ts";
import { install0 } from "./mcpServicePart0.ts";
import { install1 } from "./mcpServicePart1.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { MAX_WAIT_TIMEOUT_MS } from "./mcpSupport0.ts";
import { OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { SECRET_REQUEST_POLL_INTERVAL_MS } from "./mcpSupport0.ts";
import { capabilityModelOption } from "./mcpSupport0.ts";
import { errorMessage } from "./mcpSupport0.ts";
import { failure } from "./mcpSupport0.ts";
import { knownOptions } from "./mcpSupport0.ts";
import { listCapabilityModels } from "./mcpSupport0.ts";
import { providerConstraints } from "./mcpSupport0.ts";
import { stableCommandId } from "./mcpSupport0.ts";
import { stablePart } from "./mcpSupport0.ts";

type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;

type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1>;

export const mcpApiPart0 = (d: Deps) => ({
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* d.loadCaller(scope);
      const projectId = yield* d.resolveProjectTarget(parent, input.projectId);
      yield* d.assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* d.requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* d.projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: yield* d.scheduledTaskWorkspaceStrategy(bindToCurrentThread, projectId),
        modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const { task } = yield* d.scheduledTasks
        .upsert(upsertInput)
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not schedule task: ${error.message}`),
          ),
        );
      return yield* d.summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* d.loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* d.scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: yield* Effect.forEach(
            tasks.filter((task) => projectId === undefined || task.projectId === projectId),
            (task) => d.summarizeScheduledTask(scope, { parent, limits }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* d.loadCaller(scope);
        const existing = yield* d.loadScheduledTask(input.scheduledTaskId, limits);
        yield* d.assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a T3 thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Update workspace strategy on rebinding so unbound root tasks cannot run in the shared checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : yield* d.scheduledTaskWorkspaceStrategy(input.bindToCurrentThread, existing.projectId);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* d.scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return yield* d.summarizeScheduledTask(scope, { parent, limits }, task);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* d.loadCaller(scope);
        const existing = yield* d.loadScheduledTask(input.scheduledTaskId, limits);
        yield* d.assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* d.scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: Effect.fn("OrchestratorMcpService.requestSecret")(function* (scope, input) {
      const { scope: threadScope, parent } = yield* d.loadThreadCaller(scope, "request_secret");
      const threadId = threadScope.thread.threadId;
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Asking for a secret requires an active run owned by this MCP provider session.",
        );
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const key = yield* d.requestKey(input.clientRequestId);
      const turnItemId = TurnItemId.make(
        `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
      );
      const record = (secretStatus: "pending" | "cancelled") =>
        d.threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: `secret-${secretStatus}`,
            }),
            threadId: threadId,
            runId,
            nodeId,
            turnItemId,
            label: input.label,
            reason: input.reason,
            ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
            ...(input.delivery === "file" ? { delivery: "file" as const } : {}),
            secretStatus,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Could not record the secret request: ${errorMessage(error)}`,
              ),
            ),
          );
      yield* record("pending");
      // Only this call can hand the agent its ref, so the card must not
      // outlive it: a timeout, a failed wait or an aborted call closes it as
      // cancelled.
      const closeCard = record("cancelled").pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not close a secret request card", { error: error.message }),
        ),
      );

      const answered = yield* Effect.gen(function* () {
        while (true) {
          const projection = yield* d.threadManagement
            .getThreadRecords(threadId, ["runs", "turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to read the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
          const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
          if (item?.type === "secret_request" && item.secretStatus !== "pending") {
            return item.secretStatus;
          }
          const current = projection.runs.find((candidate) => candidate.id === runId);
          if (
            current === undefined ||
            ThreadManagementService.isTerminalRunStatus(current.status)
          ) {
            yield* record("cancelled");
            return "cancelled" as const;
          }
          yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
          ),
        ),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
      );
      if (Option.isNone(answered)) yield* closeCard;
      const status = Option.isSome(answered)
        ? answered.value
        : yield* d.threadManagement
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.map((records) => {
                const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
                return item?.type === "secret_request" &&
                  (item.secretStatus === "saved" || item.secretStatus === "declined")
                  ? item.secretStatus
                  : ("timed_out" as const);
              }),
              Effect.orElseSucceed(() => "timed_out" as const),
            );
      yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
      if (status !== "saved") return { status };
      if (input.delivery === "file") {
        const file = yield* d.secretRequests
          .saveToFile({ threadId, turnItemId })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { status, file };
      }
      const secretRef = yield* d.secretRequests.savedRef({ threadId: threadId, turnItemId });
      if (Option.isNone(secretRef)) {
        return yield* failure(
          "orchestration_error",
          "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
        );
      }
      return { status, secretRef: secretRef.value };
    }),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope, input = {}) {
      const { parent, limits } = yield* d.loadCaller(scope);
      const providers = yield* d.loadProviders;
      const orchestrationCapableInstanceIds = yield* d.loadOrchestrationCapableInstanceIds();
      const settings = yield* d.serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      return {
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions:
          knownOptions(
            inherited?.options,
            providers
              .find((provider) => provider.instanceId === inherited?.instanceId)
              ?.models.find((model) => model.slug === inherited?.model)?.capabilities
              ?.optionDescriptors,
          ) ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          // Snapshots list instances any project enables; delegate_task checks the caller's project.
          const enabledForCaller =
            parent === undefined ||
            resolveProjectProviderInstanceEnabled(
              settings,
              parent.thread.projectId,
              provider.instanceId,
            );
          const constraints = providerConstraints(
            enabledForCaller ? provider : { ...provider, enabled: false },
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          const { listed, omitted } = listCapabilityModels({
            provider,
            preferences: settings.providerModelPreferences?.[provider.instanceId],
            searchTerms,
            isPinned: (model) =>
              model.isCustom ||
              (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
              (settings.favorites ?? []).some(
                (favorite) =>
                  favorite.provider === provider.instanceId && favorite.model === model.slug,
              ),
          });
          return {
            providerInstanceId: provider.instanceId,
            driverKind: provider.driver,
            displayName: provider.displayName ?? null,
            models: listed.map((model) => {
              const options = model.capabilities?.optionDescriptors ?? [];
              return {
                id: model.slug,
                ...(model.name.toLowerCase() === model.slug.toLowerCase()
                  ? {}
                  : { label: model.name }),
                ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
              };
            }),
            ...(omitted === 0 ? {} : { omittedModels: omitted }),
            ...(provider.supportedRuntimeModes === undefined ||
            provider.supportedRuntimeModes.length === 0
              ? {}
              : { runtimeModes: [...provider.supportedRuntimeModes] }),
            canRunChildTask: constraints.length === 0,
            canRunCrossProviderChildTask: constraints.length === 0,
            constraints: [...constraints],
          };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
}) satisfies Partial<OrchestratorMcpServiceShape>;
