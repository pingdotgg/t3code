import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { isBuiltInProviderAdapterDriverV2 } from "../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { subagentResultForRun } from "../orchestration-v2/SubagentProjection.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_POLL_INTERVAL_MS = 50;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!provider.enabled) constraints.push("Provider instance is disabled.");
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

function isActiveRun(run: OrchestrationV2Run): boolean {
  return run.status === "starting" || run.status === "running" || run.status === "waiting";
}

function taskStatusForRun(
  run: OrchestrationV2Run | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run?.status) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "full-access":
      return 2;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return runtimeModeRank(resolved) > runtimeModeRank(parentMode)
    ? Effect.fail(
        failure(
          "runtime_mode_escalation_denied",
          `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.providerSessionId),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.providerSessionId),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.providerSessionId),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrator = yield* OrchestratorV2;
  const providerRegistry = yield* ProviderRegistry;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    orchestrator
      .getThreadProjection(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProviders = providerRegistry.getProviders;

  const resolveTarget = (input: {
    readonly parent: OrchestrationV2ThreadProjection;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
  }): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const requestedInstanceId = input.target?.providerInstanceId;
      const requestedDriver = input.target?.driverKind;
      let instanceId = requestedInstanceId;

      if (instanceId === undefined && requestedDriver !== undefined) {
        const candidates = input.providers.filter(
          (provider) =>
            provider.driver === requestedDriver &&
            isBuiltInProviderAdapterDriverV2(provider.driver),
        );
        if (candidates.length === 0) {
          return yield* failure(
            "provider_unavailable",
            `No V2 provider adapter is registered for driver ${requestedDriver}.`,
          );
        }
        const inheritedCandidate = candidates.find(
          (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
        );
        const availableCandidate = candidates.find((candidate) => {
          return (
            providerConstraints(candidate, isBuiltInProviderAdapterDriverV2(candidate.driver))
              .length === 0
          );
        });
        instanceId = inheritedCandidate?.instanceId ?? availableCandidate?.instanceId;
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
        isBuiltInProviderAdapterDriverV2(provider.driver),
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
          : provider?.models[0]?.slug);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Provider ${instanceId} has no model available for inheritance.`,
        );
      }
      if (
        requestedModel !== undefined &&
        provider !== undefined &&
        provider.models.length > 0 &&
        !provider.models.some((candidate) => candidate.slug === requestedModel)
      ) {
        return yield* failure(
          "model_unavailable",
          `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
        );
      }

      return {
        modelSelection:
          instanceId === inheritedSelection.instanceId && model === inheritedSelection.model
            ? inheritedSelection
            : { instanceId, model },
      };
    });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = (
    scope: McpInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
  ): Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parentProjection = yield* loadProjection(scope.threadId);
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === taskId &&
          candidate.origin === "app_owned" &&
          candidate.threadId === scope.threadId,
      );
      if (task === undefined || task.childThreadId === null) {
        return yield* failure(
          "task_not_found",
          `Delegated task ${taskId} does not belong to thread ${scope.threadId}.`,
        );
      }
      const childProjection = yield* loadProjection(task.childThreadId);
      const childRun = childProjection.runs[0];
      const status = taskStatusForRun(childRun);
      const derivedResult =
        task.result !== null
          ? task.result
          : childRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, childRun).text
            : null;
      const resultTransfer =
        parentProjection.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourceThreadId === task.childThreadId &&
            transfer.targetThreadId === scope.threadId,
        ) ?? null;
      return {
        taskId: task.id,
        childThreadId: task.childThreadId,
        childRunId: childRun?.id ?? null,
        childNodeId: task.id,
        status,
        providerInstanceId: ProviderInstanceId.make(task.provider),
        model: task.model,
        summary: derivedResult,
        resultContextTransferId: resultTransfer?.id ?? null,
        waitTimedOut,
      };
    });

  const waitForTask = (scope: McpInvocationScope, taskId: NodeId, timeoutMs: number) =>
    Effect.gen(function* () {
      while (true) {
        const result = yield* readTask(scope, taskId);
        if (isTerminalTaskStatus(result.status)) return result;
        yield* Effect.sleep(Duration.millis(TASK_POLL_INTERVAL_MS));
      }
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));

  return OrchestratorMcpService.of({
    capabilities: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const providers = yield* loadProviders;
        return {
          parentThreadId: scope.threadId,
          inheritedProviderInstanceId: parent.thread.modelSelection.instanceId,
          inheritedModel: parent.thread.modelSelection.model,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
          providers: providers.map((provider) => {
            const constraints = providerConstraints(
              provider,
              isBuiltInProviderAdapterDriverV2(provider.driver),
            );
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider?.displayName ?? null,
              models:
                provider?.models.map((model) => ({
                  id: model.slug,
                  label: model.name ?? null,
                })) ?? [],
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
            maxBatchThreads: 20,
          },
        };
      }),
    delegateTask: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const parentRun = parent.runs
          .filter(isActiveRun)
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.provider !== scope.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.",
          );
        }
        const providers = yield* loadProviders;
        const target = yield* resolveTarget({
          parent,
          target: input.target,
          providers,
        });
        const runtimeMode = yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        const key = yield* requestKey(input.clientRequestId);
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "delegate-task",
        });
        const result = yield* orchestrator
          .dispatch({
            type: "delegated_task.request",
            commandId,
            parentThreadId: scope.threadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId,
            task: taskPrompt(input),
            ...(input.title === undefined ? {} : { title: input.title }),
            modelSelection: target.modelSelection,
            runtimeMode,
            interactionMode,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
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

        if (input.mode !== "wait") {
          return yield* readTask(scope, taskEvent.event.payload.id);
        }
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        );
        const waited = yield* waitForTask(scope, taskEvent.event.payload.id, timeoutMs);
        return Option.isSome(waited)
          ? waited.value
          : yield* readTask(scope, taskEvent.event.payload.id, true);
      }),
    taskStatus: (scope, taskId) => readTask(scope, taskId),
    cancelTask: (scope, input) =>
      Effect.gen(function* () {
        const current = yield* readTask(scope, input.taskId);
        if (isTerminalTaskStatus(current.status)) {
          return {
            taskId: input.taskId,
            status: current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        const child = yield* loadProjection(current.childThreadId);
        const activeRun = child.runs.find(isActiveRun);
        if (activeRun === undefined) {
          return yield* failure(
            "task_not_cancellable",
            `Delegated task ${input.taskId} has no interruptible child run.`,
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        yield* orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "cancel-task",
            }),
            threadId: current.childThreadId,
            runId: activeRun.id,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to interrupt delegated task ${input.taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        return {
          taskId: input.taskId,
          status: "cancel_requested",
        };
      }),
    createThreads: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const parent = yield* loadProjection(scope.threadId);
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const target = yield* resolveTarget({
                parent,
                target: request.target,
                providers,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* orchestrator
                .dispatch({
                  type: "thread.create",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "create-thread",
                    index,
                  }),
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              if (request.prompt !== undefined) {
                yield* orchestrator
                  .dispatch({
                    type: "message.dispatch",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: target.modelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                      ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                providerInstanceId: target.modelSelection.instanceId,
                model: target.modelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  Crypto.Crypto | OrchestratorV2 | ProviderRegistry
> = Layer.effect(OrchestratorMcpService, make);
