import {
  CommandId,
  type ConversationConfigurationBehavior,
  type ConversationConfigurationChange,
  type ConversationConfigurationInput,
  type ConversationConfigurationProvider,
  type ConversationConfigurationReceipt,
  type ConversationConfigurationResult,
  type ConversationConfigurationSelection,
  type ConversationConfigureInput,
  type ConversationConfigureResult,
  isProviderAvailable,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2PolicyCeiling,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { isBuiltInProviderAdapterDriverV2 } from "../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import { ProviderSwitchServiceV2 } from "../orchestration-v2/ProviderSwitchService.ts";
import {
  isActiveRun,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

type ConfigurationSetting = ConversationConfigurationChange["setting"];
type ConfigurationCommand = Extract<
  OrchestrationV2Command,
  {
    readonly type:
      | "thread.model-selection.set"
      | "provider.switch"
      | "thread.runtime-mode.set"
      | "thread.interaction-mode.set";
  }
>;
type ConfigurationCommandType = ConfigurationCommand["type"];
type SelectionCommandType = Extract<
  ConfigurationCommandType,
  "thread.model-selection.set" | "provider.switch"
>;

export class ConversationConfigurationMcpService extends Context.Service<
  ConversationConfigurationMcpService,
  {
    readonly read: (
      scope: McpInvocationScope,
      input: ConversationConfigurationInput,
    ) => Effect.Effect<ConversationConfigurationResult, OrchestratorMcpFailure>;
    readonly configure: (
      scope: McpInvocationScope,
      input: ConversationConfigureInput,
    ) => Effect.Effect<ConversationConfigureResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ConversationConfigurationMcpService") {}

const isThreadNotFound = Schema.is(ThreadManagementThreadNotFoundError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

const runtimeModes: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const interactionModes: ReadonlyArray<ProviderInteractionMode> = ["plan", "default"];

function providerConstraints(provider: ServerProvider): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!isBuiltInProviderAdapterDriverV2(provider.driver)) {
    constraints.push("No V2 provider adapter is registered.");
  }
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

function providerSummary(provider: ServerProvider): ConversationConfigurationProvider {
  const constraints = providerConstraints(provider);
  return {
    providerInstanceId: provider.instanceId,
    driverKind: provider.driver,
    displayName: provider.displayName ?? null,
    selectable: constraints.length === 0,
    constraints: [...constraints],
    models: provider.models.map((model) => ({
      id: model.slug,
      label: model.name ?? null,
      options: [...(model.capabilities?.optionDescriptors ?? [])],
    })),
  };
}

function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  if (selections.length > 0 && descriptors === undefined) {
    return ["The selected model does not advertise configurable options."];
  }
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

function selectionSummary(
  projection: OrchestrationV2ThreadProjection,
  providers: ReadonlyArray<ServerProvider>,
): ConversationConfigurationSelection {
  const selection = projection.thread.modelSelection;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const session = projection.providerSessions.find(
    (candidate) => candidate.providerInstanceId === selection.instanceId,
  );
  return {
    providerInstanceId: selection.instanceId,
    driverKind: provider?.driver ?? session?.driver ?? null,
    model: selection.model,
    options: [...(selection.options ?? [])],
  };
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly requestKey: string;
  readonly operation: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.providerSessionId),
      stablePart(input.threadId),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function receipt(
  command: ConfigurationCommand,
  acceptedCommandType: ConfigurationCommandType,
  result: OrchestratorV2DispatchResult,
): ConversationConfigurationReceipt {
  return {
    commandId: command.commandId,
    commandType: acceptedCommandType,
    sequence: result.sequence,
    eventIds: result.storedEvents.map((stored) => stored.event.id),
  };
}

function requestedEffects(
  result: OrchestratorV2DispatchResult,
): ConversationConfigurationChange["requestedEffects"] {
  return result.storedEvents.some((stored) => stored.event.type === "provider-session.detached")
    ? ["provider_session_detach"]
    : [];
}

function committedBehavior(
  acceptedCommandType: ConfigurationCommandType,
  result: OrchestratorV2DispatchResult,
): ConversationConfigurationBehavior {
  if (result.storedEvents.length === 0) return "unchanged";
  if (acceptedCommandType === "provider.switch") return "handoff_required_next_turn";
  if (requestedEffects(result).length > 0) return "session_detach_requested";
  return "next_turn";
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry;
  const providerSwitch = yield* ProviderSwitchServiceV2;
  const commandReceipts = yield* CommandReceiptStoreV2;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(failure("capability_denied", "This MCP credential cannot control threads."));

  const loadScoped = Effect.fn("ConversationConfigurationMcpService.loadScoped")(function* (
    scope: McpInvocationScope,
    requestedThreadId: ThreadId | undefined,
  ) {
    yield* requireCapability(scope);
    const parent = yield* threads
      .getThreadProjection(scope.threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to load the calling thread: ${errorMessage(error)}`,
          ),
        ),
      );
    const threadId = requestedThreadId ?? scope.threadId;
    const target = yield* threads
      .getProjectThread({ projectId: parent.thread.projectId, threadId })
      .pipe(
        Effect.mapError((error) =>
          isThreadNotFound(error)
            ? failure(
                "thread_not_found",
                `Thread ${threadId} was not found in the calling project.`,
              )
            : failure(
                "orchestration_error",
                `Unable to load thread ${threadId}: ${errorMessage(error)}`,
              ),
        ),
      );
    return { parent, target };
  });

  const configurationResult = (
    parent: OrchestrationV2ThreadProjection,
    target: OrchestrationV2ThreadProjection,
    providers: ReadonlyArray<ServerProvider>,
  ): ConversationConfigurationResult => ({
    threadId: target.thread.id,
    selection: selectionSummary(target, providers),
    runtimeMode: target.thread.runtimeMode,
    interactionMode: target.thread.interactionMode,
    allowedRuntimeModes: runtimeModes.filter(
      (mode) => runtimeModeRank(mode) <= runtimeModeRank(parent.thread.runtimeMode),
    ),
    allowedInteractionModes: interactionModes.filter(
      (mode) => interactionModeRank(mode) <= interactionModeRank(parent.thread.interactionMode),
    ),
    providers: providers.map(providerSummary),
  });

  const resolveSelection = Effect.fn("ConversationConfigurationMcpService.resolveSelection")(
    function* (
      current: ModelSelection,
      input: ConversationConfigureInput,
      providers: ReadonlyArray<ServerProvider>,
    ) {
      const instanceId = input.providerInstanceId ?? current.instanceId;
      const provider = providers.find((candidate) => candidate.instanceId === instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is unavailable.`,
        );
      }
      const constraints = providerConstraints(provider);
      if (constraints.length > 0) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is unavailable: ${constraints.join(" ")}`,
        );
      }
      const sameProvider = instanceId === current.instanceId;
      const model =
        input.model ??
        (sameProvider
          ? current.model
          : (provider.models.find((candidate) => candidate.isDefault)?.slug ??
            provider.models[0]?.slug));
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Provider instance ${instanceId} did not advertise a default model.`,
        );
      }
      const advertisedModel = provider.models.find((candidate) => candidate.slug === model);
      if (provider.models.length > 0 && advertisedModel === undefined) {
        return yield* failure(
          "model_unavailable",
          `Model ${model} is not advertised by provider instance ${instanceId}.`,
        );
      }
      const sameModel = sameProvider && model === current.model;
      const selectedOptions =
        input.options === undefined ? (sameModel ? current.options : undefined) : input.options;
      const optionProblems =
        input.options === undefined && sameModel
          ? []
          : invalidOptionSelections(
              selectedOptions ?? [],
              advertisedModel?.capabilities?.optionDescriptors,
            );
      if (optionProblems.length > 0) {
        return yield* failure("invalid_request", optionProblems.join(" "));
      }
      return selectedOptions === undefined
        ? ({ instanceId, model } satisfies ModelSelection)
        : ({ instanceId, model, options: selectedOptions } satisfies ModelSelection);
    },
  );

  return ConversationConfigurationMcpService.of({
    read: (scope, input) =>
      Effect.gen(function* () {
        const { parent, target } = yield* loadScoped(scope, input.threadId);
        const providers = yield* providerRegistry.getProviders;
        return configurationResult(parent, target, providers);
      }),
    configure: (scope, input) =>
      Effect.gen(function* () {
        const { parent, target } = yield* loadScoped(scope, input.threadId);
        const policyCeiling = {
          callerThreadId: parent.thread.id,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
        } satisfies OrchestrationV2PolicyCeiling;
        const selectionRequested =
          input.providerInstanceId !== undefined ||
          input.model !== undefined ||
          input.options !== undefined;
        const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const replayableRequest = input.clientRequestId !== undefined;
        const selectionCommandId = selectionRequested
          ? stableCommandId({
              scope,
              threadId: target.thread.id,
              requestKey,
              operation: "thread-configure-selection",
            })
          : undefined;
        const runtimeCommandId =
          input.runtimeMode === undefined
            ? undefined
            : stableCommandId({
                scope,
                threadId: target.thread.id,
                requestKey,
                operation: "thread-configure-runtime-mode",
              });
        const interactionCommandId =
          input.interactionMode === undefined
            ? undefined
            : stableCommandId({
                scope,
                threadId: target.thread.id,
                requestKey,
                operation: "thread-configure-interaction-mode",
              });
        const acceptedReceipt = (commandId: CommandId | undefined, commandTypes: Set<string>) =>
          commandId !== undefined && replayableRequest
            ? commandReceipts.getByCommandId(commandId).pipe(
                Effect.map(
                  Option.filter(
                    (existing) =>
                      existing.status === "accepted" &&
                      existing.threadId === target.thread.id &&
                      commandTypes.has(existing.commandType),
                  ),
                ),
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to inspect the configuration retry receipt: ${errorMessage(error)}`,
                  ),
                ),
              )
            : Effect.succeed(Option.none());
        const priorSelectionReceipt = yield* acceptedReceipt(
          selectionCommandId,
          new Set(["thread.model-selection.set", "provider.switch"]),
        );
        const priorRuntimeReceipt = yield* acceptedReceipt(
          runtimeCommandId,
          new Set(["thread.runtime-mode.set"]),
        );
        const priorInteractionReceipt = yield* acceptedReceipt(
          interactionCommandId,
          new Set(["thread.interaction-mode.set"]),
        );
        const hasFreshSelection = selectionRequested && Option.isNone(priorSelectionReceipt);
        const hasFreshRuntime =
          input.runtimeMode !== undefined && Option.isNone(priorRuntimeReceipt);
        const hasFreshInteraction =
          input.interactionMode !== undefined && Option.isNone(priorInteractionReceipt);
        if (hasFreshSelection || hasFreshRuntime || hasFreshInteraction) {
          const prospectiveRuntimeMode = hasFreshRuntime
            ? input.runtimeMode
            : target.thread.runtimeMode;
          const prospectiveInteractionMode = hasFreshInteraction
            ? input.interactionMode
            : target.thread.interactionMode;
          if (
            prospectiveRuntimeMode !== undefined &&
            runtimeModeRank(prospectiveRuntimeMode) > runtimeModeRank(parent.thread.runtimeMode)
          ) {
            return yield* failure(
              "runtime_mode_escalation_denied",
              `Runtime mode ${prospectiveRuntimeMode} is broader than the calling thread's ${parent.thread.runtimeMode} ceiling.`,
            );
          }
          if (
            prospectiveInteractionMode !== undefined &&
            interactionModeRank(prospectiveInteractionMode) >
              interactionModeRank(parent.thread.interactionMode)
          ) {
            return yield* failure(
              "interaction_mode_escalation_denied",
              `Interaction mode ${prospectiveInteractionMode} is broader than the calling thread's ${parent.thread.interactionMode} ceiling.`,
            );
          }
        }
        const providers = yield* providerRegistry.getProviders;
        const targetSelection =
          selectionRequested && Option.isNone(priorSelectionReceipt)
            ? yield* resolveSelection(target.thread.modelSelection, input, providers)
            : target.thread.modelSelection;
        const selectionChanged = !modelSelectionsEqual(
          target.thread.modelSelection,
          targetSelection,
        );
        if (selectionChanged && Option.isNone(priorSelectionReceipt)) {
          yield* providerSwitch
            .plan({ projection: target, targetModelSelection: targetSelection })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "provider_unavailable",
                  `The requested provider selection cannot be applied: ${errorMessage(error.cause ?? error)}`,
                ),
              ),
            );
        }

        const pending: Array<{
          readonly setting: ConfigurationSetting;
          readonly acceptedCommandType: ConfigurationCommandType;
          readonly command: ConfigurationCommand;
        }> = [];
        const changes: Array<ConversationConfigurationChange> = [];
        if (selectionRequested) {
          if (selectionCommandId === undefined) {
            return yield* Effect.die(new Error("Selection command id was not initialized"));
          }
          const commandId = selectionCommandId;
          const acceptedCommandType: SelectionCommandType = Option.match(priorSelectionReceipt, {
            onNone: () =>
              targetSelection.instanceId === target.thread.modelSelection.instanceId
                ? ("thread.model-selection.set" as const)
                : ("provider.switch" as const),
            onSome: (existing) => existing.commandType as SelectionCommandType,
          });
          const command = {
            type: acceptedCommandType,
            commandId,
            threadId: target.thread.id,
            modelSelection: targetSelection,
            policyCeiling,
            ...(Option.isNone(priorSelectionReceipt) &&
            (input.providerInstanceId === undefined ||
              input.model === undefined ||
              input.options === undefined)
              ? { expectedModelSelection: target.thread.modelSelection }
              : {}),
          } satisfies ConfigurationCommand;
          if (!selectionChanged && !replayableRequest) {
            changes.push({
              setting: "selection",
              behavior: "unchanged",
              requestedEffects: [],
              receipt: null,
            });
          } else {
            pending.push({
              setting: "selection",
              acceptedCommandType,
              command,
            });
          }
        }
        if (input.runtimeMode !== undefined) {
          if (runtimeCommandId === undefined) {
            return yield* Effect.die(new Error("Runtime command id was not initialized"));
          }
          const command = {
            type: "thread.runtime-mode.set" as const,
            commandId: runtimeCommandId,
            threadId: target.thread.id,
            runtimeMode: input.runtimeMode,
            policyCeiling,
          };
          const preflightUnchanged =
            Option.isNone(priorRuntimeReceipt) && input.runtimeMode === target.thread.runtimeMode;
          if (preflightUnchanged && !replayableRequest) {
            changes.push({
              setting: "runtime_mode",
              behavior: "unchanged",
              requestedEffects: [],
              receipt: null,
            });
          } else {
            pending.push({
              setting: "runtime_mode",
              acceptedCommandType: "thread.runtime-mode.set",
              command,
            });
          }
        }
        if (input.interactionMode !== undefined) {
          if (interactionCommandId === undefined) {
            return yield* Effect.die(new Error("Interaction command id was not initialized"));
          }
          const command = {
            type: "thread.interaction-mode.set" as const,
            commandId: interactionCommandId,
            threadId: target.thread.id,
            interactionMode: input.interactionMode,
            policyCeiling,
          };
          const preflightUnchanged =
            Option.isNone(priorInteractionReceipt) &&
            input.interactionMode === target.thread.interactionMode;
          if (preflightUnchanged && !replayableRequest) {
            changes.push({
              setting: "interaction_mode",
              behavior: "unchanged",
              requestedEffects: [],
              receipt: null,
            });
          } else {
            pending.push({
              setting: "interaction_mode",
              acceptedCommandType: "thread.interaction-mode.set",
              command,
            });
          }
        }

        const targetAboveCallerCeiling =
          runtimeModeRank(target.thread.runtimeMode) > runtimeModeRank(parent.thread.runtimeMode) ||
          interactionModeRank(target.thread.interactionMode) >
            interactionModeRank(parent.thread.interactionMode);
        const dispatchPriority = (change: (typeof pending)[number]) => {
          if (!targetAboveCallerCeiling) return 0;
          if (
            change.command.type === "thread.runtime-mode.set" &&
            runtimeModeRank(change.command.runtimeMode) < runtimeModeRank(target.thread.runtimeMode)
          ) {
            return -1;
          }
          if (
            change.command.type === "thread.interaction-mode.set" &&
            interactionModeRank(change.command.interactionMode) <
              interactionModeRank(target.thread.interactionMode)
          ) {
            return -1;
          }
          return 0;
        };
        const dispatchOrder = [...pending].sort(
          (left, right) => dispatchPriority(left) - dispatchPriority(right),
        );
        const errors: Array<{ setting: ConfigurationSetting; message: string }> = [];
        for (const change of dispatchOrder) {
          const dispatched = yield* Effect.result(threads.dispatch(change.command));
          if (Result.isFailure(dispatched)) {
            errors.push({ setting: change.setting, message: errorMessage(dispatched.failure) });
            break;
          }
          const effects = requestedEffects(dispatched.success);
          changes.push({
            setting: change.setting,
            behavior: committedBehavior(change.acceptedCommandType, dispatched.success),
            requestedEffects: effects,
            receipt: receipt(change.command, change.acceptedCommandType, dispatched.success),
          });
        }
        const settingOrder: ReadonlyArray<ConfigurationSetting> = [
          "selection",
          "runtime_mode",
          "interaction_mode",
        ];
        const presentedChanges = [...changes].sort(
          (left, right) => settingOrder.indexOf(left.setting) - settingOrder.indexOf(right.setting),
        );
        const appliedCount = presentedChanges.filter((change) => change.receipt !== null).length;
        const changedCount = presentedChanges.filter(
          (change) => change.receipt !== null && change.behavior !== "unchanged",
        ).length;
        if (errors.length > 0 && appliedCount === 0) {
          return yield* failure("orchestration_error", errors[0]!.message);
        }

        const refreshed = yield* Effect.option(threads.getThreadProjection(target.thread.id));
        const projected = refreshed._tag === "Some" ? refreshed.value : target;
        return {
          threadId: target.thread.id,
          outcome:
            errors.length > 0 ? "partially_applied" : changedCount === 0 ? "unchanged" : "applied",
          observation: refreshed._tag === "Some" ? "post_dispatch" : "pre_dispatch_fallback",
          selection: selectionSummary(projected, providers),
          runtimeMode: projected.thread.runtimeMode,
          interactionMode: projected.thread.interactionMode,
          activeRunIds: projected.runs.filter(isActiveRun).map((run) => run.id),
          queuedRunIds: projected.runs
            .filter((run) => run.status === "queued")
            .map((run) => run.id),
          changes: presentedChanges,
          errors,
          retryGuidance: {
            sameClientRequestId: "replays_durable_decisions",
            afterRejectedLeg: "use_new_client_request_id",
          },
        } satisfies ConversationConfigureResult;
      }),
  });
});

export const layer: Layer.Layer<
  ConversationConfigurationMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService
  | ProviderRegistry
  | ProviderSwitchServiceV2
  | CommandReceiptStoreV2
> = Layer.effect(ConversationConfigurationMcpService, make);
