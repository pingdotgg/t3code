import { type DevinSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function devinAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  // Devin's ACP entry point negotiates permissions through ACP itself.
  // Runtime modes are intentionally not translated into undocumented CLI flags.
  void runtimeMode;
  return ["acp"];
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: [...devinAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
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
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: "devin-browser",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return runtime;
  });

/**
 * T3's built-in Devin slug. It is the CLI's product name, not a model id the ACP accepts,
 * so selecting it means "use whatever model the Devin session currently runs on".
 */
export const DEVIN_DEFAULT_MODEL_SLUG = "devin-build";

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL_SLUG;
}

const DEVIN_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidDevinReasoningEffortToken(value: string): boolean {
  return DEVIN_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeDevinReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidDevinReasoningEffortToken(effort) ? effort : undefined;
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
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizeDevinReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // The product slug is never sent over the wire; it keeps the session's current model.
  const requestedModelId =
    input.requestedModelId === DEVIN_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  const modelChanged = requestedModelId !== undefined && requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeDevinReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  const targetModelId = requestedModelId ?? input.currentModelId;
  if ((!modelChanged && !reasoningEffortChanged) || targetModelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  const reasoningMeta =
    reasoningProvided && reasoningEffort !== undefined ? { reasoningEffort } : undefined;
  // When reasoning was explicitly provided but invalid (normalize => undefined), we deliberately
  // send no meta so the invalid value is dropped rather than forwarded. When reasoning was not
  // provided at all, we also send no meta, but we only reach this call when the model itself
  // changed - an omitted reasoning preference must not be treated as an explicit clear of the
  // CLI-advertised default (e.g. Extra High) on same-model reselections.
  return input.runtime
    .setSessionModel(targetModelId, reasoningMeta)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}
