import {
  ProviderDriverKind,
  type DevinSettings,
  type ModelCapabilities,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");
const DEVIN_DEFAULT_MODEL_SLUG = "default";
const DEVIN_PERMISSION_MODE_ENV = "DEVIN_PERMISSION_MODE";

/**
 * T3's built-in default Devin model slug. Selecting it means "use whatever model
 * the active Devin session is currently configured for".
 */
export const DEVIN_DEFAULT_MODEL_SLUG_PUBLIC = DEVIN_DEFAULT_MODEL_SLUG;

export interface DevinAcpRuntimeSettings extends Pick<
  DevinSettings,
  "binaryPath" | "agentType" | "sandbox" | "respectWorkspaceTrust" | "launchArgs"
> {
  /** Absolute path to a Devin config file, if configured. */
  readonly resolvedConfigPath?: string | undefined;
}

interface DevinModeAliasSet {
  readonly primary: string;
  readonly aliases: ReadonlyArray<string>;
}

const DEVIN_MODE_ALIASES: {
  readonly [K in "normal" | "acceptEdits" | "smart" | "plan" | "bypass"]: DevinModeAliasSet;
} = {
  normal: { primary: "normal", aliases: ["normal"] },
  acceptEdits: {
    primary: "accept-edits",
    aliases: ["accept-edits", "accept edits", "accept_edits"],
  },
  smart: { primary: "smart", aliases: ["smart"] },
  plan: { primary: "plan", aliases: ["plan"] },
  bypass: { primary: "bypass", aliases: ["bypass", "dangerous", "yolo"] },
};

export function resolveDevinAcpPermissionMode(
  runtimeMode: RuntimeMode,
  interactionMode: "default" | "plan" = "default",
): string | undefined {
  if (interactionMode === "plan") {
    return DEVIN_MODE_ALIASES.plan.primary;
  }
  switch (runtimeMode) {
    case "approval-required":
      return DEVIN_MODE_ALIASES.normal.primary;
    case "auto-accept-edits":
      return DEVIN_MODE_ALIASES.acceptEdits.primary;
    case "auto":
      return DEVIN_MODE_ALIASES.smart.primary;
    case "full-access":
      return DEVIN_MODE_ALIASES.bypass.primary;
    default:
      return undefined;
  }
}

export function resolveDevinAcpMode(
  runtimeMode: RuntimeMode,
  availableModes: ReadonlyArray<{ readonly id: string; readonly name: string }> | undefined,
  interactionMode: "default" | "plan" = "default",
): string | undefined {
  const desired = resolveDevinAcpPermissionMode(runtimeMode, interactionMode);
  if (!desired || !availableModes || availableModes.length === 0) {
    return undefined;
  }
  const desiredNormalized = desired.toLowerCase().replace(/[\s_-]+/g, "-");
  const desiredAliases = new Set<string>();
  for (const [, aliasSet] of Object.entries(DEVIN_MODE_ALIASES)) {
    if (aliasSet.primary.toLowerCase().replace(/[\s_-]+/g, "-") === desiredNormalized) {
      for (const alias of aliasSet.aliases) {
        desiredAliases.add(alias.toLowerCase().replace(/[\s_-]+/g, "-"));
      }
    }
  }
  desiredAliases.add(desiredNormalized);

  for (const mode of availableModes) {
    const id = mode.id
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-");
    if (desiredAliases.has(id)) return mode.id;
    const name = mode.name
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-");
    if (desiredAliases.has(name)) return mode.id;
  }
  return undefined;
}

function devinAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  if (!runtimeMode) return [];
  const mode = resolveDevinAcpPermissionMode(runtimeMode);
  return mode ? ["--permission-mode", mode] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildDevinAcpSpawnInput(
  settings: DevinAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const globalArgs: Array<string> = [];
  if (settings.resolvedConfigPath) {
    globalArgs.push("--config", settings.resolvedConfigPath);
  }
  if (settings.sandbox) {
    globalArgs.push("--sandbox");
  }
  globalArgs.push("--respect-workspace-trust", String(settings.respectWorkspaceTrust));

  const acpArgs: Array<string> = ["acp"];
  if (settings.agentType.trim()) {
    acpArgs.push("--agent-type", settings.agentType.trim());
  }

  const safeLaunchArgs = tokenizeCliArgs(settings.launchArgs);

  const env: NodeJS.ProcessEnv = { ...environment };
  if (runtimeMode) {
    const mode = resolveDevinAcpPermissionMode(runtimeMode);
    if (mode) {
      env[DEVIN_PERMISSION_MODE_ENV] = mode;
    }
  }

  return {
    command: settings.binaryPath.trim() || "devin",
    args: [...globalArgs, ...devinAcpPermissionArgs(runtimeMode), ...acpArgs, ...safeLaunchArgs],
    cwd,
    env,
  };
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: "default" | "plan";
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
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        cwd: input.cwd,
        clientInfo: input.clientInfo,
        authMethodId: "devin",
        authenticationMode: "on-demand",
        ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.sessionLoadTimeout !== undefined
          ? { sessionLoadTimeout: input.sessionLoadTimeout }
          : {}),
        ...(input.sessionLoadReplayIdleGap !== undefined
          ? { sessionLoadReplayIdleGap: input.sessionLoadReplayIdleGap }
          : {}),
        ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
        ...(input.isAuthenticationFailure !== undefined
          ? { isAuthenticationFailure: input.isAuthenticationFailure }
          : {}),
        ...(input.requestLogger !== undefined ? { requestLogger: input.requestLogger } : {}),
        ...(input.protocolLogging !== undefined ? { protocolLogging: input.protocolLogging } : {}),
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
  const trimmed = model?.trim();
  if (!trimmed || trimmed === DEVIN_DEFAULT_MODEL_SLUG) {
    return DEVIN_DEFAULT_MODEL_SLUG;
  }
  const base = trimmed.includes("[") ? trimmed.slice(0, trimmed.indexOf("[")) : trimmed;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? base;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function reasoningValuesFromMeta(meta: Record<string, unknown> | null | undefined):
  | {
      options: ReadonlyArray<{ value: string; label: string; isDefault?: boolean }>;
      currentValue: string | undefined;
    }
  | undefined {
  if (!meta) return undefined;

  const advertisedOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  if (advertisedOptions.length > 0) {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string; isDefault?: boolean }> = [];
    for (const entry of advertisedOptions) {
      if (!isRecord(entry)) continue;
      const rawValue = nonEmptyString(entry.value);
      const rawId = nonEmptyString(entry.id);
      const value = rawValue ?? rawId;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({
        value,
        label: nonEmptyString(entry.label) ?? value,
        ...(entry.default === true || entry.isDefault === true ? { isDefault: true } : {}),
      });
    }
    const current = nonEmptyString(meta.reasoningEffort);
    const currentValue =
      current && options.some((o) => o.value === current) ? current : options[0]?.value;
    return { options, currentValue };
  }

  const effort = nonEmptyString(meta.reasoningEffort);
  if (effort) {
    return {
      options: [{ value: effort, label: effort }],
      currentValue: effort,
    };
  }

  return undefined;
}

