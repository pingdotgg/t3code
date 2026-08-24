import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
const GROK_LEGACY_DEFAULT_MODEL_ID = "grok-build";
const GROK_STOCK_SESSION_COMPATIBILITY_GROUP = "grok-stock";
const GROK_STRICT_AGENT_TYPES = new Set(["codex", "grok-build-orchestrator"]);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const isUnknownRecord = Schema.is(UnknownRecord);

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
  const base = trimmed && trimmed.length > 0 ? trimmed : GROK_LEGACY_DEFAULT_MODEL_ID;
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? GROK_LEGACY_DEFAULT_MODEL_ID;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function grokAcpSessionCompatibilityGroup(
  agentType: string | undefined,
): string | undefined {
  if (!agentType) {
    return undefined;
  }
  // Grok Build treats every non-strict harness, including custom names, as
  // interchangeable. Strict harnesses can only switch to the same identity.
  return GROK_STRICT_AGENT_TYPES.has(agentType)
    ? `grok-strict:${agentType}`
    : GROK_STOCK_SESSION_COMPATIBILITY_GROUP;
}

export interface GrokAcpReasoningEffortOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault: boolean;
}

export interface GrokAcpModelMetadata {
  readonly agentType: string | undefined;
  readonly supportsReasoningEffort: boolean | undefined;
  readonly reasoningEffort: string | undefined;
  readonly reasoningEfforts: ReadonlyArray<GrokAcpReasoningEffortOption>;
  readonly totalContextTokens: number | undefined;
}

export function parseGrokAcpModelMetadata(meta: unknown): GrokAcpModelMetadata {
  if (!isUnknownRecord(meta)) {
    return {
      agentType: undefined,
      supportsReasoningEffort: undefined,
      reasoningEffort: undefined,
      reasoningEfforts: [],
      totalContextTokens: undefined,
    };
  }

  const seen = new Set<string>();
  const reasoningEfforts = Array.isArray(meta.reasoningEfforts)
    ? meta.reasoningEfforts.flatMap((raw) => {
        if (!isUnknownRecord(raw)) {
          return [];
        }
        const value = trimmedString(raw.value);
        if (!value || seen.has(value)) {
          return [];
        }
        seen.add(value);
        const description = trimmedString(raw.description);
        return [
          {
            value,
            label: trimmedString(raw.label) ?? value,
            ...(description ? { description } : {}),
            isDefault: raw.default === true,
          } satisfies GrokAcpReasoningEffortOption,
        ];
      })
    : [];
  const totalContextTokens = meta.totalContextTokens;

  return {
    agentType: trimmedString(meta.agentType),
    supportsReasoningEffort:
      typeof meta.supportsReasoningEffort === "boolean" ? meta.supportsReasoningEffort : undefined,
    reasoningEffort: trimmedString(meta.reasoningEffort),
    reasoningEfforts,
    totalContextTokens:
      typeof totalContextTokens === "number" &&
      Number.isSafeInteger(totalContextTokens) &&
      totalContextTokens > 0
        ? totalContextTokens
        : undefined,
  };
}

export interface GrokAcpModelSelectionState {
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
}

export interface GrokAcpSessionModelState extends GrokAcpModelSelectionState {
  readonly totalContextTokens: number | undefined;
}

export function currentGrokModelSelectionFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): GrokAcpSessionModelState {
  const modelId = sessionSetupResult.models?.currentModelId?.trim() || undefined;
  const currentModel = sessionSetupResult.models?.availableModels.find(
    (model) => model.modelId.trim() === modelId,
  );
  const metadata = parseGrokAcpModelMetadata(currentModel?._meta);
  return {
    modelId,
    reasoningEffort: metadata.reasoningEffort,
    totalContextTokens: metadata.totalContextTokens,
  };
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<GrokAcpModelSelectionState, E> {
  const requestedModelId = input.requestedModelId?.trim() || undefined;
  const requestedReasoningEffort = input.requestedReasoningEffort?.trim() || undefined;
  const targetModelId =
    requestedModelId === GROK_LEGACY_DEFAULT_MODEL_ID
      ? input.currentModelId
      : (requestedModelId ?? input.currentModelId);
  const modelChanged =
    requestedModelId !== undefined &&
    requestedModelId !== GROK_LEGACY_DEFAULT_MODEL_ID &&
    requestedModelId !== input.currentModelId;
  const effortChanged =
    requestedReasoningEffort !== undefined &&
    requestedReasoningEffort !== input.currentReasoningEffort;

  if ((!modelChanged && !effortChanged) || targetModelId === undefined) {
    return Effect.succeed({
      modelId: input.currentModelId,
      reasoningEffort: input.currentReasoningEffort,
    });
  }
  return input.runtime
    .setSessionModel(
      targetModelId,
      requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : undefined,
    )
    .pipe(
      Effect.mapError(input.mapError),
      Effect.as({
        modelId: targetModelId,
        reasoningEffort:
          requestedReasoningEffort ?? (modelChanged ? undefined : input.currentReasoningEffort),
      }),
    );
}
