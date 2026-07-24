import {
  DEFAULT_MODEL_BY_PROVIDER,
  type KimiSettings,
  type ModelSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getModelSelectionStringOptionValue, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { extractModelConfigId, findSessionConfigOption } from "./AcpRuntimeModel.ts";

/** Moonshot / Kimi Code API key env vars (either is accepted). */
const KIMI_API_KEY_ENVS = ["KIMI_API_KEY", "MOONSHOT_API_KEY"] as const;
/**
 * Kimi Code CLI ACP only advertises the terminal `login` auth method. Cached
 * OAuth from `kimi login` is used when present; API keys ride on the process
 * environment and do not change the auth method id.
 */
const KIMI_AUTH_METHOD_LOGIN = "login";
const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
const DEFAULT_KIMI_MODEL = DEFAULT_MODEL_BY_PROVIDER[KIMI_DRIVER_KIND] ?? "kimi-code/k3";
const KIMI_THINKING_CONFIG_ID = "thinking";
const KIMI_ALLOWED_THINKING_EFFORTS = new Set(["low", "high", "max"]);

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelSelection?: ModelSelection;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function resolveKimiThinkingEffort(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const raw = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")?.trim();
  if (!raw) return undefined;
  // Map UI "medium" onto Kimi's nearest supported level.
  if (raw === "medium") return "high";
  if (KIMI_ALLOWED_THINKING_EFFORTS.has(raw)) return raw;
  return undefined;
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: KIMI_AUTH_METHOD_LOGIN,
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

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_KIMI_MODEL;
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? DEFAULT_KIMI_MODEL;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const fromModels = sessionSetupResult.models?.currentModelId?.trim();
  if (fromModels) return fromModels;

  const modelConfigId = extractModelConfigId(sessionSetupResult) ?? "model";
  const option = findSessionConfigOption(sessionSetupResult.configOptions, modelConfigId);
  if (option && typeof option.currentValue === "string") {
    const value = option.currentValue.trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  const modelId = input.requestedModelId;
  if (modelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime.setModel(modelId).pipe(Effect.mapError(input.mapError), Effect.as(modelId));
}

export function applyKimiThinkingEffort<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly modelSelection: ModelSelection | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const thinking = resolveKimiThinkingEffort(input.modelSelection);
  if (!thinking) {
    return Effect.void;
  }
  return input.runtime
    .setConfigOption(KIMI_THINKING_CONFIG_ID, thinking)
    .pipe(Effect.mapError(input.mapError), Effect.asVoid);
}

/** Exposed for tests / status probes that need to know which env keys we honor. */
export const KIMI_API_KEY_ENVIRONMENT_VARIABLES = KIMI_API_KEY_ENVS;
