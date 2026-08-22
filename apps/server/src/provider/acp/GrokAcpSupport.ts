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

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Provider option id for the Grok reasoning picker. Grok advertises the levels
 * per model through `ModelInfo._meta.reasoningEfforts` and applies them through
 * `session/set_model` with `_meta.reasoningEffort`.
 */
export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
const GROK_REASONING_EFFORT_META_KEY = "reasoningEffort";
const GROK_REASONING_EFFORTS_META_KEY = "reasoningEfforts";

export interface GrokReasoningEffortLevel {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads the effort currently applied to a model from its ACP `_meta`. */
export function grokCurrentReasoningEffortFromModelMeta(
  meta: unknown | null | undefined,
): string | undefined {
  return isRecord(meta) ? trimmedString(meta[GROK_REASONING_EFFORT_META_KEY]) : undefined;
}

/**
 * Reads the selectable reasoning levels from a model's ACP `_meta`. Grok marks
 * more than one entry as `default`, so the level currently applied to the model
 * wins and the `default` flags are only a fallback.
 */
export function grokReasoningEffortLevelsFromModelMeta(
  meta: unknown | null | undefined,
): ReadonlyArray<GrokReasoningEffortLevel> {
  if (!isRecord(meta)) {
    return [];
  }
  const rawLevels = meta[GROK_REASONING_EFFORTS_META_KEY];
  if (!Array.isArray(rawLevels)) {
    return [];
  }
  const levels = rawLevels.flatMap((entry): ReadonlyArray<GrokReasoningEffortLevel> => {
    if (!isRecord(entry)) {
      return [];
    }
    const value = trimmedString(entry.value) ?? trimmedString(entry.id);
    if (!value) {
      return [];
    }
    const description = trimmedString(entry.description);
    return [
      {
        value,
        label: trimmedString(entry.label) ?? value,
        ...(description ? { description } : {}),
        ...(entry.default === true ? { isDefault: true } : {}),
      },
    ];
  });
  if (levels.length === 0) {
    return [];
  }
  const currentEffort = grokCurrentReasoningEffortFromModelMeta(meta);
  const defaultValue =
    levels.find((level) => level.value === currentEffort)?.value ??
    levels.find((level) => level.isDefault)?.value ??
    levels[0]?.value;
  return levels.map((level) =>
    level.value === defaultValue ? { ...level, isDefault: true } : { ...level, isDefault: false },
  );
}

/** Reads the effort Grok already applies to the session's current model. */
export function currentGrokReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId?.trim();
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  return grokCurrentReasoningEffortFromModelMeta(currentModel?._meta);
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<
  { readonly modelId: string | undefined; readonly reasoningEffort: string | undefined },
  E
> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  const shouldSwitchReasoningEffort =
    input.requestedReasoningEffort !== undefined &&
    input.requestedReasoningEffort !== input.currentReasoningEffort;
  if (!shouldSwitchModel && !shouldSwitchReasoningEffort) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: input.currentReasoningEffort,
    });
  }
  // `session/set_model` carries the effort, so an effort-only change still
  // resends the model Grok already has selected.
  const modelId = input.requestedModelId ?? input.currentModelId;
  if (modelId === undefined) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: input.currentReasoningEffort,
    });
  }
  // An explicit request always wins. Without one, the effort carries over only
  // when the model does not change: levels are per model, so carrying (say)
  // `xhigh` from Grok 4.6 onto Grok 4.5 applies a level that model never
  // advertised and leaves its session config with nothing selected. Sending no
  // effort lets Grok apply the target model's own default instead.
  const reasoningEffort =
    input.requestedReasoningEffort ??
    (shouldSwitchModel ? undefined : input.currentReasoningEffort);
  return input.runtime
    .setSessionModel(
      modelId,
      reasoningEffort === undefined
        ? {}
        : { meta: { [GROK_REASONING_EFFORT_META_KEY]: reasoningEffort } },
    )
    .pipe(Effect.mapError(input.mapError), Effect.as({ modelId, reasoningEffort }));
}
