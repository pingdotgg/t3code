import type { HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Auth method advertised by `hermes acp` for pre-configured runtime credentials. */
const HERMES_AUTH_METHOD_ID = "custom";

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_ID,
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

export interface HermesAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
}

type HermesAcpModelSelectionRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "setSessionModel"
>;

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Applies a model selection to a live Hermes ACP session. Hermes model ids
 * (e.g. `anthropic:claude-fable-5`) go to `session/set_model` verbatim —
 * there is no trait suffix to strip and no reasoning metadata to attach.
 * A selection matching the session's current model sends nothing: the
 * session is already there, and a redundant `session/set_model` risks a
 * rejection for ids the agent reports as current but does not advertise
 * as switchable.
 *
 * `session/set_config_option` is not usable here: the real `hermes acp`
 * binary treats configId `"model"` as a silent no-op (it always returns
 * `{ configOptions: [] }`, even for invalid values), so model changes must
 * go through the unstable `session/set_model` capability instead.
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: HermesAcpModelSelectionRuntime;
  readonly currentModelId: string | undefined;
  readonly model: string;
  readonly mapError: (context: HermesAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const requestedModelId = input.model.trim();
  if (requestedModelId.length === 0 || requestedModelId === input.currentModelId) {
    return Effect.void;
  }
  return input.runtime.setSessionModel(requestedModelId).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => input.mapError({ cause })),
  );
}
