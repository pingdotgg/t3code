import { type DevinSettings, type ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue, normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
  isModelConfigOption,
} from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DEVIN_AUTH_METHOD_ID = "devin-browser";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

const DEVIN_REASONING_CONFIG_OPTION_IDS = new Set(
  ["effort", "thought_level", "reasoning"].map((id) => normalizeConfigIdToken(id)),
);
const DEVIN_MODEL_NAME_VARIANT_TOKENS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "x-high",
  "max",
  "minimal",
  "thinking",
  "fast",
  "priority",
  "1m",
  "200k",
  "1000k",
  "1000000",
]);

type DevinAcpRuntimeDevinSettings = Pick<
  DevinSettings,
  | "agentType"
  | "binaryPath"
  | "configPath"
  | "homePath"
  | "launchArgs"
  | "permissionMode"
  | "respectWorkspaceTrust"
  | "sandbox"
>;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "authenticationMode" | "clientCapabilities" | "isAuthenticationFailure" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function isDevinAuthenticationFailure(error: EffectAcpErrors.AcpError): boolean {
  if (error._tag !== "AcpRequestError") {
    return false;
  }
  return (
    /authentication failed/i.test(error.errorMessage) &&
    /(?:authenticate to continue|\/login|log in)/i.test(error.errorMessage)
  );
}

