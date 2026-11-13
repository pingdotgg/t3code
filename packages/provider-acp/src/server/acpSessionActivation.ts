// ACP session behaviour extracted from server/adapter.ts (sessionActivation).

import {
  flattenSelectChoices,
  ACP_SESSION_MODE_OPTION_ID,
  ACP_EMPTY_OPTION_VALUE,
} from "./sessionConfig.ts";
import {
  negotiatedCapabilities,
  acpSupportsImagePrompts,
  acpMcpActivation,
} from "./acpThreadContext.ts";
import { findModelConfigOption } from "./runtimeModel.ts";
import { isAcpPlanModeId } from "./acpToolCallProjection.ts";
import { isRuntimeModeAbove, type ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AcpSessionCtx17 } from "./acpSessionContext.ts";

class AcpModelSelectionError extends Schema.TaggedError<AcpModelSelectionError>()(
  "AcpModelSelectionError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The agent did not accept the model "${this.model}". Choose another model for this provider, then retry.`;
  }
}

export const createAcpSessionActivation = Effect.fn("acpSession.sessionActivation")(function* (ctx: AcpSessionCtx17) {
  const initialStart = yield* Effect.result(
    ctx.startAcpRuntime(ctx.input.threadId, ctx.input.initialNativeThreadId),
  );
  const started = Result.isSuccess(initialStart)
    ? initialStart.success
    : yield* Effect.gen(function* () {
        const failedMethod =
          "method" in initialStart.failure ? initialStart.failure.method : undefined;
        if (
          ctx.input.initialNativeThreadId === undefined ||
          (failedMethod !== "session/load" && failedMethod !== "session/resume")
        ) {
          return yield* initialStart.failure;
        }
        yield* Ref.set(ctx.initialSessionActivationFailure, {
          sessionId: ctx.input.initialNativeThreadId,
          error: initialStart.failure,
        });
        ctx.itemIdentityVersion = 2;
        yield* Ref.set(ctx.runtimeRestartRequired, false);
        ctx.prepareClaimableTerminalEnvironment(yield* ctx.readMcpContext(ctx.input.threadId));
        return yield* ctx.startAcpRuntime(ctx.input.threadId);
      });
  yield* Ref.set(ctx.activeSessionId, started.sessionId);
  yield* ctx.setActiveSessionSetup(started);
  ctx.rememberTerminalEnvironment(started.sessionId, yield* ctx.readMcpContext(ctx.input.threadId));
  const capabilities = negotiatedCapabilities(
    ctx.flavor.capabilities,
    started,
    ctx.flavor.modelOptionArrivesLate === true,
    ctx.flavor.forkFromTurn?.supported(started.initializeResult) === true,
  );
  const canLoadSession = started.initializeResult.agentCapabilities?.loadSession === true;
  const canResumeSession =
    started.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
  const supportsImagePrompts = acpSupportsImagePrompts({
    flavorSupportsImagePrompts: ctx.flavor.supportsImagePrompts,
    negotiatedImage:
      started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
  });
  const activateSession = Effect.fnUntraced(function* (
    sessionId: string,
    threadId: ThreadId | null,
  ) {
    const initialFailure = yield* Ref.modify(ctx.initialSessionActivationFailure, (failure) =>
      failure?.sessionId === sessionId ? [failure.error, null] : [undefined, failure],
    );
    if (initialFailure !== undefined) {
      return yield* initialFailure;
    }
    const mcpContext = yield* ctx.readMcpContext(threadId);
    const activationOptions = acpMcpActivation(mcpContext);
    ctx.prepareTerminalEnvironment(mcpContext, sessionId);
    const activated = canLoadSession
      ? yield* ctx.runtime.loadSession(sessionId, activationOptions)
      : canResumeSession
        ? yield* ctx.runtime.resumeSession(sessionId, activationOptions)
        : yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ctx.driver,
            detail: `ACP driver cannot load or resume session ${sessionId}`,
          });
    ctx.rememberTerminalEnvironment(activated.sessionId, yield* ctx.readMcpContext(threadId));
    return activated;
  });
  const validateModelSelection = Effect.fn("AcpAdapterV2.validateModelSelection")(function* (
    modelSelection: ModelSelection,
  ) {
    const model = ctx.flavor.resolveModelId?.(modelSelection) ?? modelSelection.model;
    if (
      ctx.flavor.applyModelSelection !== undefined ||
      model.length === 0 ||
      model === "default" ||
      model === "auto" ||
      ctx.flavor.customModels?.includes(model) === true
    )
      return;
    const option = findModelConfigOption(yield* ctx.runtime.getConfigOptions);
    const models = (yield* Ref.get(ctx.activeSessionSetup))?.sessionSetupResult.models;
    const available =
      option?.type === "select"
        ? flattenSelectChoices(option.options).some((choice) => choice.value === model)
        : models?.availableModels.some((choice) => choice.modelId === model);
    if (available === false) {
      return yield* new AcpModelSelectionError({
        model: modelSelection.model,
        cause: EffectAcpErrors.AcpRequestError.invalidParams(
          "The requested model is not available in this session.",
        ),
      });
    }
  });
  const configureSession = Effect.fnUntraced(function* (
    startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    modelSelection: ModelSelection,
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) {
    yield* Ref.set(ctx.activeSelection, null);
    yield* validateModelSelection(modelSelection);
    const requestedModel = ctx.flavor.resolveModelId?.(modelSelection) ?? modelSelection.model;
    // Invalid params is the agent refusing the value, and the runtime
    // raises the same code when the session's model option does not offer
    // it. Other failures, such as sign-in or a lost connection, keep their
    // own error.
    const rejectedModel = (error: EffectAcpErrors.AcpError) =>
      error._tag === "AcpRequestError" && error.code === -32602
        ? new AcpModelSelectionError({ model: modelSelection.model, cause: error })
        : error;
    let appliedModel: string | undefined;
    if (ctx.flavor.applyModelSelection !== undefined) {
      appliedModel = yield* ctx.flavor
        .applyModelSelection({
          runtime: ctx.runtime,
          startResult,
          modelSelection,
        })
        .pipe(Effect.mapError(rejectedModel));
    } else if (requestedModel.length > 0) {
      // Stored catalog choices can expire; explicitly configured custom IDs
      // are validated by the agent instead.
      const isCustomModel = ctx.flavor.customModels?.includes(requestedModel) === true;
      const modelOption = findModelConfigOption(yield* ctx.runtime.getConfigOptions);
      const modelState = startResult.sessionSetupResult.models;
      if (modelOption?.type === "select") {
        if (
          isCustomModel ||
          flattenSelectChoices(modelOption.options).some(
            (choice) => choice.value === requestedModel,
          )
        ) {
          yield* ctx.runtime
            .setConfigOption(modelOption.id, requestedModel)
            .pipe(Effect.mapError(rejectedModel));
          appliedModel = requestedModel;
        }
      } else if (
        modelState != null &&
        (isCustomModel ||
          modelState.availableModels.some((model) => model.modelId === requestedModel))
      ) {
        if (modelState.currentModelId !== requestedModel) {
          yield* ctx.runtime.setSessionModel(requestedModel).pipe(Effect.mapError(rejectedModel));
        }
        appliedModel = requestedModel;
      }
    }
    if (appliedModel !== undefined) {
      const applied = appliedModel;
      yield* Ref.update(ctx.activeSessionSetup, (setup) => {
        if (setup === null) {
          return setup;
        }
        const models = setup.sessionSetupResult.models;
        if (models == null || models.currentModelId === applied) {
          return setup;
        }
        return {
          ...setup,
          sessionSetupResult: {
            ...setup.sessionSetupResult,
            models: { ...models, currentModelId: applied },
          },
        };
      });
    }
    const configOptions = yield* ctx.runtime.getConfigOptions;
    // Under a policy ceiling, a mode the user picks applies only when the flavor can place
    // it under the ceiling; an unknown mode could be the agent's own skip-approval mode.
    const ceiling = runtimePolicy.maxRuntimeMode;
    const isModeChoice = (id: string) =>
      id === ACP_SESSION_MODE_OPTION_ID ||
      configOptions.some(
        (option) =>
          option.id === id &&
          (option.category === "mode" || option.category === "collaboration_mode"),
      );
    const withinCeiling = (selection: { readonly id: string; readonly value: unknown }) => {
      if (ceiling === undefined || ceiling === "full-access" || !isModeChoice(selection.id)) {
        return true;
      }
      const granted =
        typeof selection.value === "string"
          ? ctx.flavor.runtimeModeForSessionMode?.(selection.value)
          : undefined;
      return granted !== undefined && !isRuntimeModeAbove(granted, ceiling);
    };
    const optionSelections = (modelSelection.options ?? []).flatMap((selection) => {
      if (ctx.flavor.ownedModelOptionIds?.includes(selection.id) === true) return [];
      if (!withinCeiling(selection)) return [];
      return [
        selection.value === ACP_EMPTY_OPTION_VALUE ? { ...selection, value: "" } : selection,
      ];
    });
    const availableConfigIds = new Set(configOptions.map((option) => option.id));
    const hasNativeConfigWithSyntheticModeId = availableConfigIds.has(
      ACP_SESSION_MODE_OPTION_ID,
    );
    const modeSelection = hasNativeConfigWithSyntheticModeId
      ? undefined
      : optionSelections.find((selection) => selection.id === ACP_SESSION_MODE_OPTION_ID);
    const configSelections = hasNativeConfigWithSyntheticModeId
      ? optionSelections
      : optionSelections.filter((selection) => selection.id !== ACP_SESSION_MODE_OPTION_ID);
    // Probe descriptors union models; skip options absent from the live session and use agent defaults.
    const unsupportedConfigIds = configSelections
      .map((selection) => selection.id)
      .filter((id) => !availableConfigIds.has(id));
    if (unsupportedConfigIds.length > 0) {
      yield* Effect.logWarning(
        "ACP session does not expose requested configuration option(s)",
        {
          driver: ctx.driver,
          sessionId: startResult.sessionId,
          optionIds: unsupportedConfigIds,
        },
      );
    }
    for (const selection of configSelections) {
      if (!availableConfigIds.has(selection.id)) continue;
      // Advertised values union models; skip per-model rejections instead of failing session open.
      const option = configOptions.find((candidate) => candidate.id === selection.id);
      if (
        option !== undefined &&
        option.type === "select" &&
        typeof selection.value === "string"
      ) {
        const advertisedValues = option.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
        );
        if (!advertisedValues.includes(selection.value)) continue;
      }
      yield* ctx.runtime.setConfigOption(selection.id, selection.value).pipe(
        Effect.catchTags({
          AcpRequestError: (error) =>
            Effect.logWarning("ACP session rejected a configuration option value", {
              optionId: selection.id,
              value: selection.value,
              detail: error.message,
            }),
        }),
      );
    }
    for (const selection of ctx.flavor.sessionConfigForPolicy?.(runtimePolicy) ?? []) {
      const option = (yield* ctx.runtime.getConfigOptions).find(
        (candidate) => candidate.id === selection.id,
      );
      if (option?.type !== "select" || option.currentValue === selection.value) continue;
      const advertisedValues = option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      );
      if (!advertisedValues.includes(selection.value)) continue;
      yield* ctx.runtime.setConfigOption(selection.id, selection.value);
    }
    const policyMode = ctx.flavor.sessionModeForPolicy?.(runtimePolicy);
    if (policyMode !== undefined) {
      yield* ctx.runtime.setMode(policyMode);
    }
    const modeState = yield* ctx.runtime.getModeState;
    if (
      modeSelection !== undefined &&
      typeof modeSelection.value === "string" &&
      modeState?.availableModes.some((mode) => mode.id === modeSelection.value) === true &&
      modeState.currentModeId !== modeSelection.value
    ) {
      yield* ctx.runtime.setMode(modeSelection.value);
    }
    const effectiveModeState = yield* ctx.runtime.getModeState;
    const effectiveConfigOptions = yield* ctx.runtime.getConfigOptions;
    const planSensitiveOptions = effectiveConfigOptions.filter(
      (
        option,
      ): option is Extract<
        EffectAcpSchema.SessionConfigOption,
        { readonly type: "select" }
      > =>
        option.type === "select" &&
        (option.category === "mode" || option.category === "collaboration_mode"),
    );
    if (runtimePolicy.interactionMode === "plan") {
      if (!ctx.nativeBuildConfigurationBySessionId.has(startResult.sessionId)) {
        ctx.nativeBuildConfigurationBySessionId.set(startResult.sessionId, {
          ...(effectiveModeState === undefined
            ? {}
            : { modeId: effectiveModeState.currentModeId }),
          configOptions: planSensitiveOptions.map((option) => ({
            id: option.id,
            value: option.currentValue,
          })),
        });
      }
      const planMode = effectiveModeState?.availableModes.find((mode) =>
        isAcpPlanModeId(mode.id),
      );
      if (planMode !== undefined && effectiveModeState?.currentModeId !== planMode.id) {
        yield* ctx.runtime.setMode(planMode.id);
      }
      for (const option of planSensitiveOptions) {
        const choices = option.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
        );
        const requested = choices.find(isAcpPlanModeId);
        if (requested !== undefined && option.currentValue !== requested) {
          yield* ctx.runtime.setConfigOption(option.id, requested);
        }
      }
    } else {
      const nativeBuild = ctx.nativeBuildConfigurationBySessionId.get(startResult.sessionId);
      if (nativeBuild !== undefined) {
        if (
          nativeBuild.modeId !== undefined &&
          effectiveModeState?.currentModeId !== nativeBuild.modeId &&
          effectiveModeState?.availableModes.some(
            (mode) => mode.id === nativeBuild.modeId,
          ) === true
        ) {
          yield* ctx.runtime.setMode(nativeBuild.modeId);
        }
        for (const saved of nativeBuild.configOptions) {
          const option = effectiveConfigOptions.find(
            (candidate) => candidate.type === "select" && candidate.id === saved.id,
          );
          if (option === undefined || option.type !== "select") continue;
          const choices = option.options.flatMap((entry) =>
            "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
          );
          if (option.currentValue !== saved.value && choices.includes(saved.value)) {
            yield* ctx.runtime.setConfigOption(option.id, saved.value);
          }
        }
        ctx.nativeBuildConfigurationBySessionId.delete(startResult.sessionId);
      }
    }
    yield* validateModelSelection(modelSelection);
    yield* (
      ctx.flavor.onSessionConfigurationUpdate?.(
        yield* ctx.runtime.getConfigOptions,
        yield* ctx.runtime.getModeState,
        (yield* Ref.get(ctx.activeSessionSetup))?.sessionSetupResult.models,
      ) ?? Effect.void
    );
  });
  return {
    initialStart,
    started,
    capabilities,
    canLoadSession,
    canResumeSession,
    supportsImagePrompts,
    activateSession,
    validateModelSelection,
    configureSession,
  };
});
