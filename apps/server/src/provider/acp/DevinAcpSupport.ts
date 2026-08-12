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

import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_AUTH_METHOD_ID = "default";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

const DEVIN_MODEL_CONFIG_OPTION_IDS = new Set(["model", "models", "modelid", "modelids"]);

const DEVIN_REASONING_CONFIG_OPTION_IDS = new Set(["effort", "thought_level", "reasoning"]);

type DevinAcpRuntimeDevinSettings = Pick<
  DevinSettings,
  "binaryPath" | "homePath" | "launchArgs" | "permissionMode"
>;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const args: string[] = ["acp", ...tokenizeCliArgs(devinSettings?.launchArgs)];

  const env: NodeJS.ProcessEnv = { ...environment };
  const permissionMode = devinSettings?.permissionMode?.trim();
  if (permissionMode && permissionMode !== "normal") {
    env.DEVIN_PERMISSION_MODE = permissionMode;
  }

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
    .replace(/[.\/\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");
}

function expandDevinReasoningVariants(reasoningValue: string | undefined): ReadonlyArray<string> {
  if (!reasoningValue) {
    return [];
  }
  const normalized = normalizeDevinReasoningVariant(reasoningValue);
  const variants = new Set<string>([normalized]);

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

function isDevinModelConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.category === "model") return true;
  const id = normalizeConfigIdToken(option.id);
  return DEVIN_MODEL_CONFIG_OPTION_IDS.has(id);
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
    if (isDevinModelConfigOption(option)) {
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

  const requestedReasoning =
    requested.reasoningValue === requested.familySlug || requested.reasoningValue === "default"
      ? undefined
      : requested.reasoningValue;

  const needsModelSwitch = !current || requested.familySlug !== current.familySlug;
  const needsReasoningSwitch =
    reasoningConfigId !== undefined &&
    requestedReasoning !== undefined &&
    requestedReasoning !== current?.reasoningValue;

  if (!needsModelSwitch && !needsReasoningSwitch) {
    return Effect.succeed(current);
  }

  return Effect.gen(function* () {
    if (needsModelSwitch && modelConfigId !== undefined) {
      const modelOption = findSessionConfigOption(input.configOptions, modelConfigId);
      const allowedModelValues = modelOption ? collectSessionConfigOptionValues(modelOption) : [];

      const variantCandidates: string[] = [];
      if (requestedReasoning !== undefined) {
        for (const variant of expandDevinReasoningVariants(requestedReasoning)) {
          variantCandidates.push(`${requested.familySlug}-${variant}`);
          variantCandidates.push(`${requested.familySlug}/${variant}`);
        }
      }
      const baseCandidates = [requested.familySlug];

      const effectiveModel =
        variantCandidates.find((candidate) => allowedModelValues.includes(candidate)) ??
        allowedModelValues.find((value) =>
          variantCandidates.some(
            (candidate) =>
              value.endsWith(`/${candidate}`) ||
              value.endsWith(`-${candidate}`) ||
              value === candidate,
          ),
        ) ??
        baseCandidates.find((candidate) => allowedModelValues.includes(candidate));

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
      yield* input.runtime.setModel(effectiveModel).pipe(Effect.mapError(input.mapError));
    }

    if (needsReasoningSwitch && reasoningConfigId !== undefined) {
      const reasoningOption = findSessionConfigOption(input.configOptions, reasoningConfigId);
      const allowedReasoningValues = reasoningOption
        ? collectSessionConfigOptionValues(reasoningOption)
        : [];
      const effectiveReasoning =
        requestedReasoning && allowedReasoningValues.length > 0
          ? (allowedReasoningValues.find(
              (value) => requestedReasoning === value || requestedReasoning.endsWith(`-${value}`),
            ) ?? requestedReasoning)
          : requestedReasoning;
      yield* input.runtime
        .setConfigOption(reasoningConfigId, effectiveReasoning)
        .pipe(Effect.mapError(input.mapError));
    }

    return requested;
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