export function buildDevinGlobalArgs(
  devinSettings: Pick<DevinSettings, "configPath"> | null | undefined,
): ReadonlyArray<string> {
  const configPath = devinSettings?.configPath?.trim();
  return configPath ? ["--config", expandHomePath(configPath)] : [];
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const agentType = devinSettings?.agentType ?? "default";
  const args: string[] = [
    ...buildDevinGlobalArgs(devinSettings),
    ...(devinSettings?.sandbox ? ["--sandbox"] : []),
    ...(devinSettings?.respectWorkspaceTrust === false
      ? ["--respect-workspace-trust", "false"]
      : []),
    "acp",
    ...(agentType === "default" ? [] : ["--agent-type", agentType]),
    ...tokenizeCliArgs(devinSettings?.launchArgs),
  ];

  const env: NodeJS.ProcessEnv = { ...environment };
  env.DEVIN_PERMISSION_MODE = devinSettings?.permissionMode?.trim() || "normal";

  return {
    command: devinSettings?.binaryPath || "devin",
    args,
    cwd,
    env,
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: DEVIN_AUTH_METHOD_ID,
        authenticationMode: "on-demand",
        isAuthenticationFailure: isDevinAuthenticationFailure,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const base = model?.trim() || "adaptive";
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? base;
}

export interface DevinAcpModelSelection {
  readonly familySlug: string;
  readonly reasoningValue: string | undefined;
}

export function resolveDevinAcpModelSelection(
  modelSelection: ModelSelection | null | undefined,
): DevinAcpModelSelection | undefined {
  if (!modelSelection) {
    return undefined;
  }
  const familySlug = resolveDevinAcpBaseModelId(modelSelection.model);
  const reasoningValue = getModelSelectionStringOptionValue(modelSelection, "reasoning");
  return {
    familySlug,
    reasoningValue: reasoningValue?.trim() || undefined,
  };
}

function normalizeDevinReasoningVariant(variant: string): string {
  return variant
    .toLowerCase()
    .replace(/[./\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");
}

function expandDevinReasoningVariants(reasoningValue: string | undefined): ReadonlyArray<string> {
  if (!reasoningValue) {
    return [];
  }
  const normalized = normalizeDevinReasoningVariant(reasoningValue);
  const variants = new Set<string>([normalized]);

  // `devin models list` describes choices as `medium-thinking` and
  // `medium-thinking-fast`, while ACP exposes those model suffixes as
  // `medium` and `medium-priority` respectively.
  const thinkingVariant = /^(no|low|medium|high|xhigh|max)-thinking(?:-(fast|priority))?$/.exec(
    normalized,
  );
  const thinkingEffort = thinkingVariant?.[1];
  if (thinkingVariant && thinkingEffort) {
    const effort = thinkingEffort === "no" ? "none" : thinkingEffort;
    if (thinkingVariant[2]) {
      variants.add(`${effort}-priority`);
      variants.add(`${effort}-fast`);
    }
    variants.add(effort);
  }

  // Common Devin reasoning labels do not always map 1:1 to ACP model slugs.
  // Add synonyms so the picker can match the variant advertised by the agent.
  if (normalized === "no-thinking" || normalized === "none") {
    variants.add("none");
    variants.add("no-thinking");
  }
  if (normalized === "no-thinking-1m" || normalized === "none-1m" || normalized === "1m") {
    variants.add("1m");
    variants.add("none-1m");
    variants.add("no-thinking-1m");
  }
  if (normalized === "fast" || normalized === "priority") {
    variants.add("fast");
    variants.add("priority");
  }

  return Array.from(variants);
}

function normalizeConfigIdToken(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function resolveDevinDefaultReasoningValue(
  allowedReasoningValues: ReadonlyArray<string>,
): string | undefined {
  if (allowedReasoningValues.length === 0) {
    return undefined;
  }
  const clearValue = ["default", "none", "no-thinking"].find((variant) =>
    allowedReasoningValues.includes(variant),
  );
  return clearValue ?? allowedReasoningValues[0];
}

function isDevinReasoningConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.category === "thought_level") return true;
  const id = normalizeConfigIdToken(option.id);
  if (DEVIN_REASONING_CONFIG_OPTION_IDS.has(id)) return true;
  if (
    option.category !== undefined &&
    option.category !== null &&
    option.category !== "model_config"
  ) {
    return false;
  }
  const name = normalizeConfigIdToken(option.name);
  return /reasoning|effort|thinking/.test(name);
}

function findDevinAcpModelConfigId(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  if (!configOptions) return undefined;
  for (const option of configOptions) {
    if (isModelConfigOption(option)) {
      return option.id;
    }
  }
  return undefined;
}

function findDevinAcpReasoningConfigId(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  if (!configOptions) return undefined;
  for (const option of configOptions) {
    if (isDevinReasoningConfigOption(option)) {
      return option.id;
    }
  }
  return undefined;
}

function getConfigOptionCurrentValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string | undefined,
): string | undefined {
  if (!configId || !configOptions) return undefined;
  const option = findSessionConfigOption(configOptions, configId);
  if (!option || option.type !== "select") return undefined;
  return option.currentValue.trim() || undefined;
}

function parseDevinAcpModelChoiceName(name: string): {
  readonly familySlug: string;
  readonly reasoningValue: string | undefined;
} {
  const familyTokens = name.trim().split(/\s+/).filter(Boolean);
  const variantTokens: string[] = [];

  while (familyTokens.length > 1) {
    const rawLast = familyTokens[familyTokens.length - 1];
    if (!rawLast) break;
    const last = rawLast.toLowerCase().replace(/[,]/g, "");
    if (!DEVIN_MODEL_NAME_VARIANT_TOKENS.has(last)) break;

    familyTokens.pop();
    variantTokens.unshift(last);

    const previous = familyTokens[familyTokens.length - 1];
    if (last === "thinking" && previous?.toLowerCase() === "no") {
      familyTokens.pop();
      variantTokens.unshift("no");
    }
  }

  const familySlug = familyTokens
    .join(" ")
    .toLowerCase()
    .replace(/[.]/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");

  return {
    familySlug: resolveDevinAcpBaseModelId(familySlug),
    reasoningValue: variantTokens.length > 0 ? variantTokens.join("-") : undefined,
  };
}

function resolveDevinAcpModelValueByName(input: {
  readonly modelOption: EffectAcpSchema.SessionConfigOption;
  readonly requestedFamilySlug: string;
  readonly requestedReasoning: string | undefined;
  readonly configuredModel: string | undefined;
}): string | undefined {
  if (input.modelOption.type !== "select") return undefined;

  const choices = input.modelOption.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
  const familyChoices = choices.flatMap((choice) => {
    const parsed = parseDevinAcpModelChoiceName(choice.name);
    return parsed.familySlug === input.requestedFamilySlug
      ? [{ ...parsed, value: choice.value }]
      : [];
  });
  if (familyChoices.length === 0) return undefined;

  if (input.requestedReasoning !== undefined) {
    const requestedVariants = new Set(expandDevinReasoningVariants(input.requestedReasoning));
    return familyChoices.find(
      (choice) =>
        choice.reasoningValue !== undefined && requestedVariants.has(choice.reasoningValue),
    )?.value;
  }

  return (
    familyChoices.find((choice) => choice.reasoningValue === undefined)?.value ??
    familyChoices.find((choice) => choice.value === input.configuredModel)?.value ??
    familyChoices[0]?.value
  );
}

export function currentDevinAcpModelSelection(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): DevinAcpModelSelection | undefined {
  const configOptions = sessionSetupResult.configOptions;
  const modelConfigId = findDevinAcpModelConfigId(configOptions);
  const reasoningConfigId = findDevinAcpReasoningConfigId(configOptions);
  const familySlug = getConfigOptionCurrentValue(configOptions, modelConfigId);
  if (!familySlug) return undefined;
  return {
    familySlug,
    reasoningValue: getConfigOptionCurrentValue(configOptions, reasoningConfigId),
  };
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setConfigOption"
  >;
  readonly current: DevinAcpModelSelection | undefined;
  readonly requested: DevinAcpModelSelection | undefined;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<DevinAcpModelSelection | undefined, E> {
  if (!input.requested) {
    return Effect.succeed(input.current);
  }

  const requested = input.requested;
  const current = input.current;
  const modelConfigId = findDevinAcpModelConfigId(input.configOptions);
  const reasoningConfigId = findDevinAcpReasoningConfigId(input.configOptions);

  const requestedReasoningDefault = requested.reasoningValue === "default";
  const requestedReasoning =
    requested.reasoningValue === requested.familySlug || requestedReasoningDefault
      ? undefined
      : requested.reasoningValue;

  // Devin ACP commonly encodes reasoning as a model suffix instead of a
  // separate config option. In that shape, changing Medium -> High within the
  // same family still requires session/set_model.
  const needsEmbeddedReasoningSwitch =
    reasoningConfigId === undefined &&
    (requestedReasoningDefault
      ? current?.reasoningValue !== undefined
      : requestedReasoning !== undefined && requestedReasoning !== current?.reasoningValue);
  const needsModelSwitch =
    !current || requested.familySlug !== current.familySlug || needsEmbeddedReasoningSwitch;
  const needsReasoningSwitch =
    reasoningConfigId !== undefined &&
    (requestedReasoningDefault ||
      (requestedReasoning !== undefined && requestedReasoning !== current?.reasoningValue));

  if (!needsModelSwitch && !needsReasoningSwitch) {
    return Effect.succeed(current);
  }

  let resultReasoningValue: string | undefined = requestedReasoningDefault
    ? undefined
    : requested.reasoningValue;
  let resultFamilySlug = requested.familySlug;

  return Effect.gen(function* () {
    if (needsModelSwitch) {
      if (modelConfigId === undefined) {
        return yield* Effect.fail(
          input.mapError(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `Unable to set model: no model session config option was found`,
              data: {
                requestedModel: requested.familySlug,
                configOptions: input.configOptions.map((o) => o.id),
              },
            }),
          ),
        );
      }

      const modelOption = findSessionConfigOption(input.configOptions, modelConfigId);
      const allowedModelValues = modelOption ? collectSessionConfigOptionValues(modelOption) : [];
      const configuredModel = getConfigOptionCurrentValue(input.configOptions, modelConfigId);

      const variantCandidates: string[] = [];
      if (requestedReasoning !== undefined) {
        for (const variant of expandDevinReasoningVariants(requestedReasoning)) {
          variantCandidates.push(`${requested.familySlug}-${variant}`);
          variantCandidates.push(`${requested.familySlug}/${variant}`);
        }
      }
      const baseCandidates = [requested.familySlug];
      const modelValueByName = modelOption
        ? resolveDevinAcpModelValueByName({
            modelOption,
            requestedFamilySlug: requested.familySlug,
            requestedReasoning: reasoningConfigId === undefined ? requestedReasoning : undefined,
            configuredModel,
          })
        : undefined;

      const requestedModel =
        variantCandidates.find((candidate) => allowedModelValues.includes(candidate)) ??
        allowedModelValues.find((value) =>
          variantCandidates.some(
            (candidate) =>
              value.endsWith(`/${candidate}`) ||
              value.endsWith(`-${candidate}`) ||
              value === candidate,
          ),
        ) ??
        modelValueByName ??
        baseCandidates.find((candidate) => allowedModelValues.includes(candidate));

      // A composer can retain another provider's sticky model while the Devin
      // model list is still loading. Preserve Devin's live/default model in
      // that case instead of rejecting the entire turn.
      const fallbackModel = [current?.familySlug, configuredModel, "adaptive"].find(
        (candidate): candidate is string =>
          candidate !== undefined && allowedModelValues.includes(candidate),
      );
      const effectiveModel = requestedModel ?? fallbackModel;

      if (effectiveModel === undefined) {
        return yield* Effect.fail(
          input.mapError(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `Invalid model value "${requested.familySlug}" for session config option "${modelConfigId}"`,
              data: {
                configId: modelConfigId,
                receivedValue: requested.familySlug,
                allowedValues: allowedModelValues,
              },
            }),
          ),
        );
      }

      if (requestedModel === undefined) {
        resultFamilySlug = effectiveModel;
        resultReasoningValue =
          current?.reasoningValue ??
          getConfigOptionCurrentValue(input.configOptions, reasoningConfigId);

        if (effectiveModel !== current?.familySlug && effectiveModel !== configuredModel) {
          yield* input.runtime.setModel(effectiveModel).pipe(Effect.mapError(input.mapError));
        }

        return {
          familySlug: resultFamilySlug,
          reasoningValue: resultReasoningValue,
        };
      }

      yield* input.runtime.setModel(effectiveModel).pipe(Effect.mapError(input.mapError));
    }

    if (needsReasoningSwitch && reasoningConfigId !== undefined) {
      const reasoningOption = findSessionConfigOption(input.configOptions, reasoningConfigId);
      const allowedReasoningValues = reasoningOption
        ? collectSessionConfigOptionValues(reasoningOption)
        : [];
      const effectiveReasoning = requestedReasoningDefault
        ? resolveDevinDefaultReasoningValue(allowedReasoningValues)
        : requestedReasoning
          ? allowedReasoningValues.find((value) =>
              expandDevinReasoningVariants(requestedReasoning).some(
                (variant) => variant === value || variant.endsWith(`-${value}`),
              ),
            )
          : requestedReasoning;

      if (effectiveReasoning !== undefined) {
        yield* input.runtime
          .setConfigOption(reasoningConfigId, effectiveReasoning)
          .pipe(Effect.mapError(input.mapError));
        if (!requestedReasoningDefault) {
          resultReasoningValue = effectiveReasoning;
        }
      } else {
        resultReasoningValue =
          current?.reasoningValue ??
          getConfigOptionCurrentValue(input.configOptions, reasoningConfigId);
      }
    }

    return {
      familySlug: resultFamilySlug,
      reasoningValue: resultReasoningValue,
    };
  });
}

export function buildDevinDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<{ slug: string; name: string }> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model) => {
      const slug = resolveDevinAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
      };
    })
    .filter((model): model is { slug: string; name: string } => model !== undefined);
}
