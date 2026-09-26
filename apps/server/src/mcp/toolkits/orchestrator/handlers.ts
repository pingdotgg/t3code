import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpFailure,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpTarget,
  ORCHESTRATOR_MCP_MAX_BATCH_THREADS,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationDispatchError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorToolkit } from "./tools.ts";

// Ports of the matching Orchestrator V2 helpers (#2829,
// apps/server/src/mcp/OrchestratorMcpService.ts). Keep them in step until
// V2 replaces this file.

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/** An agent can narrow its own modes for a new thread, never widen them. */
function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return runtimeModeRank(resolved) > runtimeModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "runtime_mode_escalation_denied",
          message: `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
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
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

function providerConstraints(provider: ServerProvider): ReadonlyArray<string> {
  const constraints: Array<string> = [];
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

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Duplicate ids
 * always fail: downstream consumers disagree on which value wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

/**
 * Picks the provider instance, model, and options for a new thread. Omitted
 * fields inherit from the parent; a driverKind prefers the parent's instance
 * when that instance can run, then any healthy instance of the driver.
 */
function resolveTarget(input: {
  readonly parent: Pick<OrchestrationThreadShell, "modelSelection">;
  readonly target: OrchestratorMcpTarget | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): Effect.Effect<ModelSelection, OrchestratorMcpFailure> {
  return Effect.gen(function* () {
    const requestedDriver = input.target?.driverKind;
    let instanceId = input.target?.providerInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver && providerConstraints(provider).length === 0,
      );
      instanceId = (
        candidates.find(
          (candidate) => candidate.instanceId === input.parent.modelSelection.instanceId,
        ) ?? candidates[0]
      )?.instanceId;
      if (instanceId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "provider_unavailable",
          message: `No available provider instance for driver ${requestedDriver}.`,
        });
      }
    }
    instanceId ??= input.parent.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `Provider instance ${instanceId} is not registered.`,
      });
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      });
    }
    const constraints = providerConstraints(provider);
    if (constraints.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `Provider ${instanceId} cannot run a new thread: ${constraints.join(" ")}`,
      });
    }

    const inherited = input.parent.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inherited.instanceId ? inherited.model : provider.models[0]?.slug);
    if (model === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Provider ${instanceId} has no model available for inheritance.`,
      });
    }
    if (
      requestedModel !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      });
    }

    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        });
      }
    }

    if (
      instanceId === inherited.instanceId &&
      model === inherited.model &&
      requestedOptions === undefined
    ) {
      return inherited;
    }
    return requestedOptions === undefined
      ? { instanceId, model }
      : { instanceId, model, options: requestedOptions };
  });
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

/**
 * What the agent can do about a failed dispatch or read, from the error tag
 * alone. The engine replays an accepted command id, so a storage failure is
 * safe to retry with the same clientRequestId. A rejection is stored too, so
 * retrying it needs a new clientRequestId.
 */
function orchestrationErrorReason(error: OrchestrationDispatchError): string {
  switch (error._tag) {
    case "OrchestrationCommandInvariantError":
      return `T3 Code rejected the ${error.commandType} command.`;
    case "OrchestrationThreadSettleBlockedError":
      return "T3 Code rejected the command.";
    case "OrchestrationCommandPreviouslyRejectedError":
      return "An earlier call with this clientRequestId was rejected. Retry with a new clientRequestId.";
    case "OrchestrationCommandIdConflictError":
      return "This clientRequestId was already used for other work. Retry with a new clientRequestId.";
    case "PersistenceSqlError":
    case "PersistenceDecodeError":
    case "OrchestrationProjectorDecodeError":
      return "T3 Code could not read or write its database. Retry with the same clientRequestId.";
  }
}