export function buildDevinModelCapabilities(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const meta = model._meta;
  const reasoning = reasoningValuesFromMeta(meta);

  if (reasoning && reasoning.options.length > 0) {
    const choices = reasoning.options.map((option) => ({
      id: option.value,
      label: option.label,
      ...(option.isDefault ? { isDefault: true } : {}),
    }));
    return createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: choices,
          ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
        },
      ],
    });
  }

  const supportsReasoning = meta && (meta.supportsReasoning === true || meta.reasoning === true);
  if (supportsReasoning) {
    return createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "boolean",
          currentValue: meta.reasoning === true,
        },
      ],
    });
  }

  return createModelCapabilities({ optionDescriptors: [] });
}

function buildDevinModelSlug(model: EffectAcpSchema.ModelInfo): string {
  const name = model.name.trim();
  if (!name) {
    return `devin-protocol:${model.modelId.trim()}`;
  }
  return resolveDevinAcpBaseModelId(name);
}

export function buildDevinModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  protocolValues?: Map<string, string>,
): {
  models: ReadonlyArray<ServerProviderModel>;
  protocolMap: Map<string, string>;
} {
  if (!modelState || modelState.availableModels.length === 0) {
    return { models: [], protocolMap: new Map() };
  }

  const currentModelId = modelState.currentModelId.trim();
  const seen = new Map<string, string>();
  const models: Array<ServerProviderModel> = [];
  const protocolMap = protocolValues ? new Map(protocolValues) : new Map<string, string>();

  for (const model of modelState.availableModels) {
    const protocolValue = model.modelId.trim();
    const slug = buildDevinModelSlug(model);
    if (seen.has(slug)) continue;
    seen.set(slug, protocolValue);
    protocolMap.set(slug, protocolValue);
    models.push({
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      ...(protocolValue === currentModelId ? { isDefault: true } : {}),
      capabilities: buildDevinModelCapabilities(model),
    });
  }

  return { models, protocolMap };
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentDevinReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) return undefined;
  const currentModelId = modelState.currentModelId.trim();
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  return reasoningValuesFromMeta(currentModel?._meta)?.currentValue;
}

function findDevinReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => {
    const id = option.id.trim().toLowerCase();
    const name = option.name.trim().toLowerCase();
    const category = (option.category ?? "").trim().toLowerCase();
    return (
      category === "model_option" &&
      (id === "reasoning" ||
        id === "reasoning_effort" ||
        id === "effort" ||
        name === "reasoning" ||
        name === "reasoning effort" ||
        name === "effort" ||
        name.includes("reasoning"))
    );
  });
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-model" | "set-config-option";
  readonly configId?: string;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setConfigOption" | "getConfigOptions" | "setSessionModel"
  >;
  readonly protocolMap: ReadonlyMap<string, string>;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requestedModelId =
      input.requestedModelId === DEVIN_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
    const modelChanged =
      requestedModelId !== undefined && requestedModelId !== input.currentModelId;

    const targetProtocolValue =
      requestedModelId === undefined
        ? input.currentModelId
        : (input.protocolMap.get(requestedModelId) ??
          (input.protocolMap.size === 0 ? requestedModelId : undefined));

    if (modelChanged && targetProtocolValue !== undefined) {
      yield* input.runtime
        .setModel(targetProtocolValue)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }

    const reasoningProvided = input.requestedReasoningEffort !== undefined;
    if (reasoningProvided) {
      const configOptions = yield* input.runtime.getConfigOptions;
      const reasoningOption = findDevinReasoningConfigOption(configOptions);
      const reasoningValue = input.requestedReasoningEffort!.trim();
      if (reasoningOption) {
        yield* input.runtime.setConfigOption(reasoningOption.id, reasoningValue).pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-config-option",
              configId: reasoningOption.id,
            }),
          ),
        );
      } else if (targetProtocolValue) {
        yield* input.runtime
          .setSessionModel(targetProtocolValue, { reasoningEffort: reasoningValue })
          .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-config-option" })));
      }
    }

    return targetProtocolValue ?? input.currentModelId;
  });
}
