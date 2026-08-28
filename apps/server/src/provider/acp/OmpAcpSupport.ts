import { type OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const OMP_AUTH_METHOD_AGENT = "agent";
const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  // `omp acp` serves the ACP agent over stdio and reuses the local omp
  // credentials; approvals flow back through ACP permission requests, so no
  // CLI permission-mode flags are needed.
  return {
    command: ompSettings?.binaryPath || "omp",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: OMP_AUTH_METHOD_AGENT,
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

export function resolveOmpAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  // OMP has no provider-owned default model id: the agent reports its own
  // current model through ACP session state. Blank input means "no request",
  // never an empty model id - sending "" to session/set_model clears the
  // agent's own choice.
  return trimmed ? (normalizeModelSlug(trimmed, OMP_DRIVER_KIND) ?? trimmed) : undefined;
}

const OMP_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidOmpReasoningEffortToken(value: string): boolean {
  return OMP_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeOmpReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidOmpReasoningEffortToken(effort) ? effort : undefined;
}

export function currentOmpModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentOmpReasoningEffortFromSessionSetup(
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
    ? normalizeOmpReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const modelChanged =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeOmpReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  const targetModelId = input.requestedModelId ?? input.currentModelId;
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