function createdThreadStatus(
  thread: OrchestrationThreadShell,
  started: boolean,
): OrchestratorMcpCreatedThread["status"] {
  switch (thread.latestTurn?.state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case undefined:
      return started ? "starting" : "idle";
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const encoder = new TextEncoder();

  // A returned failure is a normal tool result, so McpServer never logs it.
  // Log the error here, and give the agent a message built from its tag.
  const orchestrationError =
    (context: string) =>
    (error: OrchestrationDispatchError): Effect.Effect<never, OrchestratorMcpFailure> =>
      Effect.logWarning(`create_threads: ${context}`, error).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `${context}: ${orchestrationErrorReason(error)}`,
            }),
          ),
        ),
      );

  const requireScope = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This MCP credential does not grant orchestration capabilities.",
      });
    }
    return scope;
  });

  const loadThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.catch(orchestrationError(`Unable to read thread ${threadId}`)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "thread_not_found",
                message: `Thread ${threadId} was not found.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  // Ids follow V2: a clientRequestId, or a fresh UUID, keyed by the provider
  // session and the entry index. The engine replays an accepted command id
  // from its receipt instead of running it again, so a retried or
  // overlapping call lands on the same threads and first turns. The thread
  // id is a digest because clients split scoped thread keys on ":".
  const requestKey = (clientRequestId: string | undefined) =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const stableThreadId = (sessionId: string, key: string, index: number) =>
    crypto.digest("SHA-256", encoder.encode(JSON.stringify([sessionId, key, index]))).pipe(
      Effect.orDie,
      Effect.map((digest) => ThreadId.make(`mcp-${hex(digest).slice(0, 32)}`)),
    );

  const stableCommandId = (sessionId: string, operation: string, key: string, index: number) =>
    CommandId.make(
      ["command", "mcp", sessionId, operation, encodeURIComponent(key), index].join(":"),
    );

  return OrchestratorToolkit.of({
    orchestrator_capabilities: () =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const parent = yield* loadThread(scope.threadId);
        const providers = yield* providerRegistry.getProviders;
        return {
          parentThreadId: scope.threadId,
          inheritedProviderInstanceId: parent.modelSelection.instanceId,
          inheritedModel: parent.modelSelection.model,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          providers: providers.map((provider) => {
            const constraints = providerConstraints(provider);
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider.displayName ?? null,
              models: provider.models.map((model) => ({
                id: model.slug,
                label: model.name,
                ...(model.capabilities?.optionDescriptors === undefined
                  ? {}
                  : { options: model.capabilities.optionDescriptors }),
              })),
              canRunChildTask: constraints.length === 0,
              canRunCrossProviderChildTask: constraints.length === 0,
              constraints: [...constraints],
            };
          }),
          // Only create_threads exists before V2. Agents that read this can
          // tell delegation, polling, and scheduling are not available.
          features: {
            appOwnedSubagents: false,
            asyncPolling: false,
            cancellation: false,
            batchThreadCreation: true,
            threadManagement: false,
            incrementalThreadRead: false,
            scheduledTasks: false,
            maxBatchThreads: ORCHESTRATOR_MCP_MAX_BATCH_THREADS,
          },
        };
      }),
    create_threads: (input: OrchestratorMcpCreateThreadsInput) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const parent = yield* loadThread(scope.threadId);
        const providers = yield* providerRegistry.getProviders;
        const key = yield* requestKey(input.clientRequestId);

        // Validate every entry before creating any, so one bad entry does not
        // leave half a batch behind.
        const plans = yield* Effect.forEach(input.threads, (request, index) =>
          Effect.gen(function* () {
            return {
              request,
              index,
              modelSelection: yield* resolveTarget({ parent, target: request.target, providers }),
              runtimeMode: yield* resolveRuntimeMode(parent.runtimeMode, request.runtimeMode),
              interactionMode: yield* resolveInteractionMode(
                parent.interactionMode,
                request.interactionMode,
              ),
              threadId: yield* stableThreadId(scope.providerSessionId, key, index),
              title: threadTitle({
                parentTitle: parent.title,
                prompt: request.prompt,
                title: request.title,
                index,
              }),
            };
          }),
        );

        const threads = yield* Effect.forEach(plans, (plan) =>
          Effect.gen(function* () {
            const { request, index, threadId, title, modelSelection } = plan;
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: stableCommandId(scope.providerSessionId, "create-thread", key, index),
                threadId,
                projectId: parent.projectId,
                title,
                modelSelection,
                runtimeMode: plan.runtimeMode,
                interactionMode: plan.interactionMode,
                branch: parent.branch,
                worktreePath: parent.worktreePath,
                createdAt,
              })
              .pipe(Effect.catch(orchestrationError(`Unable to create thread ${index + 1}`)));
            if (request.prompt !== undefined) {
              yield* engine
                .dispatch({
                  type: "thread.turn.start",
                  commandId: stableCommandId(
                    scope.providerSessionId,
                    "dispatch-thread",
                    key,
                    index,
                  ),
                  threadId,
                  message: {
                    messageId: MessageId.make(`mcp-start:${threadId}`),
                    role: "user",
                    text: request.prompt,
                    attachments: [],
                  },
                  // A title taken from the prompt is a placeholder, so let the
                  // first turn replace it the way the web composer does. An
                  // explicit title stays.
                  ...(request.title === undefined ? { titleSeed: title } : {}),
                  runtimeMode: plan.runtimeMode,
                  interactionMode: plan.interactionMode,
                  createdAt,
                })
                .pipe(Effect.catch(orchestrationError(`Unable to start thread ${index + 1}`)));
            }
            // Read back what the engine holds: a retried request reports the
            // thread it created the first time, not this call's input.
            const created = yield* loadThread(threadId);
            return {
              threadId,
              status: createdThreadStatus(created, request.prompt !== undefined),
              title: created.title,
              providerInstanceId: created.modelSelection.instanceId,
              model: created.modelSelection.model,
            } satisfies OrchestratorMcpCreatedThread;
          }),
        );
        return { threads };
      }),
  });
});

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(make);
