import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpSessionMode, AcpSessionModeState } from "./AcpRuntimeModel.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

export const GROK_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface GrokAcpModeIds {
  readonly planModeId: string;
  readonly defaultModeId: string;
}

export interface GrokAcpSelectOption {
  readonly value: string;
  readonly name: string;
}

export interface GrokAcpReasoningOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export interface GrokAcpModelReasoningCapabilities {
  readonly currentValue?: string;
  readonly options: ReadonlyArray<GrokAcpReasoningOption>;
}

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function normalizeGrokCapabilityToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeGrokAcpModelReasoningCapabilities(
  model: EffectAcpSchema.ModelInfo | undefined,
): GrokAcpModelReasoningCapabilities | undefined {
  if (!model) {
    return undefined;
  }
  const meta = model._meta;
  if (!isRecord(meta) || meta.supportsReasoningEffort !== true) {
    return undefined;
  }
  if (!Array.isArray(meta.reasoningEfforts) || meta.reasoningEfforts.length === 0) {
    return undefined;
  }
  const options: Array<GrokAcpReasoningOption> = [];
  const seen = new Set<string>();
  for (const rawOption of meta.reasoningEfforts) {
    if (!isRecord(rawOption)) {
      return undefined;
    }
    const value = typeof rawOption.value === "string" ? rawOption.value.trim() : "";
    const label = typeof rawOption.label === "string" ? rawOption.label.trim() : "";
    if (!value || !label || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const description =
      typeof rawOption.description === "string" ? rawOption.description.trim() : undefined;
    options.push({
      value,
      label,
      ...(description ? { description } : {}),
      ...(rawOption.default === true ? { isDefault: true } : {}),
    });
  }
  const currentValue =
    typeof meta.reasoningEffort === "string" &&
    options.some((option) => option.value === meta.reasoningEffort)
      ? meta.reasoningEffort
      : undefined;
  return {
    options,
    ...(currentValue ? { currentValue } : {}),
  };
}

export function resolveGrokAcpModelReasoningValue(
  model: EffectAcpSchema.ModelInfo | undefined,
  requestedValue: string | undefined,
): string | undefined {
  if (!model || requestedValue === undefined) {
    return undefined;
  }
  const reasoning = decodeGrokAcpModelReasoningCapabilities(model);
  return reasoning?.options.find((option) => option.value === requestedValue.trim())?.value;
}

export function collectGrokAcpSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | null | undefined,
): ReadonlyArray<GrokAcpSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  const seen = new Set<string>();
  return configOption.options.flatMap((entry) => {
    const options = "value" in entry ? [entry] : entry.options;
    return options.flatMap((option) => {
      const value = option.value.trim();
      const name = option.name.trim();
      if (!value || !name || seen.has(value)) {
        return [];
      }
      seen.add(value);
      return [{ value, name } satisfies GrokAcpSelectOption];
    });
  });
}

function isGrokReasoningConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = normalizeGrokCapabilityToken(option.id);
  const name = normalizeGrokCapabilityToken(option.name);
  const category = normalizeGrokCapabilityToken(option.category);
  return (
    option.type === "select" &&
    (category === "thought-level" ||
      id === "reasoning" ||
      id === "effort" ||
      name === "reasoning" ||
      name === "effort" ||
      name.includes("reasoning") ||
      name.includes("effort"))
  );
}

export function findGrokAcpReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions?.filter(isGrokReasoningConfigOption) ?? [];
  return (
    candidates.find(
      (option) => normalizeGrokCapabilityToken(option.category) === "thought-level",
    ) ??
    candidates.find((option) => normalizeGrokCapabilityToken(option.id) === "reasoning") ??
    candidates[0]
  );
}

export function resolveGrokAcpReasoningValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requestedValue: string | undefined,
): string | undefined {
  if (!configOption || configOption.type !== "select") {
    return undefined;
  }
  const options = collectGrokAcpSelectOptions(configOption);
  if (requestedValue !== undefined) {
    const exact = options.find((option) => option.value === requestedValue.trim());
    if (exact) {
      return exact.value;
    }
    const normalizedRequested = normalizeGrokCapabilityToken(requestedValue);
    return options.find(
      (option) =>
        normalizeGrokCapabilityToken(option.value) === normalizedRequested ||
        normalizeGrokCapabilityToken(option.name) === normalizedRequested,
    )?.value;
  }
  const currentValue = configOption.currentValue.trim();
  return options.some((option) => option.value === currentValue) ? currentValue : undefined;
}

function modeText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description].filter(Boolean).join(" ");
}

function modeMatchesAnyToken(mode: AcpSessionMode, tokens: ReadonlySet<string>): boolean {
  const normalizedText = normalizeGrokCapabilityToken(modeText(mode));
  return Array.from(tokens).some((token) => normalizedText.split("-").includes(token));
}

export function resolveGrokAcpModeIds(
  modeState: AcpSessionModeState | null | undefined,
): GrokAcpModeIds | undefined {
  if (!modeState || modeState.availableModes.length < 2) {
    return undefined;
  }
  const planMode = modeState.availableModes.find((mode) =>
    modeMatchesAnyToken(mode, new Set(["plan", "architect"])),
  );
  const defaultMode = modeState.availableModes.find((mode) =>
    modeMatchesAnyToken(mode, new Set(["build", "code", "default", "implement", "normal"])),
  );
  if (!planMode || !defaultMode || planMode.id === defaultMode.id) {
    return undefined;
  }
  return {
    planModeId: planMode.id,
    defaultModeId: defaultMode.id,
  };
}

export function resolveGrokAcpInteractionModeId(
  modeState: AcpSessionModeState | null | undefined,
  interactionMode: "default" | "plan",
): string | undefined {
  const modeIds = resolveGrokAcpModeIds(modeState);
  if (!modeIds) {
    return undefined;
  }
  return interactionMode === "plan" ? modeIds.planModeId : modeIds.defaultModeId;
}

export function grokAcpHasPlanModePair(modeState: AcpSessionModeState | null | undefined): boolean {
  return resolveGrokAcpModeIds(modeState) !== undefined;
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment),
        authMethodId: resolveGrokAuthMethodId(input.environment),
        clientCapabilities: GROK_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
