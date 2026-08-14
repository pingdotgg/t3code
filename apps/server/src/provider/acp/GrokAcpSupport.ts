import {
  type GrokSettings,
  ProviderDriverKind,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

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

export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
const GROK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export interface GrokReasoningEffortChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export interface GrokReasoningEffortMenu {
  readonly currentValue?: string;
  readonly options: ReadonlyArray<GrokReasoningEffortChoice>;
}

export interface GrokAcpAppliedModelSelection {
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeGrokReasoningEffortToken(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !GROK_REASONING_EFFORT_TOKEN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function parseGrokReasoningEffortChoice(entry: unknown): GrokReasoningEffortChoice | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const rawId =
    typeof entry.id === "string"
      ? entry.id
      : typeof entry.value === "string"
        ? entry.value
        : undefined;
  const id = normalizeGrokReasoningEffortToken(rawId);
  if (!id) {
    return undefined;
  }
  const label =
    typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : id;
  const description =
    typeof entry.description === "string" && entry.description.trim().length > 0
      ? entry.description.trim()
      : undefined;
  const isDefault = entry.default === true || entry.isDefault === true;
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(isDefault ? { isDefault: true } : {}),
  };
}

export function parseGrokReasoningEffortMenu(meta: unknown): GrokReasoningEffortMenu | undefined {
  if (!isRecord(meta) || meta.supportsReasoningEffort === false) {
    return undefined;
  }
  if (!Array.isArray(meta.reasoningEfforts)) {
    return undefined;
  }
  const options: Array<GrokReasoningEffortChoice> = [];
  const seen = new Set<string>();
  for (const entry of meta.reasoningEfforts) {
    const option = parseGrokReasoningEffortChoice(entry);
    if (!option || seen.has(option.id)) {
      continue;
    }
    seen.add(option.id);
    options.push(option);
  }
  if (options.length === 0) {
    return undefined;
  }
  const advertisedCurrent = normalizeGrokReasoningEffortToken(
    typeof meta.reasoningEffort === "string" ? meta.reasoningEffort : undefined,
  );
  const currentValue =
    advertisedCurrent && seen.has(advertisedCurrent)
      ? advertisedCurrent
      : options.find((option) => option.isDefault)?.id;
  return {
    options,
    ...(currentValue ? { currentValue } : {}),
  };
}

export interface GrokTokenUsageReading {
  readonly usedTokens: number;
  readonly maxTokens?: number;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  const parsed = readFiniteNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = readNonNegativeInt(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function parseGrokAcpMetaTokenUsage(meta: unknown): GrokTokenUsageReading | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const usedTokens = readNonNegativeInt(meta.totalTokens);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens =
    readPositiveInt(meta.totalContextTokens) ??
    readPositiveInt(meta.contextWindow) ??
    readPositiveInt(meta.size);
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function parseGrokAcpUsageUpdate(update: {
  readonly used: number;
  readonly size: number;
}): GrokTokenUsageReading | undefined {
  const usedTokens = readNonNegativeInt(update.used);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = readPositiveInt(update.size);
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function parseGrokPromptResponseUsage(
  response: Pick<EffectAcpSchema.PromptResponse, "_meta">,
): GrokTokenUsageReading | undefined {
  const direct = parseGrokAcpMetaTokenUsage(response._meta);
  if (direct) {
    return direct;
  }
  if (!isRecord(response._meta) || !isRecord(response._meta.usage)) {
    return undefined;
  }
  const usedTokens = readNonNegativeInt(response._meta.usage.totalTokens);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens =
    readPositiveInt(response._meta.usage.totalContextTokens) ??
    readPositiveInt(response._meta.usage.contextWindow) ??
    readPositiveInt(response._meta.usage.size);
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function grokContextWindowFromAvailableModels(
  models: ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined,
  currentModelId?: string,
): number | undefined {
  if (!models || models.length === 0) {
    return undefined;
  }
  const resolvedCurrent = currentModelId ? resolveGrokAcpBaseModelId(currentModelId) : undefined;
  const current = resolvedCurrent
    ? models.find((model) => resolveGrokAcpBaseModelId(model.modelId) === resolvedCurrent)
    : undefined;
  const candidate = current ?? models[0];
  if (!candidate || !isRecord(candidate._meta)) {
    return undefined;
  }
  return readPositiveInt(candidate._meta.totalContextTokens);
}

export function buildGrokTokenUsageSnapshot(input: {
  readonly usedTokens: number;
  readonly maxTokens?: number;
}): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = readNonNegativeInt(input.usedTokens);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = readPositiveInt(input.maxTokens);
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    compactsAutomatically: true,
  };
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
  readonly currentReasoningEffort?: string;
  readonly requestedReasoningEffort?: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<GrokAcpAppliedModelSelection, E> {
  const currentReasoningEffort = normalizeGrokReasoningEffortToken(input.currentReasoningEffort);
  const requestedReasoningEffort = normalizeGrokReasoningEffortToken(
    input.requestedReasoningEffort,
  );
  const modelChanged =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  // A missing model selection is not a clear. Only treat effort as changed when
  // the caller actually sent a model or an effort value.
  const effortSpecified =
    input.requestedModelId !== undefined || input.requestedReasoningEffort !== undefined;
  const effortChanged = effortSpecified && requestedReasoningEffort !== currentReasoningEffort;
  const targetModelId = modelChanged ? input.requestedModelId : input.currentModelId;

  if (!modelChanged && !effortChanged) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: currentReasoningEffort,
    });
  }
  if (!targetModelId) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: currentReasoningEffort,
    });
  }

  const meta =
    requestedReasoningEffort !== undefined
      ? { reasoningEffort: requestedReasoningEffort }
      : undefined;
  return input.runtime.setSessionModel(targetModelId, meta).pipe(
    Effect.mapError(input.mapError),
    Effect.as({
      modelId: targetModelId,
      reasoningEffort: requestedReasoningEffort,
    }),
  );
}
