/**
 * KiroAcpSupport — every Kiro-specific decision the ACP runtime needs.
 *
 * The adapter, the provider probe, and text generation all reach for this
 * module rather than growing their own ideas about how to launch `kiro-cli`,
 * which auth method to use, or how a model id is spelled. Keeping those
 * choices in one place is what makes the rest of the Kiro driver ordinary
 * ACP plumbing.
 *
 * Observed against kiro-cli 2.16.2:
 *   - `kiro-cli acp` speaks newline-delimited JSON-RPC on stdio.
 *   - `initialize` advertises `authMethods: []` and answers `authenticate`
 *     with `-32601`, so the auth step is skipped entirely.
 *   - Model ids keep their dots (`claude-haiku-4.5`) and are set with
 *     `session/set_model`; `session/set_config_option` is not implemented.
 *
 * @module provider/acp/KiroAcpSupport
 */
import { type KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_HOME_ENV = "KIRO_HOME";
const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

/** Kiro's own default model id, and the slug we fall back to. */
export const KIRO_DEFAULT_MODEL_ID = "auto";

/** Settings slice the ACP layer actually reads. */
export type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath" | "homePath" | "agent">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Environment every `kiro-cli` invocation for this instance runs with.
 *
 * `KIRO_HOME` scopes agents, settings, and session history, so two instances
 * can hold different agent sets. Note it does *not* scope credentials: Kiro
 * stores login state outside its home directory, so instances share one
 * account.
 */
export function buildKiroProcessEnvironment(
  kiroSettings: Pick<KiroAcpRuntimeSettings, "homePath"> | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const homePath = kiroSettings?.homePath?.trim();
  return {
    ...environment,
    ...(homePath ? { [KIRO_HOME_ENV]: homePath } : {}),
  };
}

/**
 * Launch arguments for `kiro-cli acp`.
 *
 * `--agent` is only passed when an instance names one; Kiro otherwise starts
 * its own default agent.
 */
export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const agent = kiroSettings?.agent?.trim();
  return {
    command: kiroSettings?.binaryPath?.trim() || "kiro-cli",
    args: ["acp", ...(agent ? (["--agent", agent] as const) : [])],
    cwd,
    env: buildKiroProcessEnvironment(kiroSettings, environment),
  };
}

/**
 * Auth method id to send during startup, or `undefined` to skip the call.
 *
 * Kiro authenticates out of band (`kiro-cli login`) and advertises no ACP
 * auth methods, so the usual answer is `undefined`. A future release that
 * starts advertising methods is honoured automatically — the first advertised
 * id wins — without another release of T3 Code.
 */
export function resolveKiroAuthMethodId(
  initializeResult: Pick<EffectAcpSchema.InitializeResponse, "authMethods"> | null | undefined,
): string | undefined {
  const methods = initializeResult?.authMethods;
  if (!methods || methods.length === 0) {
    return undefined;
  }
  return methods[0]?.id;
}

/**
 * Canonical Kiro model slug. Kiro's ids are the slugs T3 Code stores, so this
 * only expands the aliases in `MODEL_SLUG_ALIASES_BY_PROVIDER` and falls back
 * to Kiro's own default.
 */
export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  return normalizeModelSlug(model, KIRO_DRIVER_KIND) ?? KIRO_DEFAULT_MODEL_ID;
}

/** Model id Kiro reports for a freshly created or loaded session. */
export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Switch models only when the request differs from what the session already
 * runs, so an unchanged selection costs no round trip.
 */
export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = input.requestedModelId;
  if (requested === undefined || requested === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requested)
    .pipe(Effect.mapError(input.mapError), Effect.as(requested));
}

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
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
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
