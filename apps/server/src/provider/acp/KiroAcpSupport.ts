import {
  KIRO_DEFAULT_MODEL,
  type KiroSettings,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "binaryPath" | "agent">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Trust no Kiro tools, so every tool call must go through T3's permission handler. */
  readonly trustNoTools?: boolean;
}

/**
 * `kiro-cli acp` argv for a T3 runtime mode. Kiro has no auto-review tier, so
 * Supervised, Auto-accept edits, and Auto all leave Kiro's own trust settings
 * in place and route the remaining permission requests through T3. Full access
 * trusts every tool natively so the agent never blocks on a request.
 */
export function kiroAcpSpawnArgs(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  runtimeMode?: RuntimeMode,
  options?: { readonly trustNoTools?: boolean },
): ReadonlyArray<string> {
  const agent = kiroSettings?.agent?.trim();
  return [
    "acp",
    ...(agent ? ["--agent", agent] : []),
    ...(options?.trustNoTools
      ? ["--trust-tools="]
      : runtimeMode === "full-access"
        ? ["--trust-all-tools"]
        : []),
  ];
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  options?: { readonly trustNoTools?: boolean },
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: [...kiroAcpSpawnArgs(kiroSettings, runtimeMode, options)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Kiro owns its login (`kiro-cli login`) and advertises no ACP auth methods;
 * its agent answers `authenticate` with "Method not found", so the runtime
 * must skip that step.
 */
export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          { trustNoTools: input.trustNoTools === true },
        ),
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

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIRO_DEFAULT_MODEL;
  return normalizeModelSlug(base, KIRO_DRIVER_KIND) ?? KIRO_DEFAULT_MODEL;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/** Switches the session model through `session/set_model` only when it differs from the current one. */
export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = input.requestedModelId?.trim() || undefined;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}
