/**
 * Auggie (Augment CLI) ACP glue.
 *
 * `auggie --acp` speaks plain ACP over stdio with no vendor extensions: no
 * `_meta` on `initialize`, no config options, no custom requests. That makes
 * this module thin compared to its Cursor and Grok siblings — it only has to
 * build the spawn line and translate T3's model sentinel.
 *
 * Two behaviors are worth knowing before changing anything here:
 *
 *   - Auggie answers `authenticate` with `{}` for any `methodId` and
 *     advertises `authMethods: []`. Sign-in happens out of band through
 *     `auggie login`, so the id below is only a label for request logs.
 *   - A new session asks for workspace-indexing consent through
 *     `session/request_permission` before the first prompt. `--allow-indexing`
 *     answers it at spawn; without the flag the request reaches the adapter
 *     and is surfaced as a normal approval.
 *
 * @module provider/acp/AuggieAcpSupport
 */
import { type AuggieSettings, AUGGIE_DEFAULT_MODEL } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const AUGGIE_DRIVER_KIND = ProviderDriverKind.make("auggie");
/**
 * Auggie ignores the method id and returns `{}`. The shared runtime always
 * sends `authenticate`, so this exists to keep request logs readable.
 */
const AUGGIE_AUTH_METHOD_ID = "auggie_login";

type AuggieAcpRuntimeAuggieSettings = Pick<AuggieSettings, "binaryPath" | "allowIndexing">;

export interface AuggieAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly auggieSettings: AuggieAcpRuntimeAuggieSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Auggie takes the workspace from `session/new`'s `cwd`, so the spawn line
 * carries no `--workspace-root`. Pinning one here would fight the per-session
 * cwd the adapter already passes.
 */
export function auggieAcpSpawnArgs(
  auggieSettings: AuggieAcpRuntimeAuggieSettings | null | undefined,
): ReadonlyArray<string> {
  return ["--acp", ...(auggieSettings?.allowIndexing === false ? [] : ["--allow-indexing"])];
}

export function buildAuggieAcpSpawnInput(
  auggieSettings: AuggieAcpRuntimeAuggieSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: auggieSettings?.binaryPath || "auggie",
    args: [...auggieAcpSpawnArgs(auggieSettings)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeAuggieAcpRuntime = (
  input: AuggieAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAuggieAcpSpawnInput(input.auggieSettings, input.cwd, input.environment),
        authMethodId: AUGGIE_AUTH_METHOD_ID,
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

/**
 * Auggie only advertises its catalog on `session/new` and `session/load`, so
 * a fresh install has nothing to show in the picker. This product slug stands
 * in for "whatever model the session already runs on" and is never sent over
 * the wire.
 */
export function resolveAuggieAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : AUGGIE_DEFAULT_MODEL;
  return normalizeModelSlug(base, AUGGIE_DRIVER_KIND) ?? AUGGIE_DEFAULT_MODEL;
}

export function currentAuggieModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Applies a picker selection to a live session. The sentinel and a selection
 * that already matches the session are both no-ops, so a resumed thread does
 * not issue a redundant `session/set_model` on every turn.
 */
export function applyAuggieAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId =
    input.requestedModelId === AUGGIE_DEFAULT_MODEL ? undefined : input.requestedModelId?.trim();
  if (
    requestedModelId === undefined ||
    requestedModelId.length === 0 ||
    requestedModelId === input.currentModelId
  ) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}
